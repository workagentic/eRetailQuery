// Each test starts from freshly seeded fixtures (see beforeEach), so tests do not depend on each other.
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConnectionsApi, type ConnectionsApi } from '../src';
import { startTestDatabase, type TestDatabase } from '../src/testing';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const SHOP = 'shared.myshopify.com';
const OTHER = 'other.myshopify.com';
let tdb: TestDatabase;
let owner: Pool;
let app: Pool;
let api: ConnectionsApi;

const conn = (org: string, shop: string, status: string, id: string) =>
  owner.query(
    `insert into store_connections (id, org_id, platform, external_account_id, status) values ($1, $2, 'shopify', $3, $4)`,
    [id, org, shop, status],
  );
const count = async (sql: string, params: unknown[]) =>
  (await owner.query(`select count(*)::int as n from ${sql}`, params)).rows[0].n as number;

const ids = {
  aDisc: 'aaaaaaaa-0000-4000-8000-000000000001',
  bDisc: 'bbbbbbbb-0000-4000-8000-000000000002',
  cActive: 'cccccccc-0000-4000-8000-000000000003',
  aOther: 'aaaaaaaa-0000-4000-8000-000000000004',
};

const seed = async () => {
  await owner.query('delete from oauth_states');
  await owner.query('delete from audit_log');
  await owner.query('delete from inventory_movements');
  await owner.query('delete from store_connections'); // cascades locations and the rest
  await owner.query('delete from skus');
  await owner.query('delete from products');
  await conn(A, SHOP, 'disconnected', ids.aDisc);
  await conn(B, SHOP, 'disconnected', ids.bDisc);
  await conn(C, SHOP, 'active', ids.cActive);
  await conn(A, OTHER, 'disconnected', ids.aOther);
  // ledger data on the connections to prove it is removed too
  await owner.query(`insert into products (id, org_id, title) values ($1, $1, 'P')`, [A]);
  await owner.query(
    `insert into skus (id, org_id, product_id, sku_code, selling_price_cents) values ($1, $1, $1, 'S', 100)`,
    [A],
  );
  await owner.query(
    `insert into locations (id, org_id, store_connection_id, external_id, name, type, source) values ($1, $2, $1, 'l', 'L', 'warehouse', 'shopify')`,
    [ids.aDisc, A],
  );
  await owner.query(
    `insert into inventory_movements (org_id, sku_id, location_id, delta, reason) values ($1, $1, $2, 1, 'adjustment')`,
    [A, ids.aDisc],
  );
  // an oauth state for the same shop name on a DIFFERENT platform must survive the platform-filtered delete
  await owner.query(
    `insert into oauth_states (org_id, user_id, platform, shop, nonce_hash, expires_at) values ($1, gen_random_uuid(), 'woocommerce', $2, 'h-woo', now() + interval '10 minutes')`,
    [A, SHOP],
  );
  await owner.query(
    `insert into oauth_states (org_id, user_id, platform, shop, nonce_hash, expires_at) values ($1, gen_random_uuid(), 'shopify', $2, 'h-shopify', now() + interval '10 minutes')`,
    [A, SHOP],
  );
};

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  for (const [org, slug] of [
    [A, 'a'],
    [B, 'b'],
    [C, 'c'],
  ]) {
    await owner.query(`insert into orgs (id, name, slug) values ($1, $2, $2)`, [org, slug]);
  }
  app = new Pool({ connectionString: tdb.appUrl });
  api = createConnectionsApi(app);
});
beforeEach(seed);
afterAll(async () => {
  await app?.end();
  await owner?.end();
  await tdb?.stop();
});

