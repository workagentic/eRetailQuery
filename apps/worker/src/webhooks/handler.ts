import { and, eq, or, sql } from 'drizzle-orm';
import { sanitizeMessage } from '@erq/connectors';
import {
  insertAudit,
  storeConnections,
  webhookEvents,
  type ConnectionsApi,
  type TenantDb,
  type Tx,
} from '@erq/db';
import type { WebhookJob } from '@erq/shared';

export type WebhookOutcome = 'processed' | 'deferred' | 'ignored' | 'skipped';

export interface WebhookHandlerDeps {
  db: TenantDb;
  connections: ConnectionsApi;
  now?: () => Date;
}

/** Order, product and stock topics are applied by the sync pipeline in 1b-3; until then they are parked. */
const DATA_TOPICS = new Set([
  'orders/create',
  'orders/updated',
  'orders/cancelled',
  'refunds/create',
  'products/create',
  'products/update',
  'products/delete',
  'inventory_levels/update',
]);
const PRIVACY_TOPICS = new Set(['customers/data_request', 'customers/redact']);
/** Age after which an unfinished event is retried: a `processing` claim is reclaimable and the sweep re-enqueues it. */
export const STALE_EVENT_MS = 10 * 60_000;

type EventStatus = 'processed' | 'deferred' | 'ignored' | 'failed';

async function setStatus(
  tx: Tx,
  orgId: string,
  id: string,
  status: EventStatus,
  now: Date,
  error: string | null = null,
): Promise<void> {
  await tx
    .update(webhookEvents)
    .set({
      status,
      error,
      updatedAt: now,
      ...(status === 'processed' ? { processedAt: now } : {}),
    })
    .where(and(eq(webhookEvents.orgId, orgId), eq(webhookEvents.id, id)));
}

/**
 * Processes one stored webhook event. Never logs or returns the payload.
 * The claim commits before the work so a shop/redact purge (which deletes the event row
 * through the cascade, on another connection) never waits on our own row lock.
 */
export async function processWebhookEvent(
  deps: WebhookHandlerDeps,
  job: WebhookJob,
): Promise<WebhookOutcome> {
  const now = deps.now ?? (() => new Date());
  const { orgId, eventId } = job;
  const claimedAt = now();
  const staleBefore = new Date(claimedAt.getTime() - STALE_EVENT_MS);

  const claimed = await deps.db.withTenant(orgId, async (tx) => {
    const rows = await tx
      .update(webhookEvents)
      .set({ status: 'processing', updatedAt: claimedAt })
      .where(
        and(
          eq(webhookEvents.orgId, orgId),
          eq(webhookEvents.id, eventId),
          or(
            sql`${webhookEvents.status} in ('received', 'failed')`,
            and(
              eq(webhookEvents.status, 'processing'),
              sql`${webhookEvents.updatedAt} < ${staleBefore.toISOString()}::timestamptz`,
            ),
          ),
        ),
      )
      .returning({
        topic: webhookEvents.topic,
        storeConnectionId: webhookEvents.storeConnectionId,
      });
    return rows[0];
  });
  if (!claimed) return 'skipped';

  const { topic, storeConnectionId } = claimed;
  try {
    if (topic === 'shop/redact') {
      // The event row goes away with the connection (cascade), so there is nothing to mark afterwards.
      await deps.connections.purgeStoreConnection(orgId, storeConnectionId);
      return 'processed';
    }
    return await deps.db.withTenant(orgId, async (tx) => {
      const at = now();
      if (topic === 'app/uninstalled') {
        const updated = await tx
          .update(storeConnections)
          .set({ status: 'disconnected', encryptedCredentials: null })
          .where(and(eq(storeConnections.orgId, orgId), eq(storeConnections.id, storeConnectionId)))
          .returning({ id: storeConnections.id });
        // A connection that is already gone needs no audit row.
        if (updated.length > 0) {
          await insertAudit(tx, {
            orgId,
            actorUserId: null,
            action: 'connection.uninstalled',
            entityType: 'store_connection',
            entityId: storeConnectionId,
          });
        }
        await setStatus(tx, orgId, eventId, 'processed', at);
        return 'processed' as const;
      }
      if (PRIVACY_TOPICS.has(topic)) {
        // We hold no customer PII in 1b-2, so recording the request is the whole action. Never store the payload.
        await insertAudit(tx, {
          orgId,
          actorUserId: null,
          action: 'privacy.request_recorded',
          entityType: 'webhook_event',
          entityId: eventId,
          after: { topic },
        });
        await setStatus(tx, orgId, eventId, 'processed', at);
        return 'processed' as const;
      }
      if (DATA_TOPICS.has(topic)) {
        await setStatus(tx, orgId, eventId, 'deferred', at);
        return 'deferred' as const;
      }
      await setStatus(tx, orgId, eventId, 'ignored', at);
      return 'ignored' as const;
    });
  } catch (error) {
    try {
      const message = sanitizeMessage(error);
      await deps.db.withTenant(orgId, (tx) =>
        setStatus(tx, orgId, eventId, 'failed', now(), message),
      );
    } catch {
      /* best effort: the original error must not be masked */
    }
    throw error;
  }
}
