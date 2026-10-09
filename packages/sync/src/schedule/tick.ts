import { AuthError, type SyncResource } from '@erq/connectors';
import { nowOf, type SyncDeps } from '../engine/deps';
import { markConnectionError, safeMessage } from '../engine/fail';
import { enqueueSync } from '../engine/start';
import { createTokenService } from '../tokens';
import { MAX_CONNECTIONS_PER_TICK } from './cadence';
import { dueResources, planChains, type CursorSnapshot } from './due';

export interface SchedulerDeps extends SyncDeps {
  /** Receives a sanitized message for every failure the tick survived (the worker logs it). */
  onError?: (message: string) => void;
}
export interface TickSummary {
  connections: number;
  enqueued: number;
  failed: number;
  refreshed: number;
}

interface DueRow {
  o_org_id: string;
  o_connection_id: string;
  o_resource: SyncResource;
  o_status: CursorSnapshot['status'];
  o_last_synced_at: Date | null;
  o_last_full_pass_at: Date | null;
  o_updated_at: Date;
}

/**
 * One scheduler tick: start what is due (at most MAX_CONNECTIONS_PER_TICK connections, oldest first) and renew
 * the tokens of idle shops. The duplicate-tick safety net is the cursor lock inside enqueueSync: a second tick
 * finds the cursors running and starts nothing. Never throws for one connection's failure.
 */
export async function runSchedulerTick(deps: SchedulerDeps): Promise<TickSummary> {
  const now = nowOf(deps);
  const summary: TickSummary = { connections: 0, enqueued: 0, failed: 0, refreshed: 0 };
  const report = (connectionId: string, err: unknown): void => {
    summary.failed += 1;
    deps.onError?.(`${connectionId}: ${safeMessage(err)}`);
  };

  const { rows } = await deps.db.pool.query<DueRow>(
    'select * from app_list_due_sync_resources($1, $2)',
    [now, MAX_CONNECTIONS_PER_TICK],
  );
  const groups = new Map<
    string,
    { orgId: string; connectionId: string; cursors: CursorSnapshot[] }
  >();
  for (const r of rows) {
    const group = groups.get(r.o_connection_id) ?? {
      orgId: r.o_org_id,
      connectionId: r.o_connection_id,
      cursors: [],
    };
    group.cursors.push({
      resource: r.o_resource,
      status: r.o_status,
      lastSyncedAt: r.o_last_synced_at,
      lastFullPassAt: r.o_last_full_pass_at,
      updatedAt: r.o_updated_at,
    });
    groups.set(r.o_connection_id, group);
  }
  for (const group of groups.values()) {
    if (summary.connections >= MAX_CONNECTIONS_PER_TICK) break; // the cap holds even if the function returned more
    const due = dueResources(group.cursors, now);
    if (due.length === 0) continue;
    summary.connections += 1;
    const plan = planChains(due);
    for (const [resources, mode] of [
      [plan.incremental, 'incremental'],
      [plan.full, 'full'],
    ] as const) {
      if (resources.length === 0) continue;
      try {
        const started = await enqueueSync(deps, {
          orgId: group.orgId,
          connectionId: group.connectionId,
          resources,
          mode,
        });
        if (started.started) summary.enqueued += 1;
      } catch (err) {
        report(group.connectionId, err);
      }
    }
  }

  const tokens =
    deps.tokens ??
    createTokenService({ db: deps.db, keyProvider: deps.keyProvider, now: deps.now });
  const idle = await deps.db.pool.query<{ o_org_id: string; o_connection_id: string }>(
    'select * from app_list_idle_refresh_connections($1, $2)',
    [now, MAX_CONNECTIONS_PER_TICK],
  );
  for (const r of idle.rows.slice(0, MAX_CONNECTIONS_PER_TICK)) {
    try {
      await tokens.ensureFresh({ orgId: r.o_org_id, connectionId: r.o_connection_id });
      summary.refreshed += 1;
    } catch (err) {
      if (err instanceof AuthError) {
        // Final: only a reconnect helps. The fixed text goes through safeMessage like every stored error.
        const message = safeMessage(err);
        try {
          await deps.db.withTenant(r.o_org_id, (tx) =>
            markConnectionError(tx, r.o_connection_id, message),
          );
        } catch (markErr) {
          report(r.o_connection_id, markErr);
          continue;
        }
      }
      report(r.o_connection_id, err);
    }
  }
  return summary;
}
