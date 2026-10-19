import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getInventory } from '../src/reports';
import { ORG, addOrder, startReportDb, type ReportDb } from './report-fixture';

const id = (n: number) => `11111111-1111-4111-8111-0000000002${String(n).padStart(2, '0')}`;
const LOW = id(1);
const OKAY = id(2);
const OVER = id(3);
const DEAD = id(4);
const WAREHOUSE = id(90);
const FBA = id(91);

let r: ReportDb;
const days = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 2, 2 + i));
  return d.toISOString().slice(0, 10);
}); // 2026-03-02 .. 2026-03-31

async function addSku(skuId: string, code: string) {
  await r.owner.query(`insert into products (id, org_id, title) values ($1, $2, $3)`, [skuId, ORG, `Product ${code}`]);
  await r.owner.query(
    `insert into skus (id, org_id, product_id, sku_code, selling_price_cents) values ($1, $2, $1, $3, 2000)`,
    [skuId, ORG, code],
  );
  await r.owner.query(
    `insert into sku_cost_components (org_id, sku_id, component_type, amount_cents, effective_from)
     values ($1, $2, 'product_cost', 1000, '2025-01-01')`,
    [ORG, skuId],
  );
}
async function level(skuId: string, locationId: string, onHand: number) {
  await r.owner.query(
    `insert into inventory_levels (org_id, sku_id, location_id, on_hand) values ($1, $2, $3, $4)`,
    [ORG, skuId, locationId, onHand],
  );
}

beforeAll(async () => {
  r = await startReportDb();
  for (const [skuId, code] of [[LOW, 'LOW'], [OKAY, 'OKAY'], [OVER, 'OVER'], [DEAD, 'DEAD']] as const) {
    await addSku(skuId, code);
  }
  await r.owner.query(
    `insert into locations (id, org_id, name, type, source) values ($1, $3, 'Main warehouse', 'warehouse', 'manual'), ($2, $3, 'Amazon FBA', 'fba', 'manual')`,
    [WAREHOUSE, FBA, ORG],
  );
  await level(LOW, WAREHOUSE, 4);
  await level(LOW, FBA, 2);
  await level(OKAY, WAREHOUSE, 60);
  await level(OVER, WAREHOUSE, 300);
  await level(OVER, FBA, 100);
  await level(DEAD, WAREHOUSE, 20);
  for (const d of days) {
    await addOrder(r.owner, { placedAt: `${d}T15:00:00Z`, gross: 4000, lines: [{ quantity: 2, price: 2000, cogs: 1000, skuId: LOW }] });
    await addOrder(r.owner, { placedAt: `${d}T16:00:00Z`, gross: 2000, lines: [{ quantity: 1, price: 2000, cogs: 1000, skuId: OKAY }] });
    await addOrder(r.owner, { placedAt: `${d}T17:00:00Z`, gross: 2000, lines: [{ quantity: 1, price: 2000, cogs: 1000, skuId: OVER }] });
  }
}, 240_000);
afterAll(() => r?.stop());

const inventory = () => r.db.withTenant(ORG, (tx) => getInventory(tx, { asOf: '2026-03-31' }));

describe('getInventory', () => {
  it('lists the fast seller with little stock as low stock, with days of cover and an action', async () => {
    const inv = await inventory();
    const low = inv.lowStock.find((s) => s.skuCode === 'LOW')!;
    expect(low.available).toBe(6);
    expect(low.daysOfCover).not.toBeNull();
    expect(low.daysOfCover!).toBeLessThan(14);
    expect(low.reason).toMatch(/Running low/);
    expect(low.action).toBe('Reorder now');
    expect(inv.lowStock.some((s) => s.skuCode === 'OKAY')).toBe(false);
  });

  it('lists a SKU with stock and no sales in 90 days as dead stock', async () => {
    const inv = await inventory();
    expect(inv.dead.map((s) => s.skuCode)).toEqual(['DEAD']);
  });

  it('lists a SKU with far more stock than it sells as overstock', async () => {
    const inv = await inventory();
    expect(inv.overstock.map((s) => s.skuCode)).toEqual(['OVER']);
  });

  it('sums stock by location to the total available, valued at landed cost', async () => {
    const inv = await inventory();
    const units = inv.byLocation.reduce((a, l) => a + l.units, 0);
    expect(units).toBe(6 + 60 + 400 + 20);
    expect(inv.byLocation.reduce((a, l) => a + l.valueCents, 0)).toBe(units * 1000);
    expect(inv.byLocation.map((l) => l.location).sort()).toEqual(['Amazon FBA', 'Main warehouse']);
  });

  it('returns empty lists for an org with no inventory', async () => {
    const inv = await r.db.withTenant('22222222-2222-4222-8222-222222222222', (tx) =>
      getInventory(tx, { asOf: '2026-03-31' }),
    );
    expect(inv.lowStock).toEqual([]);
    expect(inv.byLocation).toEqual([]);
  });
});
