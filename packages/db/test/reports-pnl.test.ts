import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sumPnl } from '@erq/metrics';
import { getMonthlyPnl } from '../src/reports';
import { ORG, addAdDay, addOrder, startReportDb, type ReportDb } from './report-fixture';

let r: ReportDb;
beforeAll(async () => {
  r = await startReportDb();
  // March 2026
  await addOrder(r.owner, {
    placedAt: '2026-03-10T15:00:00Z',
    gross: 10000,
    discount: 1000,
    paymentFee: 300,
    fulfillment: 500,
    lines: [{ quantity: 1, price: 10000, cogs: 4000 }],
  });
  await addOrder(r.owner, {
    channel: 'amazon',
    placedAt: '2026-03-12T15:00:00Z',
    gross: 6000,
    marketplaceFee: 900,
    fulfillment: 550,
    lines: [{ quantity: 1, price: 6000, cogs: 3000 }],
  });
  await addAdDay(r.owner, { platform: 'meta', date: '2026-03-10', spend: 2000, revenue: 6000 });
  // February 2026 (the previous month)
  await addOrder(r.owner, {
    placedAt: '2026-02-10T15:00:00Z',
    gross: 8000,
    lines: [{ quantity: 1, price: 8000, cogs: 3000 }],
  });
  // April 2026: one order whose cost is unknown
  await addOrder(r.owner, {
    placedAt: '2026-04-10T15:00:00Z',
    gross: 5000,
    lines: [{ quantity: 1, price: 5000, cogs: null }],
  });
}, 180_000);
afterAll(() => r?.stop());

const pnl = (month: string, channel: 'all' | 'shopify_online' | 'amazon' = 'all') =>
  r.db.withTenant(ORG, (tx) => getMonthlyPnl(tx, { month, channel }));

describe('getMonthlyPnl', () => {
  it('reproduces hand-computed totals for a small month', async () => {
    const { current } = await pnl('2026-03');
    expect(current.grossSales.cents).toBe(16000);
    expect(current.discounts.cents).toBe(1000);
    expect(current.netSales.cents).toBe(15000);
    expect(current.cogs.cents).toBe(7000);
    expect(current.grossProfit.cents).toBe(8000);
    expect(current.fulfillment.cents).toBe(1050);
    expect(current.paymentFees.cents).toBe(300);
    expect(current.marketplaceFees.cents).toBe(900);
    expect(current.contributionMargin.cents).toBe(5750);
    expect(current.adSpend.total.cents).toBe(2000);
    expect(current.netContributionAfterMarketing.cents).toBe(3750);
  });

  it('has channel P&Ls that sum to the all-channels P&L', async () => {
    const m = await pnl('2026-03');
    expect(m.byChannel.map((c) => c.channel).sort()).toEqual(['amazon', 'shopify_online']);
    const total = sumPnl(m.byChannel.map((c) => c.pnl), 'USD');
    expect(total.netContributionAfterMarketing.cents).toBe(m.current.netContributionAfterMarketing.cents);
    expect(total.grossSales.cents).toBe(m.current.grossSales.cents);
  });

  it('compares with the previous month', async () => {
    const m = await pnl('2026-03');
    expect(m.previous.grossSales.cents).toBe(8000);
    expect(m.comparison.grossSales.change.cents).toBe(8000);
  });

  it('flags a month containing an order with unknown cost as incomplete', async () => {
    expect((await pnl('2026-04')).costComplete).toBe(false);
    expect((await pnl('2026-03')).costComplete).toBe(true);
  });

  it('returns an all-zero P&L for a month with no data', async () => {
    const m = await pnl('2026-05');
    expect(m.current.grossSales.cents).toBe(0);
    expect(m.current.estimatedOperatingProfit.cents).toBe(0);
    expect(m.byChannel).toEqual([]);
  });

  it('has no same-month-last-year P&L when there is no data that year', async () => {
    expect((await pnl('2026-03')).sameMonthLastYear).toBeNull();
  });

  it('describes ad platforms and channels in plain English', async () => {
    const m = await pnl('2026-03');
    expect(m.byAdPlatform).toEqual([{ platform: 'meta', spendCents: 2000, platformRevenueCents: 6000 }]);
    expect(m.callouts.some((c) => c.includes('Meta') && c.includes('$20.00'))).toBe(true);
    expect(m.callouts.some((c) => /Amazon (earned|lost)/.test(c))).toBe(true);
  });

  it('rejects a malformed month', async () => {
    await expect(pnl('2026-3')).rejects.toThrow(/YYYY-MM/);
  });
});
