import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../src/testing';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const C2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const C3 = 'bbbbbbbb-0000-4000-8000-000000000003';
const RESOURCES = ['locations', 'products', 'inventory', 'orders'] as const;
let tdb: TestDatabase;
let owner: Pool;
let app: Pool;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  app = new Pool({ connectionString: tdb.appUrl });
  for (const org of [A, B]) {
    await owner.query(
      `insert into orgs (id, name, slug) values ($1, 'Org', 'org-' || ($1::uuid)::text)`,
      [org],
    );
  }
}, 120_000);
afterAll(async () => {
  await app?.end();
  await owner?.end();
  await tdb?.stop();
});
beforeEach(() => owner.query('delete from store_connections'));

async function addConnection(
  id: string,
  org: string,
  o: {
    status?: string;
    creds?: string | null;
    platform?: string;
    accessInMin?: number | null;
    refreshInDays?: number | null;
  } = {},
) {
  await owner.query(
    `insert into store_connections (id, org_id, platform, external_account_id, status, encrypted_credentials,
       access_token_expires_at, refresh_token_expires_at)
     values ($1, $2, $3, ($1::uuid)::text || '.myshopify.com', $4, $5,
       now() + make_interval(mins => $6), now() + make_interval(days => $7))`,
    [
      id,
      org,
      o.platform ?? 'shopify',
      o.status ?? 'active',
      o.creds === undefined ? 'ciphertext' : o.creds,
      o.accessInMin === undefined ? null : o.accessInMin,
      o.refreshInDays === undefined ? null : o.refreshInDays,
    ],
  );
}
/** `syncedMinAgo` null means never completed. updated_at is set on INSERT because the trigger only fires on UPDATE. */
async function addCursors(
  id: string,
  org: string,
  o: {
    syncedMinAgo?: number | null;
    fullPassMinAgo?: number | null;
    status?: string;
    updatedMinAgo?: number;
    only?: readonly string[];
    per?: Record<string, { status?: string; syncedMinAgo?: number | null; updatedMinAgo?: number }>;
  } = {},
) {
  for (const resource of o.only ?? RESOURCES) {
    const p = o.per?.[resource] ?? {};
    const synced =
      p.syncedMinAgo === undefined
        ? o.syncedMinAgo === undefined
          ? 120
          : o.syncedMinAgo
        : p.syncedMinAgo;
    await owner.query(
      `insert into sync_cursors (org_id, store_connection_id, resource, status, last_synced_at, last_full_pass_at, updated_at)
       values ($1, $2, $3, $4, now() - make_interval(mins => $5), now() - make_interval(mins => $6), now() - make_interval(mins => $7))`,
      [
        org,
        id,
        resource,
        p.status ?? o.status ?? 'complete',
        synced,
        o.fullPassMinAgo === undefined ? 10 : o.fullPassMinAgo,
        p.updatedMinAgo ?? o.updatedMinAgo ?? synced ?? 0,
      ],
    );
  }
}
const due = async (limit = 50) =>
  (await app.query('select * from app_list_due_sync_resources(now(), $1)', [limit])).rows;
const connectionsOf = (rows: { o_connection_id: string }[]) => [
  ...new Set(rows.map((r) => r.o_connection_id)),
];

