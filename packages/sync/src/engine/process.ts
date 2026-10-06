import { and, eq, sql } from 'drizzle-orm';
import {
  AuthError,
  PermanentError,
  RateLimitedError,
  decryptConnectionCredentials,
  type NormalizedInventoryLevel,
  type NormalizedLocation,
  type NormalizedOrder,
  type NormalizedProduct,
  type Page,
  type SyncResource,
} from '@erq/connectors';
import { orgs, storeConnections, syncCursors, syncRuns, type Tx } from '@erq/db';
import { toOrgDate } from '../cogs';
import type { PageResult, SyncPageJob } from '../ports';
import { policyFor } from '../policies';
import type { SinkContext, SinkResult } from '../sinks/context';
import { upsertInventory } from '../sinks/inventory';
import { upsertLocations } from '../sinks/locations';
import { upsertOrders } from '../sinks/orders';
import { upsertProducts } from '../sinks/products';
import { nowOf, type SyncDeps } from './deps';
import { failRun, safeMessage } from './fail';
import { startRun } from './start';

function applyPage(
  tx: Tx,
  ctx: SinkContext,
  resource: SyncResource,
  items: unknown[],
): Promise<SinkResult> {
  switch (resource) {
    case 'locations':
      return upsertLocations(tx, ctx, items as NormalizedLocation[]);
    case 'products':
      return upsertProducts(tx, ctx, items as NormalizedProduct[]);
    case 'inventory':
      return upsertInventory(tx, ctx, items as NormalizedInventoryLevel[]);
    case 'orders':
      return upsertOrders(tx, ctx, items as NormalizedOrder[]);
  }
}

