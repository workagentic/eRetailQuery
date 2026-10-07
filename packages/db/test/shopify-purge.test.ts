import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConnectionsApi, type ConnectionsApi } from '../src';
import { startTestDatabase, type TestDatabase } from '../src/testing';
import { fixtures } from './fixtures';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const A2 = '33333333-3333-4333-8333-333333333333'; // a second connection in org A
let tdb: TestDatabase;
let owner: Pool;
let app: Pool;
let api: ConnectionsApi;

const count = async (table: string, where: string, params: unknown[]) =>
  (await owner.query(`select count(*)::int as n from ${table} where ${where}`, params)).rows[0]
    .n as number;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  for (const org of [A, B]) for (const f of Object.values(fixtures)) await f(owner, org);
  // A second store connection in org A with its own location, level, movement, order, sync run and event.
  await owner.query(
    `insert into store_connections (id, org_id, platform, external_account_id, status) values ($1, $2, 'shopify', 'second.myshopify.com', 'active')`,
    [A2, A],
  );
  await owner.query(
    `insert into locations (id, org_id, store_connection_id, external_id, name, type, source) values ($1, $2, $1, 'loc2', 'Second', 'warehouse', 'shopify')`,
    [A2, A],
  );
  await owner.query(
    `insert into inventory_levels (org_id, sku_id, location_id, on_hand) values ($1, $1, $2, 3)`,
    [A, A2],
  );
  await owner.query(
    `insert into inventory_movements (org_id, sku_id, location_id, delta, reason) values ($1, $1, $2, 3, 'adjustment')`,
    [A, A2],
  );
  await owner.query(
    `insert into webhook_events (org_id, store_connection_id, topic, external_event_id, payload) values ($1, $2, 't', 'e-second', '{}')`,
    [A, A2],
  );
  await owner.query(
    `insert into orders (org_id, store_connection_id, external_order_id, channel, status, placed_at, currency,
                         gross_cents, discount_cents, shipping_charged_cents, tax_cents, refund_cents, net_cents, external_updated_at)
     values ($1, $2, 'o-second', 'shopify_online', 'open', now(), 'USD', 500, 0, 0, 0, 0, 500, now())`,
    [A, A2],
  );
  // OAuth states in org A: one for the shop about to be purged, one for the second connection's shop.
  await owner.query(
    `insert into oauth_states (org_id, user_id, platform, shop, nonce_hash, expires_at) values
       ($1, gen_random_uuid(), 'shopify', 'shop-' || ($1::uuid)::text, 'hash-purged-shop', now() + interval '10 minutes'),
       ($1, gen_random_uuid(), 'shopify', 'second.myshopify.com', 'hash-second-shop', now() + interval '10 minutes'),
       ($1, gen_random_uuid(), 'woocommerce', 'shop-' || ($1::uuid)::text, 'hash-woo-same-name', now() + interval '10 minutes')`,
    [A],
  );
  // The fixture sync_run points at a random connection id; add one that really belongs to each connection.
  await owner.query(
    `insert into sync_runs (org_id, connection_kind, connection_id, type, status) values ($1, 'store', $1, 'backfill', 'running'), ($1, 'store', $2, 'backfill', 'running')`,
    [A, A2],
  );
  app = new Pool({ connectionString: tdb.appUrl });
  api = createConnectionsApi(app);
});
afterAll(async () => {
  await app?.end();
  await owner?.end();
  await tdb?.stop();
});

