import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { DEMO_ORG_ID, seedDemoOrg } from '../src/seed';
import { startTestDatabase, type TestDatabase } from '../src/testing';

let tdb: TestDatabase;
let owner: Pool;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

async function counts() {
  const { rows } = await owner.query(
    `select (select count(*) from orgs where id = $1)::int orgs,
            (select count(*) from org_members where org_id = $1)::int members,
            (select count(*) from store_connections where org_id = $1)::int conns,
            (select count(*) from skus where org_id = $1)::int skus,
            (select count(*) from sku_cost_components where org_id = $1)::int costs`,
    [DEMO_ORG_ID],
  );
  return rows[0];
}

it('creates a demo org with 3 members, 3 connections and 200 SKUs with costs', async () => {
  await seedDemoOrg(tdb.ownerUrl);
  const c = await counts();
  expect(c).toMatchObject({ orgs: 1, members: 3, conns: 3, skus: 200 });
  expect(c.costs).toBeGreaterThanOrEqual(600);
});

it('is idempotent', async () => {
  const before = await counts();
  await seedDemoOrg(tdb.ownerUrl);
  expect(await counts()).toEqual(before);
});

it('prices every SKU above its current landed cost, in integer cents', async () => {
  const { rows } = await owner.query(
    `select s.sku_code, s.selling_price_cents, sum(c.amount_cents)::int as landed
     from skus s join sku_cost_components c on c.sku_id = s.id and c.effective_to is null
     where s.org_id = $1 group by s.id`,
    [DEMO_ORG_ID],
  );
  expect(rows).toHaveLength(200);
  expect(
    rows.every((r) => {
      const price = Number(r.selling_price_cents);
      return Number.isSafeInteger(price) && price > r.landed;
    }),
  ).toBe(true);
});

it('includes SKUs whose product cost changed over time (time-versioned)', async () => {
  const { rows } = await owner.query(
    `select count(*)::int n from (
       select sku_id from sku_cost_components
       where org_id = $1 and component_type = 'product_cost' group by sku_id having count(*) > 1) t`,
    [DEMO_ORG_ID],
  );
  expect(rows[0].n).toBeGreaterThan(0);
});

it('seeds Shopify and Amazon orders, fees, inventory and ad insights for the demo org', async () => {
  const { rows } = await owner.query(
    `select (select count(*) from orders where org_id = $1 and channel = 'shopify_online')::int shopify,
            (select count(*) from orders where org_id = $1 and channel = 'amazon')::int amazon,
            (select count(*) from order_lines where org_id = $1 and unit_cogs_cents_snapshot is null)::int unpriced,
            (select count(*) from inventory_levels where org_id = $1)::int levels,
            (select count(*) from ad_campaigns where org_id = $1)::int campaigns,
            (select count(*) from ad_insights_daily where org_id = $1)::int insights`,
    [DEMO_ORG_ID],
  );
  expect(rows[0].shopify).toBeGreaterThan(1500);
  expect(rows[0].amazon).toBeGreaterThan(1000);
  expect(rows[0].unpriced).toBe(0);
  expect(rows[0].levels).toBe(400);
  expect(rows[0].campaigns).toBe(8);
  expect(rows[0].insights).toBe(8 * 365);
});

it('seeds a full year in under 60 seconds', async () => {
  const started = Date.now();
  await seedDemoOrg(tdb.ownerUrl);
  expect(Date.now() - started).toBeLessThan(60_000);
}, 120_000);
