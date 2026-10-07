import { and, eq, inArray } from 'drizzle-orm';
import { sanitizeMessage } from '@erq/connectors';
import { storeConnections, syncCursors, syncRuns, type Tx } from '@erq/db';
import type { SyncPageJob } from '../ports';
import { nowOf, type SyncDeps } from './deps';

export const safeMessage = (error: unknown): string => sanitizeMessage(error, 500);

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
  if (opts.connectionError) {
    await tx
      .update(storeConnections)
      .set({ status: 'error', lastError: message })
      // A disconnected or demo connection must never become `error` (it would escape the active-shop unique index).
      .where(
        and(
          eq(storeConnections.id, job.connectionId),
          inArray(storeConnections.status, ['active', 'pending', 'error']),
        ),
      );
  }
}

/** Called by the worker after the last queue attempt. */
export async function failSyncRun(
  deps: SyncDeps,
  job: SyncPageJob,
  message: string,
): Promise<void> {
  await deps.db.withTenant(job.orgId, (tx) => failRun(tx, job, message.slice(0, 500), nowOf(deps)));
}
