import { sanitizeMessage } from '@erq/connectors';
import type { ConnectionsApi } from '@erq/db';
import { STALE_EVENT_MS } from './handler';
import type { WebhookEnqueuer } from './worker';

export interface SweepDeps {
  connections: ConnectionsApi;
  enqueuer: WebhookEnqueuer;
  now?: () => Date;
  /** Receives a sanitized message per failed enqueue. */
  onError?: (message: string) => void;
}

/**
 * Re-enqueues events still `received` (the API's enqueue was lost) or stuck in `processing` (a worker crashed)
 * after the cutoff. Each sweep window uses its own job id, so a retained finished job never swallows the retry;
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
      await deps.enqueuer.enqueue({ orgId: job.orgId, eventId: job.eventId }, { retryBucket });
      enqueued++;
    } catch (error) {
      deps.onError?.(sanitizeMessage(error));
    }
  }
  return enqueued;
}
