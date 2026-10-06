import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orderLines } from '@erq/db';
import { eq } from 'drizzle-orm';
import {
  loadCostRows,
  repriceOrderLines,
  snapshotUnitCogs,
  toOrgDate,
  type CostRow,
} from '../src/cogs';
import { CONN_A, ORG_A, seedCost, seedOrder, seedSku, startEnv, type TestEnv } from './helpers';

const row = (over: Partial<CostRow> = {}): CostRow => ({
  skuId: 's',
  componentType: 'product_cost',
  amountCents: 800,
  perUnit: true,
  currency: 'USD',
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  ...over,
});

describe('toOrgDate', () => {
  it('uses the org timezone, not UTC', () => {
    expect(toOrgDate(new Date('2026-03-01T03:30:00Z'), 'America/New_York')).toBe('2026-02-28');
    expect(toOrgDate(new Date('2026-03-01T03:30:00Z'), 'UTC')).toBe('2026-03-01');
    expect(toOrgDate(new Date('2026-03-08T06:30:00Z'), 'America/New_York')).toBe('2026-03-08'); // day of the DST switch
    expect(toOrgDate(new Date('2026-11-01T04:30:00Z'), 'America/New_York')).toBe('2026-11-01');
  });
  it('rejects an unknown timezone', () => {
    expect(() => toOrgDate(new Date(), 'Mars/Olympus')).toThrow(RangeError);
  });
});

describe('snapshotUnitCogs', () => {
  it('sums the components in effect on the order date', () => {
    const rows = [row(), row({ componentType: 'inbound_freight', amountCents: 100 })];
    expect(snapshotUnitCogs(rows, '2026-09-05', 'USD')).toBe(900);
  });
  it('respects cost versions and their boundaries', () => {
    const rows = [
      row({ amountCents: 700, effectiveTo: '2026-06-01' }),
      row({ amountCents: 900, effectiveFrom: '2026-06-01' }),
    ];
    expect(snapshotUnitCogs(rows, '2026-05-31', 'USD')).toBe(700);
    expect(snapshotUnitCogs(rows, '2026-06-01', 'USD')).toBe(900);
  });
  it('is null (never zero) when the cost is unknown', () => {
    expect(snapshotUnitCogs(undefined, '2026-09-05', 'USD')).toBeNull();
    expect(snapshotUnitCogs([], '2026-09-05', 'USD')).toBeNull();
    expect(snapshotUnitCogs([row()], '2025-12-31', 'USD')).toBeNull(); // before any cost existed
  });
  it('is null when a component in effect is per-batch or in another currency', () => {
    expect(
      snapshotUnitCogs(
        [row(), row({ perUnit: false, componentType: 'inbound_freight', amountCents: 5000 })],
        '2026-09-05',
        'USD',
      ),
    ).toBeNull();
    expect(snapshotUnitCogs([row({ currency: 'EUR' })], '2026-09-05', 'USD')).toBeNull();
  });
  it('treats a genuine zero cost as zero, not unknown', () => {
    expect(snapshotUnitCogs([row({ amountCents: 0 })], '2026-09-05', 'USD')).toBe(0);
  });
});

describe('repriceOrderLines', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await startEnv();
  });
  afterAll(async () => {
    await env?.stop();
  });

  const snapshots = async (orderId: string) =>
    env.db.withTenant(ORG_A, (tx) =>
      tx
        .select({ ext: orderLines.externalLineId, s: orderLines.unitCogsCentsSnapshot })
        .from(orderLines)
        .where(eq(orderLines.orderId, orderId)),
    );

  it('fills snapshots after costs are added, only from the given date, and recomputes when costs change', async () => {
    const sku = await seedSku(env.owner, ORG_A, 'REPRICE-1');
    const early = await seedOrder(env.owner, {
      orgId: ORG_A,
      connectionId: CONN_A,
      externalId: 'old',
      placedAt: '2026-02-10T15:00:00Z',
      lines: [{ skuId: sku, qty: 1 }],
    });
    const late = await seedOrder(env.owner, {
      orgId: ORG_A,
      connectionId: CONN_A,
      externalId: 'new',
      placedAt: '2026-09-10T15:00:00Z',
      lines: [
        { skuId: sku, qty: 2 },
        { skuId: null, qty: 1 },
      ],
    });
    expect((await snapshots(late)).map((l) => l.s)).toEqual([null, null]);

    await seedCost(env.owner, ORG_A, sku, 800, { from: '2026-01-01' });
    const changed = await env.db.withTenant(ORG_A, (tx) =>
      repriceOrderLines(tx, { orgId: ORG_A, skuId: sku, from: new Date('2026-06-01T00:00:00Z') }),
    );
    expect(changed).toBe(1); // only the late order's mapped line
    expect((await snapshots(early))[0]!.s).toBeNull();
    const lateSnaps = await snapshots(late);
    expect(lateSnaps.find((l) => l.ext === 'l-1')!.s).toBe(800);
    expect(lateSnaps.find((l) => l.ext === 'l-2')!.s).toBeNull(); // unmapped line untouched

    expect(
      await env.db.withTenant(ORG_A, (tx) => repriceOrderLines(tx, { orgId: ORG_A, skuId: sku })),
    ).toBe(1); // early order now filled; late unchanged
    expect((await snapshots(early))[0]!.s).toBe(800);

    await env.owner.query(
      `update sku_cost_components set effective_to = '2026-03-01' where sku_id = $1`,
      [sku],
    );
    await seedCost(env.owner, ORG_A, sku, 950, { from: '2026-03-01' });
    await env.db.withTenant(ORG_A, (tx) => repriceOrderLines(tx, { orgId: ORG_A, skuId: sku }));
    expect((await snapshots(early))[0]!.s).toBe(800);
    expect((await snapshots(late)).find((l) => l.ext === 'l-1')!.s).toBe(950);
  });

  it('loads cost rows only for the requested skus', async () => {
    const a = await seedSku(env.owner, ORG_A, 'LOAD-A');
    const b = await seedSku(env.owner, ORG_A, 'LOAD-B');
    await seedCost(env.owner, ORG_A, a, 100);
    const map = await env.db.withTenant(ORG_A, (tx) => loadCostRows(tx, [a, b]));
    expect(map.get(a)).toHaveLength(1);
    expect(map.get(b)).toBeUndefined();
    expect(await env.db.withTenant(ORG_A, (tx) => loadCostRows(tx, []))).toEqual(new Map());
  });
});
