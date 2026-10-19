import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTenantDb,
  getAds,
  getAttention,
  getInventory,
  getMonthlyPnl,
  getOverview,
  getProducts,
  resolveRange,
  type TenantDb,
} from '../src';
import { DEMO_STORY } from '../src/demo-data';
import { DEMO_ORG_ID, seedDemoOrg } from '../src/seed';
import { startTestDatabase, type TestDatabase } from '../src/testing';

/** The real seed through the real reports: proves the planted story reaches the screens. */
let tdb: TestDatabase;
let db: TenantDb;
let owner: Pool;
const END = '2026-10-19';

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  await seedDemoOrg(tdb.ownerUrl, { endDate: END });
  db = createTenantDb(tdb.appUrl);
}, 240_000);
afterAll(async () => {
  await db?.close();
  await owner?.end();
  await tdb?.stop();
});

const { current, previous } = resolveRange('30d', END);
const run = <T>(fn: Parameters<TenantDb['withTenant']>[1] & ((tx: never) => Promise<T>)) =>
  db.withTenant(DEMO_ORG_ID, fn as never) as Promise<T>;

describe('the demo org through the reports', () => {
  it('shows a profitable business with sales on both channels', async () => {
    const o = await db.withTenant(DEMO_ORG_ID, (tx) =>
      getOverview(tx, { range: current, previous, channel: 'all' }),
    );
    expect(o.kpis.revenue.value.cents).toBeGreaterThan(0);
    expect(o.kpis.blendedRoas.value).not.toBeNull();
    expect(o.byChannel.map((c) => c.channel).sort()).toEqual(['amazon', 'shopify_online']);
    expect(o.costComplete).toBe(true);
    expect(o.asOf).toBe(END);
    expect(o.daily).toHaveLength(30);
  });

  it('flags the planted Meta campaign as losing and the Google campaign as winning', async () => {
    const ads = await db.withTenant(DEMO_ORG_ID, (tx) => getAds(tx, { range: current, asOf: END }));
    const by = (name: string) => ads.campaigns.find((c) => c.name === name)!;
    expect(by(DEMO_STORY.losingCampaignName).flag).toBe('losing');
    expect(by(DEMO_STORY.winningCampaignName).flag).toBe('winning');
    expect(ads.campaigns[0]!.flag).toBe('losing');
    expect(ads.usedGenericBands).toBe(false);
  });

  it('reports the planted SKUs on the products screen', async () => {
    const rows = await db.withTenant(DEMO_ORG_ID, (tx) =>
      getProducts(tx, { range: current, channel: 'all', asOf: END }),
    );
    expect(rows).toHaveLength(200);
    expect(rows.find((r) => r.skuCode === DEMO_STORY.underpricedSkuCode)!.pricingStatus).toBe('underpriced');
    const amazon = await db.withTenant(DEMO_ORG_ID, (tx) =>
      getProducts(tx, { range: current, channel: 'amazon', asOf: END }),
    );
    expect(amazon.find((r) => r.skuCode === DEMO_STORY.amazonLossSkuCode)!.contributionNegative).toBe(true);
  });

  it('lists the three planted SKUs as low stock', async () => {
    const inv = await db.withTenant(DEMO_ORG_ID, (tx) => getInventory(tx, { asOf: END }));
    const low = new Set(inv.lowStock.map((s) => s.skuCode));
    for (const code of DEMO_STORY.lowStockSkuCodes) expect(low.has(code)).toBe(true);
    expect(inv.byLocation).toHaveLength(2);
  });

  it('puts the planted losing ad, underpriced SKU, Amazon loss and low stock in the attention feed', async () => {
    const items = await db.withTenant(DEMO_ORG_ID, (tx) =>
      getAttention(tx, { range: current, previous, asOf: END }),
    );
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(5);
    const kinds = new Set(items.map((i) => i.kind));
    expect(kinds.has('losing_ad')).toBe(true);
    expect(kinds.has('low_stock')).toBe(true);
    expect(kinds.has('underpriced')).toBe(true);
    expect(kinds.has('amazon_loss')).toBe(true);
    expect(items.find((i) => i.kind === 'low_stock')!.title).toBe('3 products are about to run out');
    // Print the feed so a human can read what the boss will see.
    console.log(items.map((i) => `${i.severity} ${i.kind}: ${i.title} (${i.stakeCents})`).join('\n'));
  });

  it('builds last month’s P&L with channel and ad-platform breakdowns', async () => {
    const m = await db.withTenant(DEMO_ORG_ID, (tx) => getMonthlyPnl(tx, { month: '2026-09', channel: 'all' }));
    expect(m.current.netSales.cents).toBeGreaterThan(0);
    expect(m.previous.netSales.cents).toBeGreaterThan(0);
    expect(m.byAdPlatform.map((p) => p.platform).sort()).toEqual(['amazon_ads', 'google', 'meta']);
    expect(m.sameMonthLastYear).toBeNull();
    expect(m.costComplete).toBe(true);
    void run;
  });

  it('answers each report in under a few seconds on a full year of data', async () => {
    const started = Date.now();
    await db.withTenant(DEMO_ORG_ID, async (tx) => {
      await getOverview(tx, { range: resolveRange('90d', END).current, previous, channel: 'all' });
      await getProducts(tx, { range: current, channel: 'all', asOf: END });
      await getAttention(tx, { range: current, previous, asOf: END });
    });
    expect(Date.now() - started).toBeLessThan(8000);
  });
});
