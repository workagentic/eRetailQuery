import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAttention } from '../src/reports';
import {
  EMPTY_ORG,
  ORG,
  addAdDay,
  addOrder,
  startReportDb,
  type ReportDb,
} from './report-fixture';

const id = (n: number) => `11111111-1111-4111-8111-0000000003${String(n).padStart(2, '0')}`;
const UNDER = id(1);
const AMZ_LOSS = id(2);
const LOW = id(3);
const LOC = id(90);

let r: ReportDb;
const days = Array.from({ length: 14 }, (_, i) => `2026-03-${String(18 + i).padStart(2, '0')}`);

async function addSku(skuId: string, code: string, price: number, landed: number) {
  await r.owner.query(`insert into products (id, org_id, title) values ($1, $2, $3)`, [skuId, ORG, `Product ${code}`]);
  await r.owner.query(
    `insert into skus (id, org_id, product_id, sku_code, selling_price_cents) values ($1, $2, $1, $3, $4)`,
    [skuId, ORG, code, price],
  );
  await r.owner.query(
    `insert into sku_cost_components (org_id, sku_id, component_type, amount_cents, effective_from)
     values ($1, $2, 'product_cost', $3, '2025-01-01')`,
    [ORG, skuId, landed],
  );
}

beforeAll(async () => {
  r = await startReportDb();
  await addSku(UNDER, 'UNDER-1', 1150, 1000);
  await addSku(AMZ_LOSS, 'AMZ-LOSS', 5000, 4100);
  await addSku(LOW, 'LOW-1', 2000, 1000);
  await r.owner.query(
    `insert into locations (id, org_id, name, type, source) values ($1, $2, 'Main warehouse', 'warehouse', 'manual')`,
    [LOC, ORG],
  );
  await r.owner.query(`insert into inventory_levels (org_id, sku_id, location_id, on_hand) values ($1, $2, $3, 5)`, [ORG, LOW, LOC]);
  for (const d of days) {
    // Baseline: 52% contribution before ads, so break-even ROAS is about 1.92.
    await addOrder(r.owner, { placedAt: `${d}T15:00:00Z`, gross: 10000, paymentFee: 300, fulfillment: 500, lines: [{ quantity: 1, price: 10000, cogs: 4000 }] });
    await addOrder(r.owner, { placedAt: `${d}T15:10:00Z`, gross: 1150, lines: [{ quantity: 1, price: 1150, cogs: 1000, skuId: UNDER }] });
    await addOrder(r.owner, { placedAt: `${d}T15:20:00Z`, gross: 2000, lines: [{ quantity: 2, price: 1000, cogs: 1000, skuId: LOW }] });
    await addAdDay(r.owner, { campaign: 'Meta - Big Loser', date: d, spend: 10000, revenue: 15000 });
    await addAdDay(r.owner, { campaign: 'Meta - Small Loser', date: d, spend: 2000, revenue: 3500 });
    await addAdDay(r.owner, { campaign: 'Meta - Tiny Loser', date: d, spend: 1000, revenue: 1800 });
  }
  // One Amazon unit a day of the Amazon-loss SKU: 15% + $5.50 fees lose $4.00 a unit.
  for (const d of days) {
    await addOrder(r.owner, {
      channel: 'amazon',
      placedAt: `${d}T16:00:00Z`,
      gross: 5000,
      marketplaceFee: 750,
      fulfillment: 550,
      lines: [{ quantity: 1, price: 5000, cogs: 4100, skuId: AMZ_LOSS }],
    });
  }
}, 300_000);
afterAll(() => r?.stop());

const range = { from: '2026-03-18', to: '2026-03-31' };
const previous = { from: '2026-03-04', to: '2026-03-17' };
const attention = (org = ORG) =>
  r.db.withTenant(org, (tx) => getAttention(tx, { range, previous, asOf: '2026-03-31' }));

describe('getAttention', () => {
  it('contains a losing ad, an underpriced SKU, low stock and an Amazon loss', async () => {
    const kinds = new Set((await attention()).map((i) => i.kind));
    for (const k of ['losing_ad', 'underpriced', 'low_stock', 'amazon_loss'] as const) {
      expect(kinds.has(k)).toBe(true);
    }
  });

  it('is capped at 5 items and drops the smallest', async () => {
    const items = await attention();
    expect(items).toHaveLength(5);
    expect(items.some((i) => i.title.includes('Meta - Tiny Loser'))).toBe(false);
  });

  it('is ordered by dollars at stake, biggest first', async () => {
    const stakes = (await attention()).map((i) => i.stakeCents);
    expect(stakes).toEqual([...stakes].sort((a, b) => b - a));
  });

  it('explains why each item fired and what to do, with a link', async () => {
    for (const i of await attention()) {
      expect(i.why.length).toBeGreaterThan(10);
      expect(i.action.length).toBeGreaterThan(5);
      expect(i.href).toMatch(/^\//);
    }
  });

  it('is empty for an org with no data', async () => {
    expect(await attention(EMPTY_ORG)).toEqual([]);
  });
});
