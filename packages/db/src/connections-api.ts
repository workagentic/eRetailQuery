import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

export const generateOAuthNonce = (): string => randomBytes(32).toString('base64url');
export const hashOAuthNonce = (nonce: string): string =>
  createHash('sha256').update(nonce).digest('hex');

export type StorePlatformName = 'shopify' | 'woocommerce' | 'amazon';
export type ConnectionStatusName = 'pending' | 'active' | 'error' | 'disconnected' | 'demo';

export interface ConnectionsApi {
  consumeOAuthState(
    nonceHash: string,
  ): Promise<{ orgId: string; userId: string; shop: string } | null>;
  findStoreConnection(
    platform: StorePlatformName,
    externalAccountId: string,
  ): Promise<{ orgId: string; connectionId: string; status: ConnectionStatusName } | null>;
  /** Events still `received` past the cutoff (never queued) or stuck in `processing` past it (worker crashed), oldest first. */
  listStaleWebhookEvents(
    olderThan: Date,
    limit: number,
  ): Promise<{ orgId: string; eventId: string }[]>;
  /** Used only by the worker's shop/redact handler. Never expose through a route. */
  purgeStoreConnection(orgId: string, connectionId: string): Promise<void>;
  /** Used only by the worker's shop/redact handler. Purges every disconnected or errored connection of the shop in every org; never an active one. Returns how many. */
  purgeShop(platform: StorePlatformName, externalAccountId: string): Promise<number>;
}

/** Wrappers for the SECURITY DEFINER functions that run before any org context exists. Never expose these through a route. */
export function createConnectionsApi(pool: Pool): ConnectionsApi {
  return {
    async consumeOAuthState(nonceHash) {
      const { rows } = await pool.query<{ o_org_id: string; o_user_id: string; o_shop: string }>(
        'select * from app_consume_oauth_state($1)',
        [nonceHash],
      );
      const r = rows[0];
      return r ? { orgId: r.o_org_id, userId: r.o_user_id, shop: r.o_shop } : null;
    },
    async findStoreConnection(platform, externalAccountId) {
      const { rows } = await pool.query<{
        o_org_id: string;
        o_connection_id: string;
        o_status: ConnectionStatusName;
      }>('select * from app_find_store_connection($1::store_platform, $2)', [
        platform,
        externalAccountId,
      ]);
      const r = rows[0];
      return r ? { orgId: r.o_org_id, connectionId: r.o_connection_id, status: r.o_status } : null;
    },
    async listStaleWebhookEvents(olderThan, limit) {
      const { rows } = await pool.query<{ o_org_id: string; o_event_id: string }>(
        'select * from app_list_stale_webhook_events($1, $2)',
        [olderThan, limit],
      );
      return rows.map((r) => ({ orgId: r.o_org_id, eventId: r.o_event_id }));
    },
    async purgeStoreConnection(orgId, connectionId) {
      await pool.query('select app_purge_store_connection($1, $2)', [orgId, connectionId]);
    },
    async purgeShop(platform, externalAccountId) {
      const { rows } = await pool.query<{ n: number }>(
        'select app_purge_shop($1::store_platform, $2) as n',
        [platform, externalAccountId],
      );
      return rows[0]?.n ?? 0;
    },
  };
}
