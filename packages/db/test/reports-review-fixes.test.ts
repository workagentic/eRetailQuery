import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAds, getAttention, getProducts } from '../src/reports';
import { ORG, addAdDay, addOrder, startReportDb, type ReportDb } from './report-fixture';

const id = (n: number) => `11111111-1111-4111-8111-0000000004${String(n).padStart(2, '0')}`;
const days = Array.from({ length: 14 }, (_, i) => `2026-03-${String(18 + i).padStart(2, '0')}`);
const range = { from: '2026-03-18', to: '2026-03-31' };
const previous = { from: '2026-03-04', to: '2026-03-17' };

async function addSku(r: ReportDb, skuId: string, code: string, price: number, landed: number) {
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

describe('ads on a channel that loses money before ads, and incomplete costs', () => {
  let r: ReportDb;
  beforeAll(async () => {
    r = await startReportDb();
    for (const d of days) {
      // Shopify earns 52% before ads.
      await addOrder(r.owner, { placedAt: `${d}T15:00:00Z`, gross: 10000, paymentFee: 300, fulfillment: 500, lines: [{ quantity: 1, price: 10000, cogs: 4000 }] });
      // Amazon loses 10.5% before ads: 10000 - 9000 - 1500 - 550.
      await addOrder(r.owner, { channel: 'amazon', placedAt: `${d}T16:00:00Z`, gross: 10000, marketplaceFee: 1500, fulfillment: 550, lines: [{ quantity: 1, price: 10000, cogs: 9000 }] });
      await addAdDay(r.owner, { platform: 'meta', campaign: 'Meta - Fine', date: d, spend: 5000, revenue: 30000, impressions: 40000 });
      // A healthy-looking 3.5x ROAS on a channel where every sale loses money.
      await addAdDay(r.owner, { platform: 'amazon_ads', campaign: 'Amazon - Looks Great', date: d, spend: 5000, revenue: 17500, impressions: 40000 });
    }
    // An order with an unknown cost, outside the main range.
    await addOrder(r.owner, { placedAt: '2026-04-20T15:00:00Z', gross: 5000, lines: [{ quantity: 1, price: 5000, cogs: null }] });
    await addAdDay(r.owner, { platform: 'meta', campaign: 'Meta - Fine', date: '2026-04-20', spend: 5000, revenue: 30000, impressions: 40000 });
  }, 240_000);
  afterAll(() => r?.stop());

  const ads = (rng = range, asOf = '2026-03-31') => r.db.withTenant(ORG, (tx) => getAds(tx, { range: rng, asOf }));

  it('flags an ad as losing when its channel loses money before ads, even at a high ROAS', async () => {
    const c = (await ads()).campaigns.find((x) => x.name === 'Amazon - Looks Great')!;
    expect(c.flag).toBe('losing');
    expect(c.reason).toMatch(/loses money before ads/i);
    expect(c.action).toMatch(/^Pause/);
    expect(c.estimatedDailyLossCents).toBe(5000);
  });

  it('does not tell the owner to add costs when costs are complete and the channel simply loses money', async () => {
    const a = await ads();
    expect(a.usedGenericBands).toBe(false);
    expect(a.costComplete).toBe(true);
  });

  it('judges the Meta campaign against Shopify, not Amazon', async () => {
    expect((await ads()).campaigns.find((x) => x.name === 'Meta - Fine')!.flag).toBe('winning');
  });

  it('reports that cost data is incomplete when sold lines have no cost on record', async () => {
    const a = await ads({ from: '2026-04-15', to: '2026-04-30' }, '2026-04-30');
    expect(a.costComplete).toBe(false);
  });
});

describe('products with per-batch or foreign-currency cost components', () => {
  let r: ReportDb;
  beforeAll(async () => {
    r = await startReportDb();
    await addSku(r, id(1), 'BATCH-1', 3000, 1000);
    await r.owner.query(
      `insert into sku_cost_components (org_id, sku_id, component_type, amount_cents, per_unit, effective_from)
       values ($1, $2, 'packaging', 5000, false, '2025-01-01')`,
      [ORG, id(1)],
    );
    await r.owner.query(
      `insert into sku_cost_components (org_id, sku_id, component_type, amount_cents, currency, effective_from)
       values ($1, $2, 'inbound_freight', 400, 'EUR', '2025-01-01')`,
      [ORG, id(1)],
    );
    await addSku(r, id(2), 'PLAIN-1', 3000, 1000);
  }, 240_000);
  afterAll(() => r?.stop());

  it('does not throw, uses the usable components and marks the SKU cost incomplete', async () => {
    const rows = await r.db.withTenant(ORG, (tx) => getProducts(tx, { range, channel: 'all', asOf: '2026-03-31' }));
    const batch = rows.find((x) => x.skuCode === 'BATCH-1')!;
    expect(batch.landedCents).toBe(1000);
    expect(batch.costIncomplete).toBe(true);
    expect(batch.message).toMatch(/per batch|another currency/);
    expect(rows.find((x) => x.skuCode === 'PLAIN-1')!.costIncomplete).toBe(false);
  });
});

describe('the attention feed follows the channel filter', () => {
  let r: ReportDb;
  beforeAll(async () => {
    r = await startReportDb();
    await addSku(r, id(10), 'UNDER-1', 1150, 1000);
    await addSku(r, id(11), 'AMZ-LOSS', 1882, 1200);
    for (const d of days) {
      await addOrder(r.owner, { placedAt: `${d}T15:00:00Z`, gross: 10000, paymentFee: 300, fulfillment: 500, lines: [{ quantity: 1, price: 10000, cogs: 4000 }] });
      await addOrder(r.owner, { placedAt: `${d}T15:10:00Z`, gross: 1150, paymentFee: 40, fulfillment: 500, lines: [{ quantity: 1, price: 1150, cogs: 1000, skuId: id(10) }] });
      await addOrder(r.owner, { channel: 'amazon', placedAt: `${d}T16:00:00Z`, gross: 1882, marketplaceFee: 282, fulfillment: 550, lines: [{ quantity: 1, price: 1882, cogs: 1200, skuId: id(11) }] });
      await addAdDay(r.owner, { platform: 'meta', campaign: 'Meta - Big Loser', date: d, spend: 10000, revenue: 15000 });
      await addAdDay(r.owner, { platform: 'amazon_ads', campaign: 'Amazon - Loser', date: d, spend: 3000, revenue: 4000 });
    }
  }, 300_000);
  afterAll(() => r?.stop());

  const feed = (channel: 'all' | 'shopify_online' | 'amazon') =>
    r.db.withTenant(ORG, (tx) => getAttention(tx, { range, previous, asOf: '2026-03-31', channel }));
  const text = (items: Awaited<ReturnType<typeof feed>>) => items.map((i) => `${i.kind} ${i.title}`).join(' | ');

  it('shows every channel on all', async () => {
    const t = text(await feed('all'));
    expect(t).toContain('Meta - Big Loser');
    expect(t).toContain('Amazon - Loser');
  });

  it('shows only Amazon ads and Amazon problems when filtered to amazon', async () => {
    const t = text(await feed('amazon'));
    expect(t).not.toContain('Meta - Big Loser');
    expect(t).toContain('Amazon - Loser');
  });

  it('shows no Amazon problems when filtered to shopify_online', async () => {
    const items = await feed('shopify_online');
    const t = text(items);
    expect(t).toContain('Meta - Big Loser');
    expect(t).not.toContain('Amazon - Loser');
    expect(items.some((i) => i.kind === 'amazon_loss')).toBe(false);
  });
});
