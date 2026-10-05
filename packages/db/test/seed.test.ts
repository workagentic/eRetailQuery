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
  expect(rows.every((r) => Number.isInteger(r.selling_price_cents) && r.selling_price_cents > r.landed)).toBe(true);
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
