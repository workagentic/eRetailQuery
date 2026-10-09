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
import type { JobQueue } from '@erq/sync';
import { nudgeResourceFor, nudgeSync } from './nudge';

export type WebhookOutcome = 'processed' | 'deferred' | 'ignored' | 'skipped';

export interface WebhookHandlerDeps {
  db: TenantDb;
  connections: ConnectionsApi;
  now?: () => Date;
  /** The sync queue for nudges. Without it a nudge topic (`products/update`, `inventory_levels/update`) ends `ignored`. */
  sync?: { queue: JobQueue };
}

/**
 * Order, refund and other product topics are not subscribed (order and refund payloads carry customer data); if
 * one arrives anyway it is parked as `deferred` with its payload replaced by `{}`. `products/update` and
 * `inventory_levels/update` are subscribed and only nudge a sync (see ./nudge).
 */
const DATA_TOPICS = new Set([
  'orders/create',
  'orders/updated',
  'orders/cancelled',
  'refunds/create',
  'products/create',
  'products/delete',
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
  scrub = false,
): Promise<void> {
  await tx
    .update(webhookEvents)
    .set({
      status,
      error,
      updatedAt: now,
      ...(status === 'processed' ? { processedAt: now } : {}),
      // Nothing is retained from a parked data-topic or nudge event: its payload can carry tenant data.
      ...(status === 'deferred' || scrub ? { payload: {} } : {}),
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
      const conn = await deps.db.withTenant(orgId, async (tx) => {
        const rows = await tx
          .select({
            shop: storeConnections.externalAccountId,
            platform: storeConnections.platform,
          })
          .from(storeConnections)
          .where(
            and(eq(storeConnections.orgId, orgId), eq(storeConnections.id, storeConnectionId)),
          );
        return rows[0];
      });
      if (!conn) {
        // The connection is gone, so normally the event is too; close it if it somehow survived.
        await deps.db.withTenant(orgId, (tx) => setStatus(tx, orgId, eventId, 'processed', now()));
        return 'processed';
      }
      // Purges every disconnected/errored connection of the shop in every org; an active reinstall is untouched.
      const purged = await deps.connections.purgeShop(conn.platform, conn.shop);
      // The cascade removed this event when its own connection was purged; if it was not (an active reinstall owns
      // the shop), close the event normally. The update simply matches zero rows otherwise.
      await deps.db.withTenant(orgId, async (tx) => {
        const survivor = await tx
          .select({ id: storeConnections.id })
          .from(storeConnections)
          .where(
            and(eq(storeConnections.orgId, orgId), eq(storeConnections.id, storeConnectionId)),
          );
        // A mandatory erasure request that left the event's own connection in place (for example an active one whose
        // app/uninstalled retries ran out) must not close without a trace: it needs manual follow-up.
        if (purged === 0 || survivor.length > 0) {
          await insertAudit(tx, {
            orgId,
            actorUserId: null,
            action: 'privacy.shop_redact_skipped',
            entityType: 'store_connection',
            entityId: storeConnectionId,
            after: { topic: 'shop/redact', purged },
          });
        }
        await setStatus(tx, orgId, eventId, 'processed', now());
      });
      return 'processed';
    }
    const nudgeResource = nudgeResourceFor(topic);
    if (nudgeResource !== null) {
      // A product edit or a stock change only starts a sync; nothing from the payload is used or kept.
      if (!deps.sync) {
        await deps.db.withTenant(orgId, (tx) =>
          setStatus(tx, orgId, eventId, 'ignored', now(), null, true),
        );
        return 'ignored';
      }
      await nudgeSync(
        { db: deps.db, queue: deps.sync.queue, now },
        { orgId, connectionId: storeConnectionId, resource: nudgeResource },
      );
      await deps.db.withTenant(orgId, (tx) =>
        setStatus(tx, orgId, eventId, 'processed', now(), null, true),
      );
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
