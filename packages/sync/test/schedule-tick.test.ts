import {
  AuthError,
  SHOPIFY_RECONNECT_MESSAGE,
  decryptConnectionCredentials,
  encryptConnectionCredentials,
  type ShopifyRefreshGrant,
  type SyncResource,
} from '@erq/connectors';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runSchedulerTick } from '../src/schedule/tick';
import { createTokenService } from '../src/tokens';
import type { SyncPageJob } from '../src/ports';
import { makeHarness, resetSync } from './engine-helpers';
import { CONN_A, CONN_B, ORG_A, ORG_B, startEnv, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env?.stop();
});

const MIN = 60_000;
const T0 = Date.parse('2026-10-06T12:00:00Z'); // the harness clock
const at = (minAgo: number) => new Date(T0 - minAgo * MIN);

beforeEach(async () => {
  await resetSync(env);
  await env.owner.query(`delete from store_connections where external_account_id like 'cap-%'`);
  await env.owner.query(
    `update store_connections set status = 'active', last_error = null, encrypted_credentials = 'ciphertext',
       access_token_expires_at = null, refresh_token_expires_at = null`,
  );
});
afterEach(() =>
  env.owner.query(`delete from store_connections where external_account_id like 'cap-%'`),
);

type PerResource = Partial<
  Record<SyncResource, { agoMin?: number | null; status?: string; updatedAgoMin?: number }>