describe('app_purge_store_connection', () => {
  it('removes one connection including its ledger rows and touches nothing else', async () => {
    await api.purgeStoreConnection(A, A); // the fixture connection of org A (id = org id)
    for (const [table, col] of [
      ['store_connections', 'id'],
      ['locations', 'store_connection_id'],
      ['orders', 'store_connection_id'],
      ['sync_cursors', 'store_connection_id'],
      ['webhook_events', 'store_connection_id'],
      ['sku_channel_listings', 'store_connection_id'],
    ] as const) {
      expect(await count(table, `${col} = $1 and org_id = $2`, [A, A]), table).toBe(0);
    }
    expect(await count('inventory_movements', `org_id = $1 and location_id = $1`, [A])).toBe(0);
    expect(await count('inventory_levels', `org_id = $1 and location_id = $1`, [A])).toBe(0);
    expect(await count('sync_runs', `org_id = $1 and connection_id = $1`, [A])).toBe(0);
    // untouched: the other connection of the same org, org B, and the org's catalog
    expect(await count('store_connections', `id = $1`, [A2])).toBe(1);
    expect(await count('inventory_movements', `location_id = $1`, [A2])).toBe(1);
    expect(await count('sync_runs', `org_id = $1 and connection_id = $2`, [A, A2])).toBe(1);
    expect(await count('webhook_events', `store_connection_id = $1`, [A2])).toBe(1);
    expect(await count('inventory_levels', `location_id = $1`, [A2])).toBe(1);
    expect(await count('orders', `store_connection_id = $1`, [A2])).toBe(1);
    // only the purged shop's OAuth states go; the org's other shops keep theirs
    expect(
      await count(
        'oauth_states',
        `org_id = $1 and platform = 'shopify' and shop = 'shop-' || ($1::uuid)::text`,
        [A],
      ),
    ).toBe(0);
    // a state on another platform with the same shop name survives the platform-filtered delete
    expect(
      await count(
        'oauth_states',
        `org_id = $1 and platform = 'woocommerce' and shop = 'shop-' || ($1::uuid)::text`,
        [A],
      ),
    ).toBe(1);
    expect(await count('oauth_states', `org_id = $1 and shop = 'second.myshopify.com'`, [A])).toBe(
      1,
    );
    expect(await count('oauth_states', `org_id = $1 and shop = 'fixture.myshopify.com'`, [A])).toBe(
      1,
    );
    expect(await count('store_connections', `org_id = $1`, [B])).toBe(1);
    expect(await count('orders', `org_id = $1`, [B])).toBe(1);
    expect(await count('skus', `org_id = $1`, [A])).toBe(1);
    expect(await count('sku_cost_components', `org_id = $1`, [A])).toBe(1);
  });
  it('writes one audit row without an actor', async () => {
    const { rows } = await owner.query(
      `select actor_user_id, entity_id, after_json from audit_log where org_id = $1 and action = 'store_connection.purged'`,
      [A],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_user_id).toBeNull();
    expect(rows[0].entity_id).toBe(A);
    expect(rows[0].after_json).toEqual({ reason: 'shop_redact' });
  });
  it('is a no-op for an unknown connection or the wrong org (no error, no audit row)', async () => {
    const before = await count('audit_log', `action = 'store_connection.purged'`, []);
    await api.purgeStoreConnection(B, A2); // A2 belongs to org A, not B
    await api.purgeStoreConnection(A, A); // already gone
    expect(await count('store_connections', `id = $1`, [A2])).toBe(1);
    expect(await count('audit_log', `action = 'store_connection.purged'`, [])).toBe(before);
  });
  it('is not callable by PUBLIC and app_user still cannot delete the ledger directly', async () => {
    const { rows } = await owner.query(
      `select has_function_privilege('public', p.oid, 'execute') as pub, has_function_privilege('app_user', p.oid, 'execute') as app, p.prosecdef, p.proconfig::text as cfg
         from pg_proc p where p.proname = 'app_purge_store_connection'`,
    );
    expect(rows[0]).toMatchObject({ pub: false, app: true, prosecdef: true });
    expect(rows[0].cfg).toContain('search_path=pg_catalog, public, pg_temp');
    const c = await app.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.org_id', $1, true)`, [A]);
      await expect(c.query('delete from inventory_movements')).rejects.toThrow(/permission denied/);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});
