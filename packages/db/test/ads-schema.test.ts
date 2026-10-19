import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenantDb, type TenantDb } from '../src';
import { startTestDatabase, type TestDatabase } from '../src/testing';
import { fixtures } from './fixtures';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let tdb: TestDatabase;
let owner: Pool;
let db: TenantDb;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  for (const org of [A, B]) for (const f of Object.values(fixtures)) await f(owner, org);
  db = createTenantDb(tdb.appUrl);
}, 120_000);
afterAll(async () => {
  await db?.close();
  await owner?.end();
  await tdb?.stop();
});

describe('ad campaigns and daily insights', () => {
  it('tenant B cannot read tenant A ad campaigns', async () => {
    const rows = await db.withTenant(B, (tx) =>
      tx.execute(sql.raw(`select org_id from ad_campaigns`)),
    );
    expect(rows.rows.every((r) => r.org_id === B)).toBe(true);
    expect(rows.rows.length).toBeGreaterThan(0);
  });
  it('ad_insights_daily rejects a second row for the same campaign and date', async () => {
    await expect(
      owner.query(
        `insert into ad_insights_daily (org_id, campaign_id, date, spend_cents) values ($1, $1, '2026-01-01', 100)`,
        [A],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
  it('a tenant-B campaign cannot use tenant A ad connection', async () => {
    await expect(
      db.withTenant(B, (tx) =>
        tx.execute(
          sql.raw(
            `insert into ad_campaigns (org_id, ad_connection_id, external_id, name) values ('${B}', '${A}', 'x', 'n')`,
          ),
        ),
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/foreign key constraint/) } });
  });
  it('orders accept channel amazon', async () => {
    await owner.query(
      `insert into orders (org_id, store_connection_id, external_order_id, channel, status, placed_at, currency,
         gross_cents, discount_cents, shipping_charged_cents, tax_cents, refund_cents, net_cents, external_updated_at)
       values ($1, $1, 'amz-1', 'amazon', 'open', now(), 'USD', 1000, 0, 0, 0, 0, 1000, now())`,
      [A],
    );
  });
  it('orders reject negative fee columns', async () => {
    await expect(
      owner.query(
        `insert into orders (org_id, store_connection_id, external_order_id, channel, status, placed_at, currency,
           gross_cents, discount_cents, shipping_charged_cents, tax_cents, refund_cents, net_cents, external_updated_at, payment_fee_cents)
         values ($1, $1, 'neg-1', 'shopify_online', 'open', now(), 'USD', 1000, 0, 0, 0, 0, 1000, now(), -1)`,
        [A],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('ad_connections accept the amazon_ads platform', async () => {
    await owner.query(
      `insert into ad_connections (org_id, platform, external_account_id, status) values ($1, 'amazon_ads', 'amz-ads', 'demo')`,
      [A],
    );
  });
});
