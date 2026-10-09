import { eq } from 'drizzle-orm';
import { SYNC_RESOURCES, type SyncResource } from '@erq/connectors';
import { storeConnections, syncCursors, type TenantDb } from '@erq/db';
import { enqueueSync, type JobQueue } from '@erq/sync';

/** A burst of events becomes at most one sync per resource per minute... */
export const NUDGE_DEBOUNCE_MS = 60_000;
/** ... except inventory: its sync is a full pass over every level, and busy shops emit a constant stream of events. */
export const INVENTORY_NUDGE_DEBOUNCE_MS = 10 * 60_000;

export function nudgeDebounceMs(resource: SyncResource): number {
  return resource === 'inventory' ? INVENTORY_NUDGE_DEBOUNCE_MS : NUDGE_DEBOUNCE_MS;
}

const NUDGE_TOPICS: Readonly<Record<string, SyncResource>> = {
  'products/update': 'products',
  'inventory_levels/update': 'inventory',
};

/** The resource a webhook topic nudges, or null. Own keys only, so `toString` or `__proto__` never match. */
export function nudgeResourceFor(topic: string): SyncResource | null {
  return Object.hasOwn(NUDGE_TOPICS, topic) ? (NUDGE_TOPICS[topic] as SyncResource) : null;
}

export type NudgeResult = 'started' | 'dropped';

/**
 * Starts an incremental sync of one resource because Shopify said it changed. The webhook carries no data we
 * use: the sync re-reads from Shopify. The gate is a database check, not a queue job id: enqueueSync commits the
 * run BEFORE it enqueues, so a duplicate job id would drop the job and leave a committed run with no job.
 * Polling is the safety net, so every "dropped" costs a delay, never wrong data.
 */
export async function nudgeSync(
  deps: { db: TenantDb; queue: JobQueue; now: () => Date },
  args: { orgId: string; connectionId: string; resource: SyncResource },
): Promise<NudgeResult> {
  const now = deps.now();
  const go = await deps.db.withTenant(args.orgId, async (tx) => {
    const [connection] = await tx
      .select({ status: storeConnections.status })
      .from(storeConnections)
      .where(eq(storeConnections.id, args.connectionId));
    if (!connection || connection.status !== 'active') return false;
    const cursors = await tx
      .select({
        resource: syncCursors.resource,
        status: syncCursors.status,
        lastSyncedAt: syncCursors.lastSyncedAt,
        updatedAt: syncCursors.updatedAt,
      })
      .from(syncCursors)
      .where(eq(syncCursors.storeConnectionId, args.connectionId));
    if (cursors.some((c) => c.status === 'running')) return false;
    // The first import belongs to connect and Sync now, never to a nudge.
    const complete = SYNC_RESOURCES.every((r) =>
      cursors.some((c) => c.resource === r && c.lastSyncedAt !== null),
    );
    if (!complete) return false;
    const own = cursors.find((c) => c.resource === args.resource);
    if (!own || own.lastSyncedAt === null) return false;
    // A failed resource counts from its last attempt, so a flood of events cannot hammer it.
    const reference =
      own.status === 'failed'
        ? Math.max(own.lastSyncedAt.getTime(), own.updatedAt.getTime())
        : own.lastSyncedAt.getTime();
    return now.getTime() - reference >= nudgeDebounceMs(args.resource);
  });
  if (!go) return 'dropped';
  const started = await enqueueSync(
    { db: deps.db, queue: deps.queue, now: deps.now },
    {
      orgId: args.orgId,
      connectionId: args.connectionId,
      resources: [args.resource],
      mode: 'incremental', // inventory is already a full pass: the connector ignores the filter
    },
  );
  return started.started ? 'started' : 'dropped';
}
