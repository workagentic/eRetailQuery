import { Inject, Injectable } from '@nestjs/common';
import { and, eq, lt } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  buildAuthorizeUrl,
  encryptConnectionCredentials,
  exchangeCodeForToken,
  isValidShopDomain,
  normalizeShopInput,
  parseWebhookHeaders,
  registerWebhooks,
  sanitizeMessage,
  verifyOAuthRawQuery,
  verifyWebhookSignature,
  type HttpClient,
  type ShopifyConfig,
} from '@erq/connectors';
import {
  type ConnectionsApi,
  generateOAuthNonce,
  hashOAuthNonce,
  insertAudit,
  oauthStates,
  orgMembers,
  storeConnections,
  webhookEvents,
  type TenantDb,
} from '@erq/db';
import {
  hasRole,
  type ConnectionDto,
  type InstallResponse,
  type KeyProvider,
  type ShopifyErrorCode,
} from '@erq/shared';
import { ApiError } from '../common/api-error';
import { APP_CONFIG, LOGGER } from '../config/config.module';
import type { Env } from '../config/env';
import { TENANT_DB } from '../db/db.module';
import {
  CONNECTIONS_API,
  HTTP_CLIENT,
  KEY_PROVIDER,
  SHOPIFY_CONFIG,
  WEBHOOK_QUEUE_PORT,
} from './tokens';
import { SyncStarter } from './sync-starter';
import type { WebhookQueue } from './webhook-queue';

/** How long the webhook receiver waits for the queue before answering anyway (the worker sweep recovers). */
export const WEBHOOK_ENQUEUE_TIMEOUT_MS = 2000;

const ACTIVE_SHOP_INDEX = 'store_connections_active_shop_uq';

