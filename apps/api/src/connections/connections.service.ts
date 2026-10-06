import { Inject, Injectable } from '@nestjs/common';
import { and, eq, lt } from 'drizzle-orm';
import {
  buildAuthorizeUrl,
  isValidShopDomain,
  normalizeShopInput,
  type ShopifyConfig,
} from '@erq/connectors';
import {
  generateOAuthNonce,
  hashOAuthNonce,
  insertAudit,
  oauthStates,
  storeConnections,
  type TenantDb,
} from '@erq/db';
import type { ConnectionDto, InstallResponse } from '@erq/shared';
import { ApiError } from '../common/api-error';
import { TENANT_DB } from '../db/db.module';
import { SHOPIFY_CONFIG } from './tokens';

@Injectable()
export class ConnectionsService {
  constructor(
    @Inject(TENANT_DB) private readonly db: TenantDb,
    @Inject(SHOPIFY_CONFIG) private readonly config: ShopifyConfig | null,
  ) {}

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
