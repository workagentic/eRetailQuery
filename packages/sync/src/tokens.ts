import { and, eq, sql } from 'drizzle-orm';
import {
  AuthError,
  PermanentError,
  SHOPIFY_RECONNECT_MESSAGE,
  TransientError,
  credentialExpiry,
  credentialsFromGrant,
  decryptConnectionCredentials,
  encryptConnectionCredentials,
  readExpiringCredentials,
  type ExpiringCredentials,
  type ShopifyRefreshGrant,
} from '@erq/connectors';
import { storeConnections, type TenantDb } from '@erq/db';
import type { KeyProvider } from '@erq/shared';

/** An access token with this much life left (or less) is refreshed before the next request. */
export const REFRESH_WINDOW_MS = 5 * 60_000;
/** The scheduler refreshes idle shops whose refresh token has this much life left (or less). */
export const IDLE_REFRESH_WINDOW_MS = 14 * 24 * 60 * 60_000;
/** How long a refresh waits for the connection row lock before it gives up with a TransientError (retried). */
export const REFRESH_LOCK_TIMEOUT_MS = 5_000;
/** Upper bound for any single statement in the refresh transaction (it holds a pool connection and a row lock). */
const REFRESH_STATEMENT_TIMEOUT_MS = 30_000;

/** Postgres 55P03 = lock_not_available (lock_timeout expired); drizzle wraps the driver error in `cause`. */
function isLockTimeout(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '55P03' || e?.cause?.code === '55P03';
}

export type RefreshFn = (args: {
  shop: string;
  refreshToken: string;
}) => Promise<ShopifyRefreshGrant>;

export interface TokenService {
  /**
   * The credentials to hand the connector for the next request, refreshed first when they are about to
   * expire. An expiring Shopify set returns `{ accessToken }` only (the refresh token never leaves this
   * module); any other stored value is returned as decrypted; a connection without credentials gives null.
   */
  ensureFresh(args: { orgId: string; connectionId: string }): Promise<unknown>;
}

export interface TokenServiceDeps {
  db: Pick<TenantDb, 'withTenant'>;
  keyProvider: KeyProvider;
  /** Absent means "cannot refresh": an expiring token that needs it fails with a PermanentError. */
  refresh?: RefreshFn;
  now?: () => Date;
  /** Defaults to REFRESH_LOCK_TIMEOUT_MS; tests pass a small value. */
  lockTimeoutMs?: number;
}

const needsRefresh = (c: ExpiringCredentials, now: Date): boolean =>
  c.accessTokenExpiresAt.getTime() - now.getTime() <= REFRESH_WINDOW_MS;

/**
 * Rotation makes a refresh token single use, so two jobs must never refresh the same shop at once. The
 * refresh therefore runs inside one transaction that holds `SELECT ... FOR NO KEY UPDATE` on the connection row:
 * a second caller blocks, then re-reads the (already rotated) credentials and does not call Shopify. The new
 * pair is written in that same transaction. The lock is held across the Shopify call on purpose (bounded by
 * the HTTP client's 10 s timeout). It takes the connection row lock ONLY, never a cursor lock, so it cannot
 * invert the cursor-then-connection order used by the engine.
 * NO KEY UPDATE, not UPDATE: child tables (sync_cursors, sync_runs, ...) have foreign keys to this row, and
 * their inserts and updates take FOR KEY SHARE on it. FOR UPDATE conflicts with FOR KEY SHARE and would stall
 * (or deadlock with) page transactions for the whole HTTP call; FOR NO KEY UPDATE does not.
 * The transaction holds a pooled connection and the lock during the HTTP call, so it sets LOCAL timeouts: a
 * lock wait over `lockTimeoutMs` becomes a TransientError (the queue retries; nothing was changed), and no
 * statement runs longer than 30 s. A non-401 non-transient answer from Shopify (for example 400) is a
 * PermanentError: the run fails without marking the connection `error`, and the next poll tries again.
 * Residual risk: if Shopify answered but the commit then fails, the old token is dead and the new one is lost;
 * the next call gets a final 401 and the shop must be reconnected (docs/sync.md).
 */
export function createTokenService(deps: TokenServiceDeps): TokenService {
  const now = (): Date => (deps.now ?? (() => new Date()))();
  const read = (encrypted: string | null, connectionId: string): unknown =>
    decryptConnectionCredentials(encrypted, deps.keyProvider, connectionId);
  return {
    async ensureFresh({ orgId, connectionId }) {
      const first = await deps.db.withTenant(orgId, async (tx) => {
        const [row] = await tx
          .select({ encrypted: storeConnections.encryptedCredentials })
          .from(storeConnections)
          .where(eq(storeConnections.id, connectionId));
        return row ?? null;
      });
      if (!first) throw new PermanentError('store connection not found');
      const raw = read(first.encrypted, connectionId);
      const expiring = readExpiringCredentials(raw);
      if (!expiring) return raw;
      if (!needsRefresh(expiring, now())) return { accessToken: expiring.accessToken };

      return deps.db.withTenant(orgId, async (tx) => {
        // Integers only (never user input), so sql.raw is safe; SET LOCAL cannot take bind parameters.
        const lockMs = Math.max(1, Math.trunc(deps.lockTimeoutMs ?? REFRESH_LOCK_TIMEOUT_MS));
        await tx.execute(sql.raw(`set local lock_timeout = ${lockMs}`));
        await tx.execute(sql.raw(`set local statement_timeout = ${REFRESH_STATEMENT_TIMEOUT_MS}`));
        let row: { encrypted: string | null; shop: string } | undefined;
        try {
          [row] = await tx
            .select({
              encrypted: storeConnections.encryptedCredentials,
              shop: storeConnections.externalAccountId,
            })
            .from(storeConnections)
            .where(eq(storeConnections.id, connectionId))
            .for('no key update');
        } catch (error) {
          if (isLockTimeout(error)) throw new TransientError('Token refresh is busy, retrying');
          throw error;
        }
        if (!row) throw new PermanentError('store connection not found');
        // Re-read after the lock: another job may have rotated the pair while we waited.
        const locked = readExpiringCredentials(read(row.encrypted, connectionId));
        if (!locked)
          throw new AuthError('Stored credentials could not be read. Reconnect the store.');
        const at = now();
        if (!needsRefresh(locked, at)) return { accessToken: locked.accessToken };
        if (locked.refreshTokenExpiresAt.getTime() <= at.getTime()) {
          throw new AuthError(SHOPIFY_RECONNECT_MESSAGE);
        }
        if (!deps.refresh)
          throw new PermanentError('Token refresh is not configured on this server.');
        const grant = await deps.refresh({ shop: row.shop, refreshToken: locked.refreshToken });
        const next = credentialsFromGrant(grant, at);
        const expiry = credentialExpiry(next);
        try {
          await tx
            .update(storeConnections)
            .set({
              encryptedCredentials: encryptConnectionCredentials(
                next,
                deps.keyProvider,
                connectionId,
              ),
              accessTokenExpiresAt: expiry.accessTokenExpiresAt,
              refreshTokenExpiresAt: expiry.refreshTokenExpiresAt,
            })
            .where(and(eq(storeConnections.orgId, orgId), eq(storeConnections.id, connectionId)));
        } catch {
          // The driver's error text embeds the bound parameters (the new ciphertext), and this message ends up in
          // cursor last_error, sync_runs.error and logs. Throw fixed text with no cause. The transaction rolls back.
          throw new TransientError('Could not store refreshed credentials.');
        }
        return { accessToken: next.accessToken };
      });
    },
  };
}