/** Constraint (23xxx) and data (22xxx) errors cannot be fixed by retrying. */
function isDataError(error: unknown): boolean {
  const code =
    (error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code;
  return typeof code === 'string' && (code.startsWith('23') || code.startsWith('22'));
}

/**
 * Processes one page of one resource. The page data and the cursor commit in one transaction, guarded by a
 * compare-and-set on the locked cursor row, so a duplicated or stale job never applies a page twice or moves the
 * cursor backwards. The caller enqueues the returned next job only after this returns (after commit).
 */
export async function processSyncPage(deps: SyncDeps, job: SyncPageJob): Promise<PageResult> {
  const now = nowOf(deps);
  const loaded = await deps.db.withTenant(job.orgId, async (tx) => {
    const [connection] = await tx
      .select({
        id: storeConnections.id,
        platform: storeConnections.platform,
        externalAccountId: storeConnections.externalAccountId,
        encryptedCredentials: storeConnections.encryptedCredentials,
      })
      .from(storeConnections)
      .where(eq(storeConnections.id, job.connectionId));
    if (!connection) return null;
    const [cursor] = await tx
      .select()
      .from(syncCursors)
      .where(
        and(
          eq(syncCursors.storeConnectionId, job.connectionId),
          eq(syncCursors.resource, job.resource),
        ),
      );
    const [org] = await tx
      .select({ timezone: orgs.timezone })
      .from(orgs)
      .where(eq(orgs.id, job.orgId));
    const [run] = await tx
      .select({ startedAt: syncRuns.startedAt })
      .from(syncRuns)
      .where(eq(syncRuns.id, job.syncRunId));
    return {
      connection,
      cursor,
      timezone: org?.timezone ?? 'UTC',
      runStartedAt: run?.startedAt ?? now,
    };
  });
  if (
    !loaded ||
    !loaded.cursor ||
    loaded.cursor.status !== 'running' ||
    loaded.cursor.currentSyncRunId !== job.syncRunId
  ) {
    return { kind: 'done' }; // stale job: nothing to do
  }
  const { connection, cursor, timezone, runStartedAt } = loaded;

  const policy = policyFor(connection.platform, deps.policies);
  const decision = await deps.limiter.take(
    `${connection.platform}:${connection.id}`,
    policy.costPerPage,
    policy,
  );
  if (!decision.allowed) return { kind: 'delayed', delayMs: decision.retryAfterMs };

  let page: Page<unknown>;
  try {
    const connector = deps.connectors.get(connection.platform);
    const credentials = decryptConnectionCredentials(
      connection.encryptedCredentials,
      deps.keyProvider,
      connection.id,
    );
    page = await connector.fetchPage(
      { connectionId: connection.id, externalAccountId: connection.externalAccountId, credentials },
      job.resource,
      cursor.cursor,
      { since: cursor.backfillSince ?? undefined, updatedSince: cursor.updatedSince ?? undefined },
    );
  } catch (error) {
    if (error instanceof RateLimitedError) return { kind: 'delayed', delayMs: error.retryAfterMs };
    if (error instanceof AuthError || error instanceof PermanentError) {
      const message = safeMessage(error);
      await deps.db.withTenant(job.orgId, (tx) =>
        failRun(tx, job, message, now, { connectionError: error instanceof AuthError }),
      );
      return { kind: 'failed', reason: message };
    }
    throw error; // transient or unknown: the queue retries with backoff
  }

  const sinkCtx: SinkContext = {
    orgId: job.orgId,
    connectionId: job.connectionId,
    syncRunId: job.syncRunId,
    timezone,
    now,
    costEffectiveFrom: toOrgDate(cursor.backfillSince ?? now, timezone),
  };

  try {
    return await deps.db.withTenant(job.orgId, async (tx): Promise<PageResult> => {
      // Compare-and-set: if another worker already advanced this cursor, this page is stale.
      const [fresh] = await tx
        .select()
        .from(syncCursors)
        .where(eq(syncCursors.id, cursor.id))
        .for('update');
      if (
        !fresh ||
        fresh.status !== 'running' ||
        fresh.currentSyncRunId !== job.syncRunId ||
        fresh.cursor !== cursor.cursor
      ) {
        return { kind: 'done' };
      }
      const result = await applyPage(tx, sinkCtx, job.resource, page.items);
      const done = page.nextCursor === null;
      await tx
        .update(syncRuns)
        .set({
          recordsProcessed: sql`${syncRuns.recordsProcessed} + ${result.processed}`,
          ...(done ? { status: 'succeeded' as const, finishedAt: now } : {}),
        })
        .where(eq(syncRuns.id, job.syncRunId));
      await tx
        .update(syncCursors)
        .set(
          done
            ? {
                cursor: null,
                status: 'complete' as const,
                lastSyncedAt: now,
                updatedSince: runStartedAt,
                currentSyncRunId: null,
                lastError: null,
                recordsProcessed: sql`${syncCursors.recordsProcessed} + ${result.processed}`,
              }
            : {
                cursor: page.nextCursor,
                recordsProcessed: sql`${syncCursors.recordsProcessed} + ${result.processed}`,
              },
        )
        .where(eq(syncCursors.id, cursor.id));
      if (!done) return { kind: 'next', job };

      let followUp: SyncPageJob | undefined;
      if (job.then && job.then.resources.length > 0) {
        const [next, ...rest] = job.then.resources;
        const started = await startRun(tx, {
          orgId: job.orgId,
          connectionId: job.connectionId,
          resource: next!,
          mode: job.then.mode,
          since: job.then.since ? new Date(job.then.since) : null,
          now,
        });
        if (started.created) {
          followUp = {
            orgId: job.orgId,
            connectionId: job.connectionId,
            resource: next!,
            syncRunId: started.syncRunId,
            then: rest.length > 0 ? { ...job.then, resources: rest } : undefined,
          };
        }
      }
      return followUp ? { kind: 'done', followUp } : { kind: 'done' };
    });
  } catch (error) {
    if (isDataError(error)) {
      const message = safeMessage((error as { cause?: unknown }).cause ?? error).slice(0, 300);
      await deps.db.withTenant(job.orgId, (tx) =>
        failRun(tx, job, `data rejected by database: ${message}`, now),
      );
      return { kind: 'failed', reason: message };
    }
    throw error;
  }
}
