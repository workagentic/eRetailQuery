import { sanitizeMessage } from '@erq/connectors';
import type { ConnectionsApi } from '@erq/db';
import type { WebhookEnqueuer } from './worker';

export interface SweepDeps {
  connections: ConnectionsApi;
  enqueuer: WebhookEnqueuer;
  now?: () => Date;
  /** Receives a sanitized message per failed enqueue. */
  onError?: (message: string) => void;
}

/** Re-enqueues events still `received` after the cutoff (the API's enqueue was lost). Returns how many were enqueued. */
export async function sweepStaleWebhookEvents(
  deps: SweepDeps,
  opts: { olderThanMs?: number; limit?: number } = {},
): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - (opts.olderThanMs ?? 10 * 60_000));
  const stale = await deps.connections.listStaleWebhookEvents(cutoff, opts.limit ?? 200);
  let enqueued = 0;
  for (const job of stale) {
    try {
      await deps.enqueuer.enqueue({ orgId: job.orgId, eventId: job.eventId });
      enqueued++;
    } catch (error) {
      deps.onError?.(sanitizeMessage(error));
    }
  }
  return enqueued;
}
