import { sanitizeMessage } from '@erq/connectors';
import { webhookEvents, type ConnectionsApi, type TenantDb } from '@erq/db';
import { and, eq, notInArray, sql } from 'drizzle-orm';
import { MANDATORY_PRIVACY_TOPICS } from './alerts';
import { STALE_EVENT_MS } from './handler';
import type { WebhookEnqueuer } from './worker';

export interface SweepDeps {
  connections: ConnectionsApi;
  /** Counts the sweep retries of failed live-topic events. */
  db: TenantDb;
  enqueuer: WebhookEnqueuer;
  now?: () => Date;
  /** Receives a sanitized message per failed enqueue. */
  onError?: (message: string) => void;
}

/**
 * Re-enqueues events still `received` (the API's enqueue was lost) or stuck in `processing` (a worker crashed)
 * after the cutoff, failed privacy events (without limit) and failed live-topic events (`app/uninstalled`,
 * `products/update`, `inventory_levels/update`) while they have sweep retries left; each such retry is counted. Each sweep window uses its own job id, so a retained finished job never swallows the retry;
 * duplicate processing is safe because the handler claims the event atomically. Returns how many were enqueued.
 */
export async function sweepStaleWebhookEvents(
  deps: SweepDeps,
  opts: { olderThanMs?: number; limit?: number } = {},
): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const windowMs = opts.olderThanMs ?? STALE_EVENT_MS;
  const cutoff = new Date(now.getTime() - windowMs);
  const retryBucket = String(Math.floor(now.getTime() / windowMs));
  const stale = await deps.connections.listStaleWebhookEvents(cutoff, opts.limit ?? 200);
  let enqueued = 0;
  for (const job of stale) {
    try {
      // Every re-enqueue of a failed live-topic event spends one of its retries (the update also restarts the
      // 10 minute cool-down through the updated_at trigger). Received, processing and privacy events are untouched.
      await deps.db.withTenant(job.orgId, (tx) =>
        tx
          .update(webhookEvents)
          .set({ sweepRetries: sql`${webhookEvents.sweepRetries} + 1` })
          .where(
            and(
              eq(webhookEvents.orgId, job.orgId),
              eq(webhookEvents.id, job.eventId),
              eq(webhookEvents.status, 'failed'),
              notInArray(webhookEvents.topic, [...MANDATORY_PRIVACY_TOPICS]),
            ),
          ),
      );
      await deps.enqueuer.enqueue({ orgId: job.orgId, eventId: job.eventId }, { retryBucket });
      enqueued++;
    } catch (error) {
      deps.onError?.(sanitizeMessage(error));
    }
  }
  return enqueued;
}