describe('app_list_due_sync_resources', () => {
  it('lists the four cursors of every due connection across tenants, for app_user', async () => {
    await addConnection(C1, A);
    await addCursors(C1, A);
    await addConnection(C3, B);
    await addCursors(C3, B);
    const rows = await due();
    expect(connectionsOf(rows).sort()).toEqual([C1, C3]);
    expect(rows).toHaveLength(8);
    expect(rows.find((r) => r.o_connection_id === C1)).toMatchObject({
      o_org_id: A,
      o_status: 'complete',
    });
    expect(rows.find((r) => r.o_connection_id === C3)).toMatchObject({ o_org_id: B });
  });
  it('skips a connection with ANY running cursor', async () => {
    await addConnection(C1, A);
    await addCursors(C1, A, { per: { orders: { status: 'running' } } });
    expect(await due()).toEqual([]);
  });
  it('skips a connection that has not finished its first backfill (a missing row or a null time)', async () => {
    await addConnection(C1, A);
    await addCursors(C1, A, { only: ['locations', 'products', 'inventory'] });
    await addConnection(C2, A);
    await addCursors(C2, A, { per: { orders: { syncedMinAgo: null } } });
    expect(await due()).toEqual([]);
  });
  it.each(['error', 'disconnected', 'pending', 'demo'])('skips a %s connection', async (status) => {
    await addConnection(C1, A, { status });
    await addCursors(C1, A);
    expect(await due()).toEqual([]);
  });
  it('skips a connection without credentials and a platform other than shopify', async () => {
    await addConnection(C1, A, { creds: null });
    await addCursors(C1, A);
    await addConnection(C2, A, { platform: 'woocommerce' });
    await addCursors(C2, A);
    expect(await due()).toEqual([]);
  });
  it('lists nothing while everything is fresh, but lists a connection whose products full pass is due', async () => {
    await addConnection(C1, A);
    await addCursors(C1, A, { syncedMinAgo: 5, fullPassMinAgo: 60 });
    expect(await due()).toEqual([]);
    await owner.query(
      `update sync_cursors set last_full_pass_at = now() - interval '25 hours' where resource = 'products'`,
    );
    expect(connectionsOf(await due())).toEqual([C1]);
    await owner.query(
      `update sync_cursors set last_full_pass_at = null where resource = 'products'`,
    );
    expect(connectionsOf(await due())).toEqual([C1]);
  });
  it('backs off a failed cursor from its last attempt, not from its old completion time', async () => {
    await addConnection(C1, A);
    await addCursors(C1, A, {
      syncedMinAgo: 5,
      fullPassMinAgo: 60,
      per: { orders: { status: 'failed', syncedMinAgo: 180, updatedMinAgo: 1 } },
    });
    expect(await due()).toEqual([]);
    // The updated_at trigger fires on UPDATE, so back-date the attempt by inserting the cursors again.
    await owner.query('delete from sync_cursors');
    await addCursors(C1, A, {
      syncedMinAgo: 5,
      fullPassMinAgo: 60,
      per: { orders: { status: 'failed', syncedMinAgo: 180, updatedMinAgo: 16 } },
    });
    expect(connectionsOf(await due())).toEqual([C1]);
  });
  it('judges each resource by its OWN cadence, so connections whose only stale-ish resource is inventory cannot starve a due one (50 cap)', async () => {
    // 51 connections whose cursors are all 5 minutes old except inventory at 30 minutes: inventory is not due
    // until 60 minutes, so none of these is a candidate. A connection-wide "oldest cursor older than 15 minutes"
    // pre-filter would list all 51, fill the cap of 50 (oldest first) and hide the connection below.
    for (let i = 0; i < 51; i += 1) {
      const id = `dddddddd-0000-4000-8000-${String(i).padStart(12, '0')}`;
      await addConnection(id, A);
      await addCursors(id, A, {
        syncedMinAgo: 5,
        fullPassMinAgo: 60,
        per: { inventory: { syncedMinAgo: 30 } },
      });
    }
    const due20 = 'eeeeeeee-0000-4000-8000-000000000001';
    await addConnection(due20, A);
    await addCursors(due20, A, {
      syncedMinAgo: 5,
      fullPassMinAgo: 60,
      per: { orders: { syncedMinAgo: 20 } },
    });
    const listed = connectionsOf(await due(50));
    expect(listed).toEqual([due20]);
    // and inventory alone becomes a candidate at exactly its own cadence
    await owner.query(
      `update sync_cursors set last_synced_at = now() - interval '61 minutes' where resource = 'inventory' and store_connection_id = 'dddddddd-0000-4000-8000-000000000000'`,
    );
    expect(connectionsOf(await due(50)).sort()).toEqual(
      [due20, 'dddddddd-0000-4000-8000-000000000000'].sort(),
    );
  });
  it('returns the oldest connections first and honours the limit', async () => {
    await addConnection(C1, A);
    await addCursors(C1, A, { syncedMinAgo: 30 });
    await addConnection(C2, A);
    await addCursors(C2, A, { syncedMinAgo: 300 });
    await addConnection(C3, B);
    await addCursors(C3, B, { syncedMinAgo: 90 });
    expect(connectionsOf(await due())).toEqual([C2, C3, C1]);
    expect(connectionsOf(await due(2))).toEqual([C2, C3]);
    expect(connectionsOf(await due(0))).toEqual([C2]); // a limit below 1 still returns one connection
  });
});

describe('app_list_idle_refresh_connections', () => {
  const idle = async () =>
    (await app.query('select * from app_list_idle_refresh_connections(now(), 50)')).rows.map(
      (r) => r.o_connection_id,
    );
  it('lists active connections whose refresh token is within 14 days and whose access token is expired or about to be', async () => {
    await addConnection(C1, A, { accessInMin: -60, refreshInDays: 10 });
    await addConnection(C2, A, { accessInMin: 4, refreshInDays: 13 });
    await addConnection(C3, B, { accessInMin: -60, refreshInDays: 10 });
    expect((await idle()).sort()).toEqual([C1, C2, C3]);
  });
  it('skips a refresh token with more than 14 days left, an access token with more than 5 minutes left, no expiry data, and every non-active connection', async () => {
    await addConnection(C1, A, { accessInMin: -60, refreshInDays: 20 });
    await addConnection(C2, A, { accessInMin: 6, refreshInDays: 10 });
    await addConnection(C3, B, { accessInMin: null, refreshInDays: null });
    expect(await idle()).toEqual([]);
    for (const [i, status] of ['error', 'disconnected', 'pending', 'demo'].entries()) {
      const id = `cccccccc-0000-4000-8000-00000000000${i}`;
      await addConnection(id, A, { status, accessInMin: -60, refreshInDays: 10 });
    }
    expect(await idle()).toEqual([]);
  });
});

describe.each([
  'app_list_due_sync_resources(timestamptz, integer)',
  'app_list_idle_refresh_connections(timestamptz, integer)',
])('%s hardening', (fn) => {
  it('is SECURITY DEFINER with a pinned search_path, and executable by app_user only', async () => {
    const { rows } = await owner.query(
      `select prosecdef, proconfig from pg_proc where oid = $1::regprocedure`,
      [fn],
    );
    expect(rows[0].prosecdef).toBe(true);
    expect(rows[0].proconfig).toContain('search_path=pg_catalog, public, pg_temp');
    const priv = async (role: string) =>
      (
        await owner.query(`select has_function_privilege($1, $2::regprocedure, 'execute') as ok`, [
          role,
          fn,
        ])
      ).rows[0].ok;
    expect(await priv('public')).toBe(false);
    expect(await priv('app_user')).toBe(true);
  });
});
