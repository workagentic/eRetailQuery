import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAds, getInventory, getOverview } from '../src/reports';
import { ORG, addAdDay, addOrder, startReportDb, type ReportDb } from './report-fixture';

let r: ReportDb;
const SKU_CAT = '11111111-1111-4111-8111-0000000005a1';
const LOC = '11111111-1111-4111-8111-0000000005b1';

beforeAll(async () => {
  r = await startReportDb();
  await r.owner.query(`update products set category = 'Outdoor' where id = $1`, ['11111111-1111-4111-8111-0000000000c1']);
  await r.owner.query(
    `insert into locations (id, org_id, name, type, source) values ($1, $2, 'Main warehouse', 'warehouse', 'manual')`,
    [LOC, ORG],
  );
  await r.owner.query(`insert into inventory_levels (org_id, sku_id, location_id, on_hand) values ($1, $2, $3, 2)`, [
    ORG,
    '11111111-1111-4111-8111-0000000000c1',
    LOC,
  ]);
  void SKU_CAT;
  // Two orders on one day and one on the next: net 9000 + 5000 + 5000.
  await addOrder(r.owner, { placedAt: '2026-03-10T15:00:00Z', gross: 10000, discount: 1000, paymentFee: 300, fulfillment: 500, lines: [{ quantity: 1, price: 10000, cogs: 4000 }] });
  await addOrder(r.owner, { placedAt: '2026-03-10T17:00:00Z', gross: 5000, lines: [{ quantity: 1, price: 5000, cogs: 2000 }] });
  await addOrder(r.owner, { placedAt: '2026-03-11T15:00:00Z', gross: 5000, lines: [{ quantity: 1, price: 5000, cogs: 2000 }] });
  await addAdDay(r.owner, { platform: 'meta', campaign: 'Meta - A', date: '2026-03-10', spend: 1000, revenue: 4000, impressions: 5000 });
  await addAdDay(r.owner, { platform: 'meta', campaign: 'Meta - A', date: '2026-03-12', spend: 500, revenue: 2500, impressions: 5000 });
  await addAdDay(r.owner, { platform: 'amazon_ads', campaign: 'Amazon - B', date: '2026-03-12', spend: 700, revenue: 1000, impressions: 5000 });
}, 240_000);
afterAll(() => r?.stop());

const range = { from: '2026-03-08', to: '2026-03-14' };
const previous = { from: '2026-03-01', to: '2026-03-07' };

describe('overview chart data', () => {
  it('splits net sales into cost of goods, fulfillment, fees, ads and money left, adding up exactly', async () => {
    const o = await r.db.withTenant(ORG, (tx) => getOverview(tx, { range, previous, channel: 'all' }));
    const b = o.breakdown;
    expect(b.netSalesCents).toBe(9000 + 5000 + 5000);
    expect(b.cogsCents).toBe(4000 + 2000 + 2000);
    expect(b.fulfillmentCents).toBe(500);
    expect(b.feesCents).toBe(300);
    expect(b.adSpendCents).toBe(1000 + 500 + 700);
    expect(b.cogsCents + b.fulfillmentCents + b.feesCents + b.adSpendCents + b.profitCents).toBe(b.netSalesCents);
  });

  it('counts orders per day in the daily series', async () => {
    const o = await r.db.withTenant(ORG, (tx) => getOverview(tx, { range, previous, channel: 'all' }));
    expect(o.daily.find((d) => d.date === '2026-03-10')!.orders).toBe(2);
    expect(o.daily.find((d) => d.date === '2026-03-11')!.orders).toBe(1);
    expect(o.daily.find((d) => d.date === '2026-03-09')!.orders).toBe(0);
  });
});

describe('ads chart data', () => {
  it('returns a zero-filled daily spend and platform revenue series for the range', async () => {
    const a = await r.db.withTenant(ORG, (tx) => getAds(tx, { range, asOf: '2026-03-14' }));
    expect(a.daily).toHaveLength(7);
    expect(a.daily.find((d) => d.date === '2026-03-10')).toEqual({ date: '2026-03-10', spendCents: 1000, platformRevenueCents: 4000 });
    expect(a.daily.find((d) => d.date === '2026-03-12')).toEqual({ date: '2026-03-12', spendCents: 1200, platformRevenueCents: 3500 });
    expect(a.daily.find((d) => d.date === '2026-03-09')).toEqual({ date: '2026-03-09', spendCents: 0, platformRevenueCents: 0 });
  });

  it('gives each campaign its break-even ROAS, or null when there is no cost data', async () => {
    const a = await r.db.withTenant(ORG, (tx) => getAds(tx, { range, asOf: '2026-03-14' }));
    const meta = a.campaigns.find((c) => c.name === 'Meta - A')!;
    expect(meta.breakEven).not.toBeNull();
    expect(meta.breakEven!).toBeGreaterThan(1);
  });
});

describe('inventory chart data', () => {
  it('carries the product category so a thumbnail can be drawn', async () => {
    const inv = await r.db.withTenant(ORG, (tx) => getInventory(tx, { asOf: '2026-03-14' }));
    const row = [...inv.lowStock, ...inv.dead, ...inv.overstock].find((s) => s.skuCode === 'W-1')!;
    expect(row.category).toBe('Outdoor');
  });
});