/** True for a Postgres unique violation on the one-active-org-per-shop index (raw or wrapped by Drizzle). */
function isActiveShopConflict(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 3; depth++) {
    const { code, constraint } = e as { code?: unknown; constraint?: unknown };
    if (code === '23505' && constraint === ACTIVE_SHOP_INDEX) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

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
    @Inject(WEBHOOK_QUEUE_PORT) private readonly webhookQueue: WebhookQueue,
    private readonly syncStarter: SyncStarter,
  ) {}

  private redirect(params: Record<string, string>): string {
    const base = this.env.WEB_PUBLIC_URL.replace(/\/+$/, '');
    return `${base}/connections?${new URLSearchParams(params).toString()}`;
  }

  private fail(code: ShopifyErrorCode): string {
    return this.redirect({ shopify_error: code });
  }

  /**
   * Authenticated OAuth callback. The caller must be the user who started the install (the single-use state
   * names them) and still an owner or admin of the state's org; the org never comes from the session.
   * Always returns a redirect URL and never throws. Never log the query, code, state or token.
   */
  async completeInstall(userId: string, rawQuery: string): Promise<string> {
    try {
      const cfg = this.config;
      const keyProvider = this.keyProvider;
      if (!cfg || !keyProvider) return this.fail('not_configured');
      if (!verifyOAuthRawQuery(rawQuery, cfg.apiSecret)) return this.fail('invalid_request');
      const params = new URLSearchParams(rawQuery);
      const code = params.get('code');
      const shop = params.get('shop');
      const state = params.get('state');
      if (!code || !shop || !state) return this.fail('invalid_request');
      if (!isValidShopDomain(shop)) return this.fail('invalid_request');
      // From here on the state is burned, whatever the outcome.
      const consumed = await this.api.consumeOAuthState(hashOAuthNonce(state));
      if (!consumed) return this.fail('state_expired');
      if (consumed.userId !== userId) return this.fail('wrong_account');
      const role = await this.db.withTenant(consumed.orgId, async (tx) => {
        const rows = await tx
          .select({ role: orgMembers.role })
          .from(orgMembers)
          .where(and(eq(orgMembers.orgId, consumed.orgId), eq(orgMembers.userId, userId)));
        return rows[0]?.role;
      });
      if (!role || !hasRole(role, 'admin')) return this.fail('not_allowed');
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
      const { orgId } = consumed;
      let connectionId: string;
      try {
        connectionId = await this.db.withTenant(orgId, async (tx) => {
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
              set: {
                status: 'active',
                scopes: token.scopes,
                lastError: null,
                updatedAt: new Date(),
              },
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
            actorUserId: consumed.userId,
            action: 'connection.connected',
            entityType: 'store_connection',
            entityId: row.id,
            after: { platform: 'shopify', shop },
          });
          return row.id;
        });
      } catch (err) {
        // The partial unique index is the authority when two orgs race for the same shop.
        if (isActiveShopConflict(err)) return this.fail('shop_in_use');
        throw err;
      }
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
      // Best effort: a queue failure never breaks the connect. The stored (granted) scopes size the window.
      let importFailed = false;
      try {
        await this.syncStarter.start({ orgId, connectionId, scopes: token.scopes });
      } catch (err) {
        importFailed = true;
        this.logger.warn({ err: sanitizeMessage(err) }, 'shopify first import could not start');
      }
      if (webhooksOk && !importFailed) return this.redirect({ shopify: 'connected' });
      const lastError = importFailed
        ? 'Could not start the first import. Use Sync now.'
        : 'Webhook setup failed. Reconnect to retry.';
      await this.db.withTenant(orgId, (tx) =>
        tx
          .update(storeConnections)
          .set({ lastError })
          .where(and(eq(storeConnections.orgId, orgId), eq(storeConnections.id, connectionId))),
      );
      return webhooksOk
        ? this.redirect({ shopify: 'connected' })
        : this.redirect({ shopify: 'connected', warning: 'webhooks' });
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
    // Without a key the callback cannot store the token: refuse before the merchant consents on Shopify.
    if (!this.keyProvider) {
      throw new ApiError(503, 'shopify_not_configured', 'Shopify is not configured on this server');
    }
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
      const rows = await tx
        .select()
        .from(storeConnections)
        .orderBy(storeConnections.createdAt, storeConnections.id);
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

  /**
   * Public webhook receiver. Authorized only by the HMAC over the raw body bytes.
   * The body is parsed only to reject non-JSON and is then discarded: it is never persisted
   * (the stored payload is always `{}`) and the worker fetches any data it needs from Shopify.
   * Never log the payload, body or signature header.
   */
  async receiveWebhook(
    rawBody: Buffer | undefined,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<'stored' | 'duplicate' | 'unknown_shop'> {
    const cfg = this.requireConfig();
    const invalid = () => new ApiError(401, 'invalid_signature', 'Invalid signature');
    if (!rawBody) throw invalid();
    const sig = headers['x-shopify-hmac-sha256'];
    if (typeof sig !== 'string' || !verifyWebhookSignature(rawBody, sig, cfg.apiSecret)) {
      throw invalid();
    }
    const parsed = parseWebhookHeaders(headers);
    if (!parsed) throw invalid();
    try {
      JSON.parse(rawBody.toString('utf8')); // validity check only; nothing from the body is retained
    } catch {
      throw new ApiError(400, 'invalid_payload', 'Webhook body is not valid JSON');
    }
    const conn = await this.api.findStoreConnection('shopify', parsed.shop);
    if (!conn) {
      this.logger.info(
        { shop: parsed.shop, topic: parsed.topic },
        'shopify webhook for unknown shop',
      );
      return 'unknown_shop';
    }
    const { orgId } = conn;
    const inserted = await this.db.withTenant(orgId, (tx) =>
      tx
        .insert(webhookEvents)
        .values({
          orgId,
          storeConnectionId: conn.connectionId,
          topic: parsed.topic,
          externalEventId: parsed.webhookId,
          payload: {},
        })
        .onConflictDoNothing({
          target: [
            webhookEvents.orgId,
            webhookEvents.storeConnectionId,
            webhookEvents.externalEventId,
          ],
        })
        .returning({ id: webhookEvents.id }),
    );
    const row = inserted[0];
    if (!row) return 'duplicate';
    // Shopify waits about 5s for the ack; a slow or unreachable Redis must not hold the answer.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.webhookQueue.enqueue({ orgId, eventId: row.id }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('webhook enqueue timed out')),
            WEBHOOK_ENQUEUE_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (err) {
      // The row stays 'received'; the worker sweep picks it up.
      this.logger.warn({ err: sanitizeMessage(err), eventId: row.id }, 'webhook enqueue failed');
    } finally {
      clearTimeout(timer);
    }
    return 'stored';
  }
}
