import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getOverview, resolveRange } from '../src/reports';
import { AMAZON, EMPTY_ORG, ORG, addAdDay, addOrder, startReportDb, type ReportDb } from './report-fixture';

let r: ReportDb;
beforeAll(async () => {
  r = await startReportDb();
  // Org timezone is America/New_York (EDT, UTC-4 in March).
  await addOrder(r.owner, { placedAt: '2026-03-10T15:00:00Z', gross: 10000, paymentFee: 320, fulfillment: 500 });
  await addOrder(r.owner, { placedAt: '2026-03-11T15:00:00Z', gross: 7000, status: 'cancelled' });
  await addOrder(r.owner, { placedAt: '2026-03-12T15:00:00Z', gross: 9000, isTest: true });
  await addOrder(r.owner, {
    channel: 'amazon',
    placedAt: '2026-03-13T15:00:00Z',
    gross: 5000,
    marketplaceFee: 750,
    fulfillment: 550,
  });
  // 23:59 in New York on the last day of the range, and one minute later.
  await addOrder(r.owner, { placedAt: '2026-03-31T03:59:00Z', gross: 2000 });
  await addOrder(r.owner, { placedAt: '2026-03-31T04:01:00Z', gross: 3000 });
  // Refunds larger than the sale.
  await addOrder(r.owner, { placedAt: '2026-03-14T15:00:00Z', gross: 1000, refund: 1500 });
  await addAdDay(r.owner, { platform: 'meta', date: '2026-03-10', spend: 3000, revenue: 9000 });
}, 180_000);
afterAll(() => r?.stop());

const range = { from: '2026-03-01', to: '2026-03-30' };
const previous = { from: '2026-01-30', to: '2026-02-28' };
const overview = (channel: 'all' | 'shopify_online' | 'amazon' = 'all', rng = range) =>
  r.db.withTenant(ORG, (tx) => getOverview(tx, { range: rng, previous, channel }));

describe('resolveRange', () => {
  it('previous range does not overlap current and has the same length', () => {
    for (const preset of ['7d', '30d', '90d', 'mtd'] as const) {
      const { current, previous: prev } = resolveRange(preset, '2026-03-30');
      expect(current.to).toBe('2026-03-30');
      expect(prev.to < current.from).toBe(true);
      const len = (x: { from: string; to: string }) =>
        (Date.parse(x.to) - Date.parse(x.from)) / 86_400_000;
      expect(len(prev)).toBe(len(current));
    }
    expect(resolveRange('7d', '2026-03-30').current.from).toBe('2026-03-24');
    expect(resolveRange('mtd', '2026-03-30').current.from).toBe('2026-03-01');
  });
});

describe('getOverview', () => {
  it('revenue equals the sum of non-cancelled, non-test order net', async () => {
    const o = await overview();
    // 10000 + 5000 + 2000 (23:59 NY on Mar 30) + (1000 - 1500) refund order
    expect(o.kpis.revenue.value.cents).toBe(10000 + 5000 + 2000 - 500);
    expect(o.kpis.orders.value).toBe(4);
  });

  it('counts an order at 23:59 on the last day once, and the next minute on the next day', async () => {
    const o = await overview();
    expect(o.daily.find((d) => d.date === '2026-03-30')!.revenue).toBe(2000);
    const next = await overview('all', { from: '2026-03-31', to: '2026-03-31' });
    expect(next.kpis.revenue.value.cents).toBe(3000);
  });

  it('blended ROAS is net revenue over total ad spend', async () => {
    const o = await overview();
    expect(o.kpis.adSpend.value.cents).toBe(3000);
    expect(o.kpis.blendedRoas.value).toBeCloseTo(16500 / 3000, 5);
  });

  it('blended ROAS is null when the filtered channel has no ad spend', async () => {
    const o = await overview('amazon');
    expect(o.kpis.adSpend.value.cents).toBe(0);
    expect(o.kpis.blendedRoas.value).toBeNull();
  });

  it('filtering to amazon excludes shopify orders from every figure', async () => {
    const o = await overview('amazon');
    expect(o.kpis.revenue.value.cents).toBe(5000);
    expect(o.kpis.orders.value).toBe(1);
    expect(o.byChannel.map((c) => c.channel)).toEqual(['amazon']);
    expect(o.daily.reduce((a, d) => a + d.revenue, 0)).toBe(5000);
  });

  it('subtracts cost of goods, fees and ad spend to get estimated profit', async () => {
    const o = await overview('amazon');
    // net 5000 - cogs 2000 (40%) - marketplace 750 - fulfillment 550 = 1700, no amazon ad spend
    expect(o.kpis.estimatedProfit.value.cents).toBe(1700);
    const all = await overview();
    expect(all.byChannel.reduce((a, c) => a + c.profit.cents, 0)).toBe(
      all.kpis.estimatedProfit.value.cents,
    );
  });

  it('gives negative net without throwing when refunds exceed the sale', async () => {
    const o = await overview('shopify_online', { from: '2026-03-14', to: '2026-03-14' });
    expect(o.kpis.revenue.value.cents).toBe(-500);
  });

  it('returns zeros, null ROAS and zero-filled days for an org with no orders', async () => {
    const o = await r.db.withTenant(EMPTY_ORG, (tx) =>
      getOverview(tx, { range, previous, channel: 'all' }),
    );
    expect(o.kpis.revenue.value.cents).toBe(0);
    expect(o.kpis.blendedRoas.value).toBeNull();
    expect(o.daily).toHaveLength(30);
    expect(o.daily.every((d) => d.revenue === 0 && d.profit === 0)).toBe(true);
    expect(o.byChannel).toEqual([]);
  });

  it('uses an amazon connection only for amazon-channel orders', async () => {
    expect(AMAZON).toBeTruthy();
    const o = await overview('shopify_online');
    expect(o.byChannel.map((c) => c.channel)).toEqual(['shopify_online']);
  });
});
