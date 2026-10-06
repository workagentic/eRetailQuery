import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createConnectionsApi,
  createTenantDb,
  generateOAuthNonce,
  hashOAuthNonce,
  type ConnectionsApi,
  type TenantDb,
} from '../src';
import { startTestDatabase, type TestDatabase } from '../src/testing';
import { fixtures } from './fixtures';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const USER = '99999999-9999-4999-8999-999999999999';
let tdb: TestDatabase;
let owner: Pool;
let app: Pool;
let db: TenantDb;
let api: ConnectionsApi;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  for (const org of [A, B]) for (const f of Object.values(fixtures)) await f(owner, org);
  db = createTenantDb(tdb.appUrl);
  app = new Pool({ connectionString: tdb.appUrl });
  api = createConnectionsApi(app);
});
afterAll(async () => {
  await db?.close();
  await app?.end();
  await owner?.end();
  await tdb?.stop();
});

const insertState = (org: string, nonce: string, opts: { expires?: string; shop?: string } = {}) =>
  db.withTenant(org, (tx) =>
    tx.execute(
      sql.raw(
        `insert into oauth_states (org_id, user_id, platform, shop, nonce_hash, expires_at)
         values ('${org}', '${USER}', 'shopify', '${opts.shop ?? 'a.myshopify.com'}', '${hashOAuthNonce(nonce)}', ${opts.expires ?? "now() + interval '10 minutes'"})`,
      ),
    ),
  );

describe('oauth state consumption', () => {
  it('returns the state once and never again (single use)', async () => {
    const nonce = generateOAuthNonce();
    await insertState(A, nonce);
    expect(await api.consumeOAuthState(hashOAuthNonce(nonce))).toEqual({
      orgId: A,
      userId: USER,
      shop: 'a.myshopify.com',
    });
    expect(await api.consumeOAuthState(hashOAuthNonce(nonce))).toBeNull();
  });
  it('refuses expired and unknown nonces', async () => {
    const nonce = generateOAuthNonce();
    await insertState(A, nonce, { expires: "now() - interval '1 second'" });
    expect(await api.consumeOAuthState(hashOAuthNonce(nonce))).toBeNull();
    expect(await api.consumeOAuthState(hashOAuthNonce('never-issued'))).toBeNull();
  });
  it('rejects two states with the same nonce hash', async () => {
    const nonce = generateOAuthNonce();
    await insertState(A, nonce);
    await expect(insertState(B, nonce)).rejects.toThrow();
  });
});

describe('store connection lookup', () => {
  it('finds a connection by platform and shop without any org context, returning ids only', async () => {
    const found = await api.findStoreConnection('shopify', `shop-${A}`);
    expect(found).toEqual({ orgId: A, connectionId: A, status: 'demo' });
    expect(Object.keys(found!).sort()).toEqual(['connectionId', 'orgId', 'status']);
    expect(await api.findStoreConnection('shopify', 'nobody.myshopify.com')).toBeNull();
  });
});

describe('webhook_events', () => {
  const insertEvent = (org: string, extId: string) =>
    db.withTenant(org, (tx) =>
      tx.execute(
        sql.raw(
          `insert into webhook_events (org_id, store_connection_id, topic, external_event_id, payload)
           values ('${org}', '${org}', 'orders/updated', '${extId}', '{"id":1}')
           on conflict do nothing returning id`,
        ),
      ),
    );
  it('stores a delivery once (unique per connection and external id)', async () => {
    await insertEvent(A, 'dup-1');
    await insertEvent(A, 'dup-1');
    const { rows } = await owner.query(
      `select count(*)::int as n from webhook_events where org_id = $1 and external_event_id = 'dup-1'`,
      [A],
    );
    expect(rows[0].n).toBe(1);
  });
  it('a tenant-B event cannot point at a tenant-A connection', async () => {
    await expect(
      db.withTenant(B, (tx) =>
        tx.execute(
          sql.raw(
            `insert into webhook_events (org_id, store_connection_id, topic, external_event_id, payload) values ('${B}', '${A}', 't', 'x', '{}')`,
          ),
        ),
      ),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/foreign key constraint/) },
    });
  });
  it('lists old received and stale processing events, oldest first, across tenants', async () => {
    await owner.query(`delete from webhook_events`);
    await owner.query(
      `insert into webhook_events (org_id, store_connection_id, topic, external_event_id, payload, received_at, status) values
        ($1, $1, 't', 'old-a', '{}', now() - interval '1 hour', 'received'),
        ($2, $2, 't', 'old-b', '{}', now() - interval '2 hours', 'received'),
        ($1, $1, 't', 'fresh', '{}', now(), 'received'),
        ($1, $1, 't', 'done', '{}', now() - interval '3 hours', 'processed'),
        ($1, $1, 't', 'deferred', '{}', now() - interval '3 hours', 'deferred'),
        ($1, $1, 't', 'failed', '{}', now() - interval '3 hours', 'failed')`,
      [A, B],
    );
    await owner.query(
      `insert into webhook_events (org_id, store_connection_id, topic, external_event_id, payload, status, updated_at) values
        ($1, $1, 't', 'stuck', '{}', 'processing', now() - interval '30 minutes'),
        ($1, $1, 't', 'busy', '{}', 'processing', now())`,
      [A],
    );
    await owner.query(
      `update webhook_events set updated_at = now() - interval '4 hours' where status in ('processed','deferred','failed')`,
    );
    const stale = await api.listStaleWebhookEvents(new Date(Date.now() - 10 * 60_000), 10);
    expect(stale.map((e) => e.orgId)).toEqual([B, A, A]);
    const ids = (
      await owner.query(
        `select id from webhook_events where external_event_id in ('old-a','stuck')`,
      )
    ).rows.map((r) => r.id);
    expect(
      stale
        .slice(1)
        .map((e) => e.eventId)
        .sort(),
    ).toEqual(ids.sort());
    expect(await api.listStaleWebhookEvents(new Date(Date.now() - 10 * 60_000), 1)).toHaveLength(1);
  });
});

describe('definer function hygiene', () => {
  it('pins search_path, is not executable by PUBLIC and is executable by app_user', async () => {
    const { rows } = await owner.query(
      `select p.proname, p.prosecdef, p.proconfig::text as cfg,
              has_function_privilege('public', p.oid, 'execute') as pub,
              has_function_privilege('app_user', p.oid, 'execute') as app
         from pg_proc p where p.proname in ('app_consume_oauth_state','app_find_store_connection','app_list_stale_webhook_events')`,
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.prosecdef).toBe(true);
      expect(r.cfg).toContain('search_path=pg_catalog, public, pg_temp');
      expect(r.pub).toBe(false);
      expect(r.app).toBe(true);
    }
  });
});
