import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getProducts } from '../src/reports';
import { ORG, addOrder, startReportDb, type ReportDb } from './report-fixture';

const id = (n: number) => `11111111-1111-4111-8111-0000000001${String(n).padStart(2, '0')}`;
const UNDER = id(1);
const NOCOST = id(2);
const AMZ_LOSS = id(3);
const SUPPLIER = id(4);
const MARKUP = id(5);

let r: ReportDb;
async function addSku(skuId: string, code: string, price: number, costs: [number, string, string | null][]) {
  await r.owner.query(`insert into products (id, org_id, title, category) values ($1, $2, $3, 'Cat')`, [
    skuId,
    ORG,
    `Product ${code}`,
  ]);
  await r.owner.query(
    `insert into skus (id, org_id, product_id, sku_code, selling_price_cents) values ($1, $2, $1, $3, $4)`,
    [skuId, ORG, code, price],
  );
  for (const [amount, from, to] of costs) {
    await r.owner.query(
      `insert into sku_cost_components (org_id, sku_id, component_type, amount_cents, effective_from, effective_to)
       values ($1, $2, 'product_cost', $3, $4, $5)`,
      [ORG, skuId, amount, from, to],
    );
  }
}

beforeAll(async () => {
  r = await startReportDb();
  await addSku(UNDER, 'UNDER-1', 1150, [[1000, '2025-01-01', null]]);
  await addSku(NOCOST, 'NOCOST-1', 2000, []);
  await addSku(AMZ_LOSS, 'AMZ-LOSS', 5000, [[4100, '2025-01-01', null]]);
  await addSku(SUPPLIER, 'SUPPLIER-1', 4000, [
    [2000, '2025-01-01', '2026-02-01'],
    [2500, '2026-02-01', null],
  ]);
  await addSku(MARKUP, 'MARKUP-1', 1500, [[1000, '2025-01-01', null]]);
  // One unit of the Amazon-loss SKU on each channel, 3.5% + $5.00 on Shopify, 15% + $5.50 on Amazon.
  await addOrder(r.owner, {
    placedAt: '2026-03-10T15:00:00Z',
    gross: 5000,
    paymentFee: 175,
    fulfillment: 500,
    lines: [{ quantity: 1, price: 5000, cogs: 4100, skuId: AMZ_LOSS }],
  });
  await addOrder(r.owner, {
    channel: 'amazon',
    placedAt: '2026-03-11T15:00:00Z',
    gross: 5000,
    marketplaceFee: 750,
    fulfillment: 550,
    lines: [{ quantity: 1, price: 5000, cogs: 4100, skuId: AMZ_LOSS }],
  });
  await addOrder(r.owner, {
    placedAt: '2026-03-12T15:00:00Z',
    gross: 1150,
    lines: [{ quantity: 1, price: 1150, cogs: 1000, skuId: UNDER }],
  });
}, 180_000);
afterAll(() => r?.stop());

const range = { from: '2026-03-01', to: '2026-03-31' };
const products = (channel: 'all' | 'shopify_online' | 'amazon' = 'all', asOf = '2026-03-31') =>
  r.db.withTenant(ORG, (tx) => getProducts(tx, { range, channel, asOf }));
const row = (rows: Awaited<ReturnType<typeof products>>, code: string) =>
  rows.find((x) => x.skuCode === code)!;

describe('getProducts', () => {
  it('reports the underpriced SKU with a raise-to message', async () => {
    const u = row(await products(), 'UNDER-1');
    expect(u.pricingStatus).toBe('underpriced');
    expect(u.message).toBe('Underpriced. Raise to at least $15.00.');
    expect(u.idealLowCents).toBe(1500);
    expect(u.idealHighCents).toBe(2000);
  });

  it('marks a SKU with no cost components as no_cost with null profit', async () => {
    const n = row(await products(), 'NOCOST-1');
    expect(n.pricingStatus).toBe('no_cost');
    expect(n.landedCents).toBeNull();
    expect(n.profitCents).toBeNull();
  });

  it('shows markup and margin from the CLAUDE.md formulas (50% markup is 33.3% margin)', async () => {
    const m = row(await products(), 'MARKUP-1');
    expect(m.markupBps).toBe(5000);
    expect(m.marginBps).toBe(3333);
    expect(m.pricingStatus).toBe('healthy');
  });

  it('shows contributionNegative for the amazon-loss SKU on amazon but not on shopify_online', async () => {
    expect(row(await products('amazon'), 'AMZ-LOSS').contributionNegative).toBe(true);
    expect(row(await products('shopify_online'), 'AMZ-LOSS').contributionNegative).toBe(false);
  });

  it('computes per-SKU profit after cost of goods and allocated fees', async () => {
    expect(row(await products('amazon'), 'AMZ-LOSS').profitCents).toBe(5000 - 4100 - 750 - 550);
    expect(row(await products('shopify_online'), 'AMZ-LOSS').profitCents).toBe(
      5000 - 4100 - 175 - 500,
    );
    expect(row(await products('amazon'), 'AMZ-LOSS').unitsSold).toBe(1);
  });

  it('uses the cost in effect on asOf when a supplier increase exists', async () => {
    expect(row(await products('all', '2026-01-15'), 'SUPPLIER-1').landedCents).toBe(2000);
    expect(row(await products('all', '2026-03-01'), 'SUPPLIER-1').landedCents).toBe(2500);
  });

  it('sorts by profit descending with unknown profit last', async () => {
    const rows = await products();
    const profits = rows.map((x) => x.profitCents);
    const known = profits.filter((p): p is number => p !== null);
    expect(known).toEqual([...known].sort((a, b) => b - a));
    expect(profits.slice(known.length).every((p) => p === null)).toBe(true);
  });
});
