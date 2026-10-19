import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAds } from '../src/reports';
import { ORG, addAdDay, addOrder, startReportDb, type ReportDb } from './report-fixture';

let r: ReportDb;
const days = Array.from({ length: 14 }, (_, i) => `2026-03-${String(18 + i).padStart(2, '0')}`);

beforeAll(async () => {
  r = await startReportDb();
  for (const d of days) {
    // Contribution before ads: (10000 - 4000 - 300 - 500) / 10000 = 52%, so break-even ROAS is about 1.92.
    await addOrder(r.owner, {
      placedAt: `${d}T15:00:00Z`,
      gross: 10000,
      paymentFee: 300,
      fulfillment: 500,
      lines: [{ quantity: 1, price: 10000, cogs: 4000 }],
    });
    await addAdDay(r.owner, { campaign: 'Meta - Losing', date: d, spend: 10000, revenue: 15000, impressions: 50000 });
    await addAdDay(r.owner, { campaign: 'Meta - Winner', date: d, spend: 6000, revenue: 30000, impressions: 40000 });
    await addAdDay(r.owner, { campaign: 'Meta - Tiny', date: d, spend: 200, revenue: 100, impressions: 100 });
    await addAdDay(r.owner, { platform: 'amazon_ads', campaign: 'Amazon - Idle', date: d, spend: 0, revenue: 0, impressions: 0 });
  }
}, 180_000);
afterAll(() => r?.stop());

const range = { from: '2026-03-18', to: '2026-03-31' };
const ads = () => r.db.withTenant(ORG, (tx) => getAds(tx, { range, asOf: '2026-03-31' }));
const byName = async (name: string) => (await ads()).campaigns.find((c) => c.name === name)!;

describe('getAds', () => {
  it('flags the losing Meta campaign with a pause action and a positive daily loss', async () => {
    const c = await byName('Meta - Losing');
    expect(c.flag).toBe('losing');
    expect(c.action).toMatch(/^Pause/);
    expect(c.estimatedDailyLossCents).toBeGreaterThan(0);
    expect(c.reason.length).toBeGreaterThan(10);
  });

  it('flags the winning Meta campaign as winning with a scale action', async () => {
    const c = await byName('Meta - Winner');
    expect(c.flag).toBe('winning');
    expect(c.action).toMatch(/^Scale/);
  });

  it('keeps a campaign under the minimum spend and impressions in learning, never losing', async () => {
    const c = await byName('Meta - Tiny');
    expect(c.flag).toBe('learning');
  });

  it('returns both platform ROAS and blended ROAS, and they differ', async () => {
    const a = await ads();
    expect(a.totals.spendCents).toBe(14 * 16200);
    expect(a.totals.platformRoas).toBeCloseTo((14 * 45100) / (14 * 16200), 5);
    expect(a.totals.blendedRoas).toBeCloseTo((14 * 10000) / (14 * 16200), 5);
    expect(a.totals.platformRoas).not.toBeCloseTo(a.totals.blendedRoas!, 1);
    expect(a.usedGenericBands).toBe(false);
  });

  it('sorts campaigns losing first, then watch, winning, learning', async () => {
    const order = (await ads()).campaigns.map((c) => c.flag);
    const rank = { losing: 0, watch: 1, winning: 2, learning: 3 } as const;
    expect(order.map((f) => rank[f])).toEqual([...order.map((f) => rank[f])].sort((x, y) => x - y));
    expect(order[0]).toBe('losing');
  });

  it('gives null ROAS, not Infinity, for a campaign with zero spend', async () => {
    const c = await byName('Amazon - Idle');
    expect(c.roas).toBeNull();
    expect(c.spendCents).toBe(0);
    expect(c.flag).toBe('learning');
  });

  it('breaks results down by platform with money left after ads', async () => {
    const meta = (await ads()).byPlatform.find((p) => p.platform === 'meta')!;
    expect(meta.spendCents).toBe(14 * 16200);
    expect(meta.platformRevenueCents).toBe(14 * 45100);
    expect(typeof meta.netAfterAdsCents).toBe('number');
  });
});
