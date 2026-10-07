import type { SyncResource } from '@erq/connectors';
import type { SyncDeps } from './deps';

/**
 * Re-enqueues runs whose cursor has not moved since `olderThan` (for example after a crash between commit and enqueue).
 * Resumed runs continue from the stored cursor. Note: the `then` chain of an `all` sync is not persisted, so after a
 * resume only the interrupted resource completes; trigger the sync again to run the remaining resources.
 */
export async function resumeStalledRuns(deps: SyncDeps, olderThan: Date): Promise<number> {
  const { rows } = await deps.db.pool.query<{
    o_org_id: string;
    o_store_connection_id: string;
    o_resource: SyncResource;
    o_sync_run_id: string;
  }>('select * from app_list_stalled_sync_cursors($1)', [olderThan]);
  for (const r of rows) {
    await deps.queue.enqueue({
      orgId: r.o_org_id,
      connectionId: r.o_store_connection_id,
      resource: r.o_resource,
      syncRunId: r.o_sync_run_id,
      resumed: true,
    });
  }
  return rows.length;
}
