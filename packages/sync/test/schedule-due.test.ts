import { SYNC_RESOURCES, type SyncResource } from '@erq/connectors';
import { describe, expect, it } from 'vitest';
import {
  MAX_CONNECTIONS_PER_TICK,
  PRODUCTS_FULL_PASS_MS,
  SYNC_CADENCE_MS,
} from '../src/schedule/cadence';
import { dueResources, planChains, type CursorSnapshot } from '../src/schedule/due';

const NOW = new Date('2026-10-08T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;

function cursors(
  over: Partial<Record<SyncResource, Partial<CursorSnapshot>>> = {},
  syncedAgoMs = 5 * MIN,
): CursorSnapshot[] {
  return SYNC_RESOURCES.map((resource): CursorSnapshot => ({
    resource,
    status: 'complete',
    lastSyncedAt: ago(syncedAgoMs),
    lastFullPassAt: ago(60 * MIN),
    updatedAt: ago(syncedAgoMs),
    ...over[resource],
  }));
}

describe('constants (copied from the spec)', () => {
  it('has the agreed cadences', () => {
    expect(SYNC_CADENCE_MS).toEqual({
      locations: 15 * MIN,
      products: 15 * MIN,
      orders: 15 * MIN,
      inventory: 60 * MIN,
    });
    expect(PRODUCTS_FULL_PASS_MS).toBe(24 * 60 * MIN);
    expect(MAX_CONNECTIONS_PER_TICK).toBe(50);
  });
});

describe('dueResources', () => {
  it('has nothing due when everything is fresh', () => {
    expect(dueResources(cursors(), NOW)).toEqual([]);
  });
  it.each(SYNC_RESOURCES.map((r) => [r, SYNC_CADENCE_MS[r]] as const))(
    '%s is not due one millisecond before its cadence and is due exactly at it',
    (resource, cadence) => {
      expect(
        dueResources(cursors({ [resource]: { lastSyncedAt: ago(cadence - 1) } }), NOW),
      ).toEqual([]);
      expect(dueResources(cursors({ [resource]: { lastSyncedAt: ago(cadence) } }), NOW)).toEqual([
        { resource, mode: 'incremental' },
      ]);
    },
  );
  it('returns the due resources in dependency order', () => {
    const due = dueResources(
      cursors({
        orders: { lastSyncedAt: ago(20 * MIN) },
        locations: { lastSyncedAt: ago(20 * MIN) },
        inventory: { lastSyncedAt: ago(61 * MIN) },
      }),
      NOW,
    );
    expect(due.map((d) => d.resource)).toEqual(['locations', 'inventory', 'orders']);
  });
  it('asks for the products full pass at exactly 24 hours, or when there is no record, and it replaces the incremental', () => {
    const justUnder = cursors({ products: { lastFullPassAt: ago(PRODUCTS_FULL_PASS_MS - 1) } });
    expect(dueResources(justUnder, NOW)).toEqual([]);
    expect(
      dueResources(cursors({ products: { lastFullPassAt: ago(PRODUCTS_FULL_PASS_MS) } }), NOW),
    ).toEqual([{ resource: 'products', mode: 'full' }]);
    expect(dueResources(cursors({ products: { lastFullPassAt: null } }), NOW)).toEqual([
      { resource: 'products', mode: 'full' },
    ]);
    const both = cursors({ products: { lastFullPassAt: null, lastSyncedAt: ago(30 * MIN) } });
    expect(dueResources(both, NOW).filter((d) => d.resource === 'products')).toEqual([
      { resource: 'products', mode: 'full' },
    ]);
  });
  it('is blocked by ANY running cursor, even when other resources are long overdue', () => {
    const c = cursors({
      orders: { status: 'running' },
      locations: { lastSyncedAt: ago(5 * 60 * MIN) },
    });
    expect(dueResources(c, NOW)).toEqual([]);
  });
  it('skips a connection that never finished its first backfill', () => {
    const overdue = 5 * 60 * MIN;
    expect(dueResources(cursors({ orders: { lastSyncedAt: null } }, overdue), NOW)).toEqual([]);
    expect(dueResources(cursors({}, overdue).slice(0, 3), NOW)).toEqual([]); // a missing cursor row
    expect(dueResources([], NOW)).toEqual([]);
  });
  it('waits one cadence after a FAILED attempt instead of retrying every tick', () => {
    const failedRecently = cursors({
      orders: { status: 'failed', lastSyncedAt: ago(3 * 60 * MIN), updatedAt: ago(MIN) },
    });
    expect(dueResources(failedRecently, NOW)).toEqual([]);
    const failedLongAgo = cursors({
      orders: { status: 'failed', lastSyncedAt: ago(3 * 60 * MIN), updatedAt: ago(15 * MIN) },
    });
    expect(dueResources(failedLongAgo, NOW)).toEqual([{ resource: 'orders', mode: 'incremental' }]);
  });
  it('also waits after a failed products full pass', () => {
    const c = cursors({
      products: {
        status: 'failed',
        lastFullPassAt: null,
        lastSyncedAt: ago(3 * 60 * MIN),
        updatedAt: ago(2 * MIN),
      },
    });
    expect(dueResources(c, NOW)).toEqual([]);
  });
});

describe('planChains', () => {
  it('uses one incremental chain when no full pass is due', () => {
    expect(
      planChains([
        { resource: 'locations', mode: 'incremental' },
        { resource: 'orders', mode: 'incremental' },
      ]),
    ).toEqual({ incremental: ['locations', 'orders'], full: [] });
  });
  it('splits the daily pass off with the inventory that follows it, keeping the rest incremental', () => {
    expect(
      planChains([
        { resource: 'locations', mode: 'incremental' },
        { resource: 'products', mode: 'full' },
        { resource: 'inventory', mode: 'incremental' },
        { resource: 'orders', mode: 'incremental' },
      ]),
    ).toEqual({ incremental: ['locations', 'orders'], full: ['products', 'inventory'] });
    expect(planChains([{ resource: 'products', mode: 'full' }])).toEqual({
      incremental: [],
      full: ['products'],
    });
  });
});