describe('app_purge_shop', () => {
  // Task 3 adds a unique index: a shop can have only ONE non-disconnected connection, so the 'error' case uses its own shop.
  it('purges every disconnected connection of the shop across orgs, never an active one', async () => {
    expect(await api.purgeShop('shopify', SHOP)).toBe(2);
    expect(await count('store_connections where id = any($1)', [[ids.aDisc, ids.bDisc]])).toBe(0);
    expect(await count('inventory_movements where location_id = $1', [ids.aDisc])).toBe(0);
    expect(await count('store_connections where id = $1', [ids.cActive])).toBe(1);
    expect(await count('store_connections where id = $1', [ids.aOther])).toBe(1);
    expect(await count('skus where id = $1', [A])).toBe(1);
  });
  it('writes one audit row per purged org and none for the untouched ones', async () => {
    await api.purgeShop('shopify', SHOP);
    const { rows } = await owner.query(
      `select org_id from audit_log where action = 'store_connection.purged' order by org_id`,
    );
    expect(rows.map((r) => r.org_id)).toEqual([A, B]);
  });
  it('the oauth_states delete is filtered by platform as well as shop', async () => {
    await api.purgeShop('shopify', SHOP);
    expect(
      await count(`oauth_states where org_id = $1 and platform = 'woocommerce' and shop = $2`, [
        A,
        SHOP,
      ]),
    ).toBe(1);
    expect(
      await count(`oauth_states where org_id = $1 and platform = 'shopify' and shop = $2`, [
        A,
        SHOP,
      ]),
    ).toBe(0);
  });
  it('filters by platform: a woocommerce connection with the same account id survives', async () => {
    const WOO = 'dddddddd-0000-4000-8000-000000000007';
    await owner.query(
      `insert into store_connections (id, org_id, platform, external_account_id, status) values ($1, $2, 'woocommerce', $3, 'disconnected')`,
      [WOO, A, SHOP],
    );
    expect(await api.purgeShop('shopify', SHOP)).toBe(2);
    expect(await count('store_connections where id = $1', [WOO])).toBe(1);
  });
  it('is a no-op (returns 0, no audit rows) for an unknown shop or when nothing is purgeable', async () => {
    await api.purgeShop('shopify', SHOP);
    const before = await count(`audit_log where action = 'store_connection.purged'`, []);
    expect(await api.purgeShop('shopify', 'nobody.myshopify.com')).toBe(0);
    expect(await api.purgeShop('shopify', SHOP)).toBe(0); // only the active connection is left
    expect(await count(`audit_log where action = 'store_connection.purged'`, [])).toBe(before);
  });
  it('also purges errored connections', async () => {
    const ERR = 'err.myshopify.com';
    await conn(A, ERR, 'error', 'aaaaaaaa-0000-4000-8000-000000000005');
    await conn(B, ERR, 'disconnected', 'bbbbbbbb-0000-4000-8000-000000000006');
    expect(await api.purgeShop('shopify', ERR)).toBe(2);
    expect(await count('store_connections where external_account_id = $1', [ERR])).toBe(0);
  });
  it('never purges a connection that is reinstalled (made active) while the purge is running', async () => {
    // The active-shop unique index allows only one live connection per shop, so move the seeded active one away.
    await owner.query(`update store_connections set external_account_id = $2 where id = $1`, [
      ids.cActive,
      'moved.myshopify.com',
    ]);
    const c1 = await owner.connect();
    const c2 = await owner.connect();
    try {
      await c1.query('begin');
      await c1.query(`update store_connections set status = 'active' where id = $1`, [ids.aDisc]);
      let settled = false;
      const purge = c2
        .query<{ n: number }>(`select app_purge_shop('shopify', $1) as n`, [SHOP])
        .finally(() => {
          settled = true;
        });
      await new Promise((r) => setTimeout(r, 500));
      // Only a timing hint: it cannot prove the purge waited. The assertions after the commit are what discriminate
      // (the reinstalled connection survives and only the other copy is purged).
      expect(settled, 'the purge settled before the reinstall committed').toBe(false);
      await c1.query('commit');
      const result = await Promise.race([
        purge,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('purge hung')), 10_000),
        ),
      ]);
      expect(result.rows[0]?.n).toBe(1); // only bDisc
      expect(await count('store_connections where id = $1', [ids.aDisc])).toBe(1);
      expect(await count('inventory_movements where location_id = $1', [ids.aDisc])).toBe(1);
      expect(await count('store_connections where id = $1', [ids.bDisc])).toBe(0);
    } finally {
      await c1.query('rollback').catch(() => undefined);
      c1.release();
      c2.release();
    }
  });
  it.each(['app_purge_shop', 'app_purge_store_connection'])(
    '%s has the standard definer hygiene',
    async (fn) => {
      const { rows } = await owner.query(
        `select has_function_privilege('public', p.oid, 'execute') as pub, has_function_privilege('app_user', p.oid, 'execute') as app,
                p.prosecdef, p.proconfig::text as cfg
           from pg_proc p where p.proname = $1`,
        [fn],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ pub: false, app: true, prosecdef: true });
      expect(rows[0].cfg).toContain('search_path=pg_catalog, public, pg_temp');
    },
  );
});