>;
async function seed(
  connectionId: string,
  orgId: string,
  o: {
    agoMin?: number;
    fullPassAgoMin?: number | null;
    per?: PerResource;
    only?: SyncResource[];
  } = {},
) {
  const all: SyncResource[] = ['locations', 'products', 'inventory', 'orders'];
  for (const resource of o.only ?? all) {
    const p = o.per?.[resource] ?? {};
    const ago = p.agoMin === undefined ? (o.agoMin ?? 120) : p.agoMin;
    await env.owner.query(
      `insert into sync_cursors (org_id, store_connection_id, resource, status, last_synced_at, last_full_pass_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        orgId,
        connectionId,
        resource,
        p.status ?? 'complete',
        ago === null ? null : at(ago),
        o.fullPassAgoMin === undefined
          ? at(10)
          : o.fullPassAgoMin === null
            ? null
            : at(o.fullPassAgoMin),
        at(p.updatedAgoMin ?? ago ?? 0),
      ],
    );
  }
}
const drainJobs = (h: ReturnType<typeof makeHarness>): SyncPageJob[] => {
  const jobs: SyncPageJob[] = [];
  for (let j = h.queue.take(); j; j = h.queue.take()) jobs.push(j.job);
  return jobs;
};
const runs = async () =>
  (
    await env.owner.query(
      `select connection_id, type, status from sync_runs order by started_at, id`,
    )
  ).rows;

describe('runSchedulerTick', () => {
  it('starts ONE incremental chain of the due resources in dependency order', async () => {
    const h = makeHarness(env);
    await seed(CONN_A, ORG_A, {
      agoMin: 5,
      per: { locations: { agoMin: 20 }, orders: { agoMin: 20 }, inventory: { agoMin: 30 } },
    });
    const summary = await runSchedulerTick(h.deps);
    expect(summary).toMatchObject({ connections: 1, enqueued: 1, failed: 0 });
    const jobs = drainJobs(h);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ orgId: ORG_A, connectionId: CONN_A, resource: 'locations' });
    expect(jobs[0]!.then).toEqual({ resources: ['orders'], mode: 'incremental', since: null }); // inventory (30 min) is not due
    expect((await runs()).map((r) => r.type)).toEqual(['incremental']);
  });
  it('includes inventory once 60 minutes have passed', async () => {
    const h = makeHarness(env);
    await seed(CONN_A, ORG_A, { agoMin: 5, per: { inventory: { agoMin: 61 } } });
    await runSchedulerTick(h.deps);
    expect(drainJobs(h)[0]).toMatchObject({ resource: 'inventory' });
  });
  it('splits the daily products pass into a full chain with the inventory that follows it', async () => {
    const h = makeHarness(env);
    await seed(CONN_A, ORG_A, {
      agoMin: 20,
      fullPassAgoMin: null,
      per: { inventory: { agoMin: 61 } },
    });
    const summary = await runSchedulerTick(h.deps);
    expect(summary).toMatchObject({ connections: 1, enqueued: 2 });
    const jobs = drainJobs(h);
    const incremental = jobs.find((j) => j.then?.mode === 'incremental')!;
    const full = jobs.find((j) => j.then?.mode === 'full' || j.resource === 'products')!;
    expect([incremental.resource, incremental.then?.resources]).toEqual(['locations', ['orders']]);
    expect([full.resource, full.then]).toEqual([
      'products',
      { resources: ['inventory'], mode: 'full', since: null },
    ]);
    expect((await runs()).map((r) => r.type).sort()).toEqual(['full', 'incremental']);
  });
  it('does nothing for a connection with a running cursor, one that never finished its backfill, or one that is fresh', async () => {
    const h = makeHarness(env);
    await seed(CONN_A, ORG_A, { agoMin: 120, per: { orders: { status: 'running' } } });
    await seed(CONN_B, ORG_B, { agoMin: 120, only: ['locations', 'products', 'inventory'] });
    const summary = await runSchedulerTick(h.deps);
    expect(summary).toMatchObject({ connections: 0, enqueued: 0, failed: 0 });
    expect(h.queue.size).toBe(0);
    expect(await runs()).toEqual([]);
  });
  it('is idempotent: a second tick right after finds the cursors running and starts nothing', async () => {
    const h = makeHarness(env);
    await seed(CONN_A, ORG_A);
    await runSchedulerTick(h.deps);
    expect(h.queue.size).toBeGreaterThan(0);
    const before = (await runs()).length;
    expect(await runSchedulerTick(h.deps)).toMatchObject({ connections: 0, enqueued: 0 });
    expect((await runs()).length).toBe(before);
  });
  it('waits after a failed attempt instead of retrying every tick', async () => {
    const h = makeHarness(env);
    await seed(CONN_A, ORG_A, {
      agoMin: 5,
      per: { orders: { status: 'failed', agoMin: 180, updatedAgoMin: 1 } },
    });
    expect(await runSchedulerTick(h.deps)).toMatchObject({ connections: 0, enqueued: 0 });
    await env.owner.query('delete from sync_cursors');
    await seed(CONN_A, ORG_A, {
      agoMin: 5,
      per: { orders: { status: 'failed', agoMin: 180, updatedAgoMin: 16 } },
    });
    expect(await runSchedulerTick(h.deps)).toMatchObject({ connections: 1, enqueued: 1 });
    expect(drainJobs(h)[0]).toMatchObject({ resource: 'orders' });
  });
  it('starts the oldest connection first', async () => {
    const h = makeHarness(env);
    await seed(CONN_A, ORG_A, { agoMin: 30 });
    await seed(CONN_B, ORG_B, { agoMin: 200 });
    await runSchedulerTick(h.deps);
    expect(drainJobs(h).map((j) => j.connectionId)).toEqual([CONN_B, CONN_A]);
  });
  it('starts at most 50 connections per tick; the rest follow on the next tick', async () => {
    const h = makeHarness(env);
    await env.owner.query(
      `insert into store_connections (id, org_id, platform, external_account_id, status, encrypted_credentials)
       select gen_random_uuid(), $1, 'shopify', 'cap-' || g || '.myshopify.com', 'active', 'ciphertext' from generate_series(1, 52) g`,
      [ORG_A],
    );
    await env.owner.query(
      `insert into sync_cursors (org_id, store_connection_id, resource, status, last_synced_at, last_full_pass_at, updated_at)
       select $1, c.id, r.resource, 'complete', $2, $3, $2
       from store_connections c cross join (values ('locations'::sync_resource), ('products'), ('inventory'), ('orders')) r(resource)
       where c.external_account_id like 'cap-%'`,
      [ORG_A, at(120), at(10)],
    );
    const first = await runSchedulerTick(h.deps);
    expect(first).toMatchObject({ connections: 50, enqueued: 50 });
    expect(h.queue.size).toBe(50);
    const second = await runSchedulerTick(h.deps);
    expect(second).toMatchObject({ connections: 2, enqueued: 2 });
    expect(h.queue.size).toBe(52);
  });
  it('one failing enqueue is counted and reported (sanitized) and does not stop the other connections', async () => {
    const h = makeHarness(env);
    await seed(CONN_A, ORG_A, { agoMin: 200 });
    await seed(CONN_B, ORG_B, { agoMin: 100 });
    const messages: string[] = [];
    const inner = h.deps.queue;
    h.deps.queue = {
      enqueue: async (job, opts) => {
        if (job.connectionId === CONN_A)
          throw new Error('redis down shpat_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE');
        return inner.enqueue(job, opts);
      },
    };
    const summary = await runSchedulerTick({ ...h.deps, onError: (m) => messages.push(m) });
    expect(summary).toMatchObject({ connections: 2, enqueued: 1, failed: 1 });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(CONN_A);
    expect(messages[0]).not.toContain('shpat_');
    const cursor = (
      await env.owner.query(
        `select status from sync_cursors where store_connection_id = $1 and resource = 'locations'`,
        [CONN_A],
      )
    ).rows[0];
    expect(cursor.status).toBe('failed'); // enqueueSync freed the cursor instead of leaving a ghost run
    expect((inner as unknown as { size: number }).size).toBe(1);
  });
  it("fails closed when a row's org does not own the connection (tenant isolation of the follow-up)", async () => {
    const h = makeHarness(env);
    await seed(CONN_A, ORG_A);
    const forged = ['locations', 'products', 'inventory', 'orders'].map((o_resource) => ({
      o_org_id: ORG_B,
      o_connection_id: CONN_A,
      o_resource,
      o_status: 'complete',
      o_last_synced_at: at(120),
      o_last_full_pass_at: at(10),
      o_updated_at: at(120),
    }));
    const messages: string[] = [];
    const deps = {
      ...h.deps,
      // Only the due query returns the forged rows; the idle-refresh query finds nothing.
      db: {
        ...env.db,
        pool: {
          query: async (text: string) => ({ rows: text.includes('app_list_due') ? forged : [] }),
        },
      } as unknown as typeof env.db,
      onError: (m: string) => messages.push(m),
    };
    const summary = await runSchedulerTick(deps);
    expect(summary).toMatchObject({ enqueued: 0, failed: 1 });
    expect(h.queue.size).toBe(0);
    expect(await runs()).toEqual([]);
  });
  it('re-registers webhooks only on the tick that starts the daily products pass, and a failure there does not stop the sync', async () => {
    const h = makeHarness(env);
    const calls: { orgId: string; connectionId: string }[] = [];
    await seed(CONN_A, ORG_A, { agoMin: 20, fullPassAgoMin: 60 }); // incremental only
    await runSchedulerTick({ ...h.deps, reconcileWebhooks: async (a) => void calls.push(a) });
    expect(calls).toEqual([]);

    await resetSync(env);
    await seed(CONN_A, ORG_A, { agoMin: 20, fullPassAgoMin: null }); // the daily pass is due
    const messages: string[] = [];
    const summary = await runSchedulerTick({
      ...h.deps,
      reconcileWebhooks: async (a) => {
        calls.push(a);
        throw new Error('shopify down shpat_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE');
      },
      onError: (m) => messages.push(m),
    });
    expect(calls).toEqual([{ orgId: ORG_A, connectionId: CONN_A }]);
    expect(summary).toMatchObject({ failed: 1, enqueued: 2 }); // the sync chains still started
    expect(messages[0]).not.toContain('shpat_');
  });
});

describe('idle refresh', () => {
  const grant: ShopifyRefreshGrant = {
    accessToken: 'shpat_idle_new_0123',
    scopes: [],
    accessTokenExpiresInSec: 3600,
    refreshToken: 'shprt_idle_new_0123456789',
    refreshTokenExpiresInSec: 7_776_000,
  };
  const SEED_RT = 'shprt_idle_seed_0123456789';
  async function seedIdle(h: ReturnType<typeof makeHarness>, refreshInDays: number) {
    const creds = {
      accessToken: 'shpat_idle_old_0123',
      accessTokenExpiresAt: new Date(T0 - 3 * 3_600_000).toISOString(),
      refreshToken: SEED_RT,
      refreshTokenExpiresAt: new Date(T0 + refreshInDays * 86_400_000).toISOString(),
    };
    await env.owner.query(
      `update store_connections set encrypted_credentials = $2, access_token_expires_at = $3, refresh_token_expires_at = $4 where id = $1`,
      [
        CONN_A,
        encryptConnectionCredentials(creds, h.keyProvider, CONN_A),
        creds.accessTokenExpiresAt,
        creds.refreshTokenExpiresAt,
      ],
    );
  }
  it('renews the pair of a shop that has nothing to sync but a refresh token expiring within 14 days', async () => {
    const h = makeHarness(env);
    await seedIdle(h, 10);
    const presented: string[] = [];
    h.deps.tokens = createTokenService({
      db: env.db,
      keyProvider: h.keyProvider,
      now: h.clock.now,
      refresh: async ({ refreshToken }) => {
        presented.push(refreshToken);
        return grant;
      },
    });
    const messages: string[] = [];
    const summary = await runSchedulerTick({ ...h.deps, onError: (m) => messages.push(m) });
    expect(summary).toMatchObject({ refreshed: 1, failed: 0 });
    expect(presented).toEqual([SEED_RT]);
    const { rows } = await env.owner.query(
      `select encrypted_credentials from store_connections where id = $1`,
      [CONN_A],
    );
    expect(
      (
        decryptConnectionCredentials(
          rows[0].encrypted_credentials,
          h.keyProvider,
          CONN_A,
        ) as Record<string, string>
      ).refreshToken,
    ).toBe(grant.refreshToken);
    expect(JSON.stringify(messages)).not.toContain(SEED_RT);
  });
  it('leaves a shop with more than 14 days on its refresh token alone', async () => {
    const h = makeHarness(env);
    await seedIdle(h, 60);
    let called = 0;
    h.deps.tokens = createTokenService({
      db: env.db,
      keyProvider: h.keyProvider,
      now: h.clock.now,
      refresh: async () => {
        called += 1;
        return grant;
      },
    });
    expect(await runSchedulerTick(h.deps)).toMatchObject({ refreshed: 0 });
    expect(called).toBe(0);
  });
  it('a final refusal marks the connection errored with the fixed reconnect text and no token in it', async () => {
    const h = makeHarness(env);
    await seedIdle(h, 10);
    h.deps.tokens = createTokenService({
      db: env.db,
      keyProvider: h.keyProvider,
      now: h.clock.now,
      refresh: async () => {
        throw new AuthError(SHOPIFY_RECONNECT_MESSAGE);
      },
    });
    expect(await runSchedulerTick(h.deps)).toMatchObject({ refreshed: 0, failed: 1 });
    const { rows } = await env.owner.query(
      `select status, last_error from store_connections where id = $1`,
      [CONN_A],
    );
    expect(rows[0]).toEqual({
      status: 'error',
      last_error: 'Shopify no longer accepts this connection. Reconnect the store.',
    });
    // an errored connection is not picked again on the next tick
    expect(await runSchedulerTick(h.deps)).toMatchObject({ refreshed: 0, failed: 0 });
  });
});
