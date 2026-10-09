import { and, eq, inArray } from 'drizzle-orm';
import { sanitizeMessage } from '@erq/connectors';
import { storeConnections, syncCursors, syncRuns, type Tx } from '@erq/db';
import type { SyncPageJob } from '../ports';
import { nowOf, type SyncDeps } from './deps';

export const safeMessage = (error: unknown): string => sanitizeMessage(error, 500);

/**
 * Stored on an active connection when the first import could not be queued at connect time. The
 * real end of a later sync chain clears it (processSyncPage), so it never outlives a good import.
 */
export const IMPORT_NOT_STARTED_MESSAGE = 'Could not start the first import. Use Sync now.';

/** Stored on a connection whose webhook subscriptions were rejected (connect and the daily re-register); polling still covers it. */
export const WEBHOOK_SETUP_FAILED_MESSAGE = 'Webhook setup failed. Reconnect to retry.';

/** Flags a connection as errored. Only active, pending and error connections change: a disconnected or demo connection must never become `error` (it would escape the active-shop unique index). */
export async function markConnectionError(
  tx: Tx,
  connectionId: string,
  message: string,
): Promise<void> {
  await tx
    .update(storeConnections)
    .set({ status: 'error', lastError: message })
    .where(
      and(
        eq(storeConnections.id, connectionId),
        inArray(storeConnections.status, ['active', 'pending', 'error']),
      ),
    );
}

/** Marks the job's run and cursor failed (only if that run is still the current one). Optionally flags the connection. */
export async function failRun(
  tx: Tx,
  job: SyncPageJob,
  message: string,
  now: Date,
  opts: { connectionError?: boolean } = {},
): Promise<void> {
  await tx
    .update(syncCursors)
    .set({ status: 'failed', lastError: message })
    .where(
      and(
        eq(syncCursors.storeConnectionId, job.connectionId),
        eq(syncCursors.resource, job.resource),
        eq(syncCursors.currentSyncRunId, job.syncRunId),
      ),
    );
  await tx
    .update(syncRuns)
    .set({ status: 'failed', error: message, finishedAt: now })
    .where(and(eq(syncRuns.id, job.syncRunId), eq(syncRuns.status, 'running')));
  if (opts.connectionError) await markConnectionError(tx, job.connectionId, message);
}

/**
 * Called by the worker after the last queue attempt with the raw error text. The text is sanitized
 * here (tokens, secrets and query strings removed, capped at 500) because cursor `last_error` is
 * shown to every org member through GET /connections.
 */
export async function failSyncRun(
  deps: SyncDeps,
  job: SyncPageJob,
  message: string,
): Promise<void> {
  await deps.db.withTenant(job.orgId, (tx) => failRun(tx, job, safeMessage(message), nowOf(deps)));
}
