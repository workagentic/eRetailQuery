import { and, eq, sql } from 'drizzle-orm';
import {
  AuthError,
  PermanentError,
  RateLimitedError,
  SYNC_RESOURCES,
  type NormalizedInventoryLevel,
  type NormalizedLocation,
  type NormalizedOrder,
  type NormalizedProduct,
  type Page,
  type SyncResource,
} from '@erq/connectors';
import { orgs, storeConnections, syncCursors, syncRuns, type Tx } from '@erq/db';
import { toOrgDate } from '../cogs';
import { linkOrderLines } from '../linkup';
import type { PageResult, SyncPageJob } from '../ports';
import { policyFor } from '../policies';
import type { SinkContext, SinkResult } from '../sinks/context';
import { upsertInventory } from '../sinks/inventory';
import { upsertLocations } from '../sinks/locations';
import { upsertOrders } from '../sinks/orders';
import { upsertProducts } from '../sinks/products';
import { createTokenService } from '../tokens';
import { nowOf, type SyncDeps } from './deps';
import { failRun, IMPORT_NOT_STARTED_MESSAGE, safeMessage } from './fail';
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
  const tokens =
    deps.tokens ??
    createTokenService({ db: deps.db, keyProvider: deps.keyProvider, now: deps.now });
  const loaded = await deps.db.withTenant(job.orgId, async (tx) => {
    const [connection] = await tx
      .select({
        id: storeConnections.id,
        platform: storeConnections.platform,
        externalAccountId: storeConnections.externalAccountId,
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
      .select({ startedAt: syncRuns.startedAt, type: syncRuns.type })
      .from(syncRuns)
      .where(eq(syncRuns.id, job.syncRunId));
    return {
      connection,
      cursor,
      timezone: org?.timezone ?? 'UTC',
      runStartedAt: run?.startedAt ?? now,
      runType: run?.type ?? 'incremental',
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
  const { connection, cursor, timezone, runStartedAt, runType } = loaded;

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
    // Refreshes an expiring Shopify token first, under the connection row lock. The connector only ever
    // receives { accessToken }, and an AuthError or PermanentError here fails the run through the catch below.
    const credentials = await tokens.ensureFresh({
      orgId: job.orgId,
      connectionId: connection.id,
    });
    page = await connector.fetchPage(
      { connectionId: connection.id, externalAccountId: connection.externalAccountId, credentials },
      job.resource,
      cursor.cursor,
      // A backfill is bounded by `since` only; the incremental watermark applies to incremental runs alone.
      cursor.backfillSince
        ? { since: cursor.backfillSince }
        : { updatedSince: cursor.updatedSince ?? undefined },
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

  const outcome = { productsCompleted: false };
  try {
    const result = await deps.db.withTenant(job.orgId, async (tx): Promise<PageResult> => {
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
                // A backfill and a full pass both read everything.
                ...(runType === 'backfill' || runType === 'full' ? { lastFullPassAt: now } : {}),
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
      if (job.resource === 'products') outcome.productsCompleted = true;

      // Connection health: only the real end of a chain counts. A chain still in progress records nothing.
      // A resumed job lost its chain, so it cannot tell a real chain end: it records nothing.
      if (!job.resumed && (!job.then || job.then.resources.length === 0)) {
        // Lock the connection row (after the cursor row, the same order as failRun) so the check below sees a
        // failed cursor committed concurrently by another job of this connection. FOR NO KEY UPDATE, not FOR
        // UPDATE: this same transaction (and every other page transaction of the connection) inserts or updates
        // child rows that take FOR KEY SHARE on this row, and the token refresh (Task 3) holds NO KEY UPDATE
        // across an HTTP call; FOR UPDATE would conflict with all of them (stalls, deadlocks).
        await tx
          .select({ id: storeConnections.id })
          .from(storeConnections)
          .where(eq(storeConnections.id, job.connectionId))
          .for('no key update');
        // An errored connection recovers only when none of its resources is still running or has failed,
        // so another pending failure keeps the error visible. A disconnected connection is never touched.
        const recovers = sql`${storeConnections.status} = 'error' and not exists (
          select 1 from ${syncCursors}
          where ${syncCursors.storeConnectionId} = ${storeConnections.id}
            and ${syncCursors.status} in ('running', 'failed'))`;
        // The "first import did not start" warning is false once a chain has really ended: clear it too.
        await tx
          .update(storeConnections)
          .set({
            // The OLDEST resource time, and only once all four resources have completed: a single-resource run
            // or a nudge must never make the whole connection look fresh. Reads this transaction's own cursor write.
            lastSyncedAt: sql`coalesce((
              select case when count(${syncCursors.lastSyncedAt}) = ${SYNC_RESOURCES.length}
                          then min(${syncCursors.lastSyncedAt}) end
              from ${syncCursors}
              where ${syncCursors.storeConnectionId} = ${storeConnections.id}), ${storeConnections.lastSyncedAt})`,
            status: sql`case when ${recovers} then 'active'::connection_status else ${storeConnections.status} end`,
            lastError: sql`case when ${recovers} or ${storeConnections.lastError} = ${IMPORT_NOT_STARTED_MESSAGE} then null else ${storeConnections.lastError} end`,
          })
          .where(
            and(eq(storeConnections.orgId, job.orgId), eq(storeConnections.id, job.connectionId)),
          );
      }

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
    // The page transaction holds the cursor lock, so the link-up runs only after the products chain end has
    // COMMITTED, in its own bounded transactions. It is idempotent and best effort: a failure here never fails the
    // finished run, and the next products run repeats it (unmatched lines are counted on the Connections page).
    if (outcome.productsCompleted) {
      try {
        await linkOrderLines(deps.db, { orgId: job.orgId, connectionId: job.connectionId });
      } catch {
        /* retried by the next products run */
      }
    }
    return result;
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
