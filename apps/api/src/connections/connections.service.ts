import { Inject, Injectable } from '@nestjs/common';
import { and, eq, lt } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  buildAuthorizeUrl,
  encryptConnectionCredentials,
  exchangeCodeForToken,
  isValidShopDomain,
  normalizeShopInput,
  registerWebhooks,
  sanitizeMessage,
  verifyOAuthQuery,
  type HttpClient,
  type ShopifyConfig,
} from '@erq/connectors';
import {
  type ConnectionsApi,
  generateOAuthNonce,
  hashOAuthNonce,
  insertAudit,
  oauthStates,
  storeConnections,
  type TenantDb,
} from '@erq/db';
import type { ConnectionDto, InstallResponse, KeyProvider, ShopifyErrorCode } from '@erq/shared';
import { ApiError } from '../common/api-error';
import { APP_CONFIG, LOGGER } from '../config/config.module';
import type { Env } from '../config/env';
import { TENANT_DB } from '../db/db.module';
import { CONNECTIONS_API, HTTP_CLIENT, KEY_PROVIDER, SHOPIFY_CONFIG } from './tokens';

@Injectable()
export class ConnectionsService {
  constructor(
    @Inject(TENANT_DB) private readonly db: TenantDb,
    @Inject(SHOPIFY_CONFIG) private readonly config: ShopifyConfig | null,
    @Inject(CONNECTIONS_API) private readonly api: ConnectionsApi,
    @Inject(HTTP_CLIENT) private readonly http: HttpClient,
    @Inject(KEY_PROVIDER) private readonly keyProvider: KeyProvider | null,
    @Inject(APP_CONFIG) private readonly env: Env,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  private redirect(params: Record<string, string>): string {
    const base = this.env.WEB_PUBLIC_URL.replace(/\/+$/, '');
    return `${base}/connections?${new URLSearchParams(params).toString()}`;
  }

  private fail(code: ShopifyErrorCode): string {
    return this.redirect({ shopify_error: code });
  }

  /**
   * Public OAuth callback. Authorized only by Shopify's query HMAC plus the single-use state.
   * Always returns a redirect URL and never throws. Never log the query, code, state or token.
   */
  async completeInstall(query: Record<string, string | string[] | undefined>): Promise<string> {
    try {
      const cfg = this.config;
      const keyProvider = this.keyProvider;
      if (!cfg || !keyProvider) return this.fail('not_configured');
      const { code, shop, state } = query;
      if (
        !verifyOAuthQuery(query, cfg.apiSecret) ||
        typeof code !== 'string' ||
        typeof shop !== 'string' ||
        typeof state !== 'string' ||
        !code ||
        !state
      ) {
        return this.fail('invalid_request');
      }
      if (!isValidShopDomain(shop)) return this.fail('invalid_request');
      const consumed = await this.api.consumeOAuthState(hashOAuthNonce(state));
      if (!consumed) return this.fail('state_expired');
      if (consumed.shop !== shop) return this.fail('shop_mismatch');
      const existing = await this.api.findStoreConnection('shopify', shop);
      if (existing && existing.orgId !== consumed.orgId && existing.status !== 'disconnected') {
        return this.fail('shop_in_use');
      }
      let token: { accessToken: string; scopes: string[] };
      try {
        token = await exchangeCodeForToken(this.http, {
          shop,
          apiKey: cfg.apiKey,
          apiSecret: cfg.apiSecret,
          code,
        });
      } catch {
        return this.fail('exchange_failed');
      }
      const { orgId, userId } = consumed;
      const connectionId = await this.db.withTenant(orgId, async (tx) => {
        const [row] = await tx
          .insert(storeConnections)
          .values({
            orgId,
            platform: 'shopify',
            externalAccountId: shop,
            status: 'active',
            scopes: token.scopes,
            lastError: null,
          })
          .onConflictDoUpdate({
            target: [
              storeConnections.orgId,
              storeConnections.platform,
              storeConnections.externalAccountId,
            ],
            set: { status: 'active', scopes: token.scopes, lastError: null, updatedAt: new Date() },
          })
          .returning({ id: storeConnections.id });
        if (!row) throw new Error('connection upsert returned no row');
        await tx
          .update(storeConnections)
          .set({
            encryptedCredentials: encryptConnectionCredentials(
              { accessToken: token.accessToken },
              keyProvider,
              row.id,
            ),
          })
          .where(and(eq(storeConnections.orgId, orgId), eq(storeConnections.id, row.id)));
        await insertAudit(tx, {
          orgId,
          actorUserId: userId,
          action: 'connection.connected',
          entityType: 'store_connection',
          entityId: row.id,
          after: { platform: 'shopify', shop },
        });
        return row.id;
      });
      // Network calls happen outside the transaction.
      let webhooksOk = false;
      try {
        const result = await registerWebhooks(this.http, {
          shop,
          accessToken: token.accessToken,
          callbackUrl: cfg.webhookUrl,
          apiVersion: cfg.apiVersion,
        });
        webhooksOk = result.failed.length === 0;
      } catch (err) {
        this.logger.warn(
          { err: sanitizeMessage(err) },
          'shopify webhook registration threw during connect',
        );
      }
      if (webhooksOk) return this.redirect({ shopify: 'connected' });
      await this.db.withTenant(orgId, (tx) =>
        tx
          .update(storeConnections)
          .set({ lastError: 'Webhook setup failed. Reconnect to retry.' })
          .where(and(eq(storeConnections.orgId, orgId), eq(storeConnections.id, connectionId))),
      );
      return this.redirect({ shopify: 'connected', warning: 'webhooks' });
    } catch (err) {
      this.logger.error({ err: sanitizeMessage(err) }, 'shopify callback failed');
      return this.fail('server_error');
    }
  }

  private requireConfig(): ShopifyConfig {
    if (!this.config) {
      throw new ApiError(503, 'shopify_not_configured', 'Shopify is not configured on this server');
    }
    return this.config;
  }

  async startInstall(orgId: string, userId: string, input: string): Promise<InstallResponse> {
    const cfg = this.requireConfig();
    const shop = normalizeShopInput(input);
    if (!isValidShopDomain(shop)) {
      throw new ApiError(
        400,
        'invalid_shop',
        'Enter your store address like my-store.myshopify.com',
      );
    }
    const nonce = generateOAuthNonce();
    await this.db.withTenant(orgId, async (tx) => {
      await tx.delete(oauthStates).where(lt(oauthStates.expiresAt, new Date())); // lazy cleanup, no scheduler needed
      await tx.insert(oauthStates).values({
        orgId,
        userId,
        platform: 'shopify',
        shop,
        nonceHash: hashOAuthNonce(nonce),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      });
    });
    return {
      authorizeUrl: buildAuthorizeUrl({
        shop,
        apiKey: cfg.apiKey,
        scopes: cfg.scopes,
        redirectUri: cfg.redirectUri,
        state: nonce,
      }),
    };
  }

  list(orgId: string): Promise<ConnectionDto[]> {
    return this.db.withTenant(orgId, async (tx) => {
      const rows = await tx.select().from(storeConnections).orderBy(storeConnections.createdAt);
      return rows.map((r) => ({
        id: r.id,
        platform: r.platform,
        shop: r.externalAccountId,
        status: r.status,
        lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
        lastError: r.lastError,
      }));
    });
  }

  async disconnect(orgId: string, userId: string, id: string): Promise<void> {
    await this.db.withTenant(orgId, async (tx) => {
      const rows = await tx
        .update(storeConnections)
        .set({ status: 'disconnected', encryptedCredentials: null })
        .where(and(eq(storeConnections.orgId, orgId), eq(storeConnections.id, id)))
        .returning({ id: storeConnections.id });
      if (rows.length === 0) {
        throw new ApiError(404, 'connection_not_found', 'Connection not found');
      }
      await insertAudit(tx, {
        orgId,
        actorUserId: userId,
        action: 'connection.disconnected',
        entityType: 'store_connection',
        entityId: id,
      });
    });
  }
}
