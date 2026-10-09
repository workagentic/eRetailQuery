import { and, eq, isNull } from 'drizzle-orm';
import { registerWebhooks, type HttpClient } from '@erq/connectors';
import { storeConnections, type TenantDb } from '@erq/db';
import { WEBHOOK_SETUP_FAILED_MESSAGE, type TokenService } from '@erq/sync';

export interface WebhookReconcilerDeps {
  db: TenantDb;
  tokens: TokenService;
  http: HttpClient;
  callbackUrl: string;
  apiVersion: string;
}

/**
 * Registers the subscribed topics for one active connection (idempotent: "already taken" counts as registered).
 * A rejected topic stores the existing connection warning, only when nothing else is stored, and the connection
 * keeps polling. A full success clears the warning only when it is exactly that text. Errors propagate to the
 * ticker, which reports them (sanitized) without stopping the tick.
 */
export function createWebhookReconciler(
  deps: WebhookReconcilerDeps,
): (args: { orgId: string; connectionId: string }) => Promise<void> {
  return async ({ orgId, connectionId }) => {
    const connection = await deps.db.withTenant(orgId, async (tx) => {
      const [row] = await tx
        .select({ shop: storeConnections.externalAccountId, status: storeConnections.status })
        .from(storeConnections)
        .where(eq(storeConnections.id, connectionId));
      return row ?? null;
    });
    if (!connection || connection.status !== 'active') return;
    const credentials = (await deps.tokens.ensureFresh({ orgId, connectionId })) as {
      accessToken?: unknown;
    } | null;
    if (!credentials || typeof credentials.accessToken !== 'string') return;
    const result = await registerWebhooks(deps.http, {
      shop: connection.shop,
      accessToken: credentials.accessToken,
      callbackUrl: deps.callbackUrl,
      apiVersion: deps.apiVersion,
    });
    await deps.db.withTenant(orgId, async (tx) => {
      if (result.failed.length > 0) {
        await tx
          .update(storeConnections)
          .set({ lastError: WEBHOOK_SETUP_FAILED_MESSAGE })
          .where(and(eq(storeConnections.id, connectionId), isNull(storeConnections.lastError)));
      } else {
        await tx
          .update(storeConnections)
          .set({ lastError: null })
          .where(
            and(
              eq(storeConnections.id, connectionId),
              eq(storeConnections.lastError, WEBHOOK_SETUP_FAILED_MESSAGE),
            ),
          );
      }
    });
  };
}
