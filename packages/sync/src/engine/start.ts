import { and, eq } from 'drizzle-orm';
import { PermanentError, SYNC_RESOURCES, type SyncResource } from '@erq/connectors';
import { storeConnections, syncCursors, syncRuns, type Tx } from '@erq/db';
import type { SyncMode } from '../ports';
import { nowOf, type SyncDeps } from './deps';

export interface EnqueueSyncArgs {
  orgId: string;
  connectionId: string;
  resources: SyncResource[] | 'all';
  mode: SyncMode;
  /** Required for backfill: how far back to import. */
  since?: Date;
}

/**
 * Starts (or finds) the run for one resource. Locks the cursor row, so only one run per connection and resource is active.
 */
export async function startRun(
  tx: Tx,
  args: {
    orgId: string;
    connectionId: string;
    resource: SyncResource;
    mode: SyncMode;
    since: Date | null;
    now: Date;
  },
): Promise<{ syncRunId: string; created: boolean }> {
  if (args.mode === 'backfill' && !args.since)
    throw new RangeError('a backfill needs a start date (since)');
  await tx
    .insert(syncCursors)
    .values({ orgId: args.orgId, storeConnectionId: args.connectionId, resource: args.resource })
    .onConflictDoNothing();
  const [cursor] = await tx
    .select()
    .from(syncCursors)
    .where(
      and(
        eq(syncCursors.storeConnectionId, args.connectionId),
        eq(syncCursors.resource, args.resource),
      ),
    )
    .for('update');
  if (!cursor) throw new PermanentError('sync cursor could not be created');
  if (cursor.status === 'running' && cursor.currentSyncRunId)
    return { syncRunId: cursor.currentSyncRunId, created: false };

  const [run] = await tx
    .insert(syncRuns)
    .values({
      orgId: args.orgId,
      connectionKind: 'store',
      connectionId: args.connectionId,
      type: args.mode,
      status: 'running',
      startedAt: args.now,
    })
    .returning({ id: syncRuns.id });
  await tx
    .update(syncCursors)
    .set({
      status: 'running',
      cursor: null,
      currentSyncRunId: run!.id,
      recordsProcessed: 0,
      lastError: null,
      backfillSince: args.mode === 'backfill' ? args.since : null,
    })
    .where(eq(syncCursors.id, cursor.id));
  return { syncRunId: run!.id, created: true };
}

/**
 * Starts a sync for a connection. With several resources, only the first starts now; the rest are chained in the job
 * and start when their predecessor finishes (locations, products, inventory, orders).
 */
export async function enqueueSync(
  deps: Pick<SyncDeps, 'db' | 'queue' | 'now'>,
  args: EnqueueSyncArgs,
): Promise<{ resource: SyncResource; syncRunId: string; started: boolean }> {
  const requested =
    args.resources === 'all'
      ? [...SYNC_RESOURCES]
      : SYNC_RESOURCES.filter((r) => (args.resources as SyncResource[]).includes(r));
  const [first, ...rest] = requested;
  if (!first) throw new RangeError('no resources to sync');
  if (args.mode === 'backfill' && !args.since)
    throw new RangeError('a backfill needs a start date (since)');
  const now = nowOf(deps);

  const started = await deps.db.withTenant(args.orgId, async (tx) => {
    const [connection] = await tx
      .select({ id: storeConnections.id })
      .from(storeConnections)
      .where(eq(storeConnections.id, args.connectionId));
    if (!connection) throw new PermanentError('store connection not found');
    return startRun(tx, {
      orgId: args.orgId,
      connectionId: args.connectionId,
      resource: first,
      mode: args.mode,
      since: args.since ?? null,
      now,
    });
  });
  // Enqueue only after the run is committed, so a worker never sees a job whose run does not exist yet.
  if (started.created) {
    await deps.queue.enqueue({
      orgId: args.orgId,
      connectionId: args.connectionId,
      resource: first,
      syncRunId: started.syncRunId,
      then:
        rest.length > 0
          ? { resources: rest, mode: args.mode, since: args.since?.toISOString() ?? null }
          : undefined,
    });
  }
  return { resource: first, syncRunId: started.syncRunId, started: started.created };
}
