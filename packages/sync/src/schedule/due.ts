import { SYNC_RESOURCES, type SyncResource } from '@erq/connectors';
import { PRODUCTS_FULL_PASS_MS, SYNC_CADENCE_MS } from './cadence';

export interface CursorSnapshot {
  resource: SyncResource;
  status: 'idle' | 'running' | 'failed' | 'complete';
  lastSyncedAt: Date | null;
  lastFullPassAt: Date | null;
  updatedAt: Date;
}
export interface DueResource {
  resource: SyncResource;
  mode: 'incremental' | 'full';
}

/** The cadence is measured from the last completion, or from the last ATTEMPT while the cursor is failed (back-off). */
function referenceMs(c: CursorSnapshot): number {
  const done = (c.lastSyncedAt as Date).getTime();
  return c.status === 'failed' ? Math.max(done, c.updatedAt.getTime()) : done;
}

/**
 * Which resources of ONE connection should start now. Pure: the database function only pre-filters, this decides.
 * Nothing is due while any cursor is running, and a connection whose first backfill has not finished (a missing
 * cursor row or a null completion time) is left to connect and Sync now.
 */
export function dueResources(cursors: readonly CursorSnapshot[], now: Date): DueResource[] {
  if (cursors.some((c) => c.status === 'running')) return [];
  const byResource = new Map(cursors.map((c) => [c.resource, c]));
  for (const resource of SYNC_RESOURCES) {
    if (byResource.get(resource)?.lastSyncedAt == null) return [];
  }
  const due: DueResource[] = [];
  for (const resource of SYNC_RESOURCES) {
    const c = byResource.get(resource) as CursorSnapshot;
    const waited = now.getTime() - referenceMs(c);
    // A failed attempt (any mode) waits one cadence before the next one.
    const attemptAllowed = c.status !== 'failed' || waited >= SYNC_CADENCE_MS[resource];
    const fullDue =
      resource === 'products' &&
      attemptAllowed &&
      (c.lastFullPassAt === null ||
        now.getTime() - c.lastFullPassAt.getTime() >= PRODUCTS_FULL_PASS_MS);
    if (fullDue) due.push({ resource, mode: 'full' });
    else if (waited >= SYNC_CADENCE_MS[resource]) due.push({ resource, mode: 'incremental' });
  }
  return due;
}

/**
 * One incremental chain, plus (when the products full pass is due) a separate `full` chain of products and the
 * inventory that follows it. Orders and locations stay incremental: a full pass of them would re-read history.
 */
export function planChains(due: readonly DueResource[]): {
  incremental: SyncResource[];
  full: SyncResource[];
} {
  const all = due.map((d) => d.resource);
  if (!due.some((d) => d.resource === 'products' && d.mode === 'full')) {
    return { incremental: all, full: [] };
  }
  const full: SyncResource[] = all.filter((r) => r === 'products' || r === 'inventory');
  return { incremental: all.filter((r) => !full.includes(r)), full };
}
