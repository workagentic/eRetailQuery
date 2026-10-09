import {
  AuthError,
  PermanentError,
  RateLimitedError,
  SHOPIFY_RECONNECT_MESSAGE,
  TransientError,
  encryptConnectionCredentials,
  type ShopifyRefreshGrant,
  type SyncResource,
} from '@erq/connectors';
import { sampleData } from '@erq/connectors/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enqueueSync } from '../src/engine/start';
import { failSyncRun, IMPORT_NOT_STARTED_MESSAGE } from '../src/engine/fail';
import { processSyncPage } from '../src/engine/process';
import { resumeStalledRuns } from '../src/engine/resume';
import type { RateLimiter, SyncPageJob } from '../src/ports';
import { createTokenService } from '../src/tokens';
import { drain, makeHarness, resetSync } from './engine-helpers';
import { CONN_A, ORG_A, ORG_B, seedOrder, startEnv, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env?.stop();
});
beforeEach(async () => {
  await resetSync(env);
});

const since = new Date('2026-01-01T00:00:00Z');
const cursorRow = async (resource: string) =>
  (
    await env.owner.query(
      `select * from sync_cursors where store_connection_id = $1 and resource = $2`,
      [CONN_A, resource],
    )
  ).rows[0];
const runRow = async (id: string) =>
  (await env.owner.query(`select * from sync_runs where id = $1`, [id])).rows[0];
async function start(
  h: ReturnType<typeof makeHarness>,
  resource: 'locations' | 'products' | 'inventory' | 'orders',
  mode: 'backfill' | 'incremental' = 'backfill',
): Promise<SyncPageJob> {
  await enqueueSync(h.deps, {
    orgId: ORG_A,
    connectionId: CONN_A,
    resources: [resource],
    mode,
    since: mode === 'backfill' ? since : undefined,
  });
  return h.queue.take()!.job;
}

async function waitUntilBlocked(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const { rows } = await env.owner.query(
      `select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
    );
    if (rows.length > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the chain end never waited for the connection row lock');
}

describe('enqueueSync', () => {
  it('creates a run, a running cursor row and the first page job', async () => {
    const h = makeHarness(env);
    const r = await enqueueSync(h.deps, {
      orgId: ORG_A,
      connectionId: CONN_A,
      resources: ['orders'],
      mode: 'backfill',
      since,
    });
    expect(r).toMatchObject({ resource: 'orders', started: true });
    expect(h.queue.size).toBe(1);
    const c = await cursorRow('orders');
    expect([c.status, c.current_sync_run_id, c.cursor]).toEqual(['running', r.syncRunId, null]);
    expect(c.backfill_since.toISOString()).toBe(since.toISOString());
    expect(await runRow(r.syncRunId)).toMatchObject({
      type: 'backfill',
      status: 'running',
      connection_kind: 'store',
    });
  });
  it('needs only the db, the queue and the clock', async () => {
    const h = makeHarness(env);
    const { db, queue, now } = h.deps;
    const r = await enqueueSync(
      { db, queue, now },
      { orgId: ORG_A, connectionId: CONN_A, resources: ['locations'], mode: 'incremental' },
    );
    expect(r).toMatchObject({ resource: 'locations', started: true });
    expect(h.queue.size).toBe(1);
  });
  it('fails the run and frees the cursor when the first job cannot be queued, then lets a retry start', async () => {
    const h = makeHarness(env);
    const failing = {
      db: h.deps.db,
      now: h.deps.now,
      queue: {
        enqueue: async () => {
          throw new Error('redis is down');
        },
      },
    };
    const args = {
      orgId: ORG_A,
      connectionId: CONN_A,
      resources: ['orders' as const],
      mode: 'backfill' as const,
      since,
    };
    await expect(enqueueSync(failing, args)).rejects.toThrow('redis is down');
    const c = await cursorRow('orders');
    expect(c.status).toBe('failed');
    expect(c.current_sync_run_id).toBeNull();
    const runs = (await env.owner.query(`select status, error, finished_at from sync_runs`)).rows;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'failed' });
    expect(runs[0].error).toContain('redis is down');
    expect(runs[0].finished_at).not.toBeNull();
    const retry = await enqueueSync(h.deps, args);
    expect(retry.started).toBe(true);
    expect(h.queue.size).toBe(1);
  });
  it('allows one active run per connection and resource', async () => {
    const h = makeHarness(env);
    const a = await enqueueSync(h.deps, {
      orgId: ORG_A,
      connectionId: CONN_A,
      resources: ['orders'],
      mode: 'backfill',
      since,
    });
    const b = await enqueueSync(h.deps, {
      orgId: ORG_A,
      connectionId: CONN_A,
      resources: ['orders'],
      mode: 'backfill',
      since,
    });
    expect(b).toEqual({ resource: 'orders', syncRunId: a.syncRunId, started: false });
    expect(h.queue.size).toBe(1);
  });
  it('runs "all" in dependency order, chaining the rest', async () => {
    const h = makeHarness(env);
    const r = await enqueueSync(h.deps, {
      orgId: ORG_A,
      connectionId: CONN_A,
      resources: 'all',
      mode: 'backfill',
      since,
    });
    expect(r.resource).toBe('locations');
    expect(h.queue.take()!.job.then).toEqual({
      resources: ['products', 'inventory', 'orders'],
      mode: 'backfill',
      since: since.toISOString(),
    });
    expect(await cursorRow('products')).toBeUndefined(); // later resources start when their predecessor finishes
  });
  it('sorts explicit resources into dependency order', async () => {
    const h = makeHarness(env);
    const r = await enqueueSync(h.deps, {
      orgId: ORG_A,
      connectionId: CONN_A,
      resources: ['orders', 'products'],
      mode: 'backfill',
      since,
    });
    expect(r.resource).toBe('products');
  });
  it('requires since for backfill, and clears it for incremental runs', async () => {
    const h = makeHarness(env);
    await expect(
      enqueueSync(h.deps, {
        orgId: ORG_A,
        connectionId: CONN_A,
        resources: ['orders'],
        mode: 'backfill',
      }),
    ).rejects.toThrow(RangeError);
    await enqueueSync(h.deps, {
      orgId: ORG_A,
      connectionId: CONN_A,
      resources: ['orders'],
      mode: 'incremental',
    });
    expect((await cursorRow('orders')).backfill_since).toBeNull();
  });
  it("rejects a missing connection and another tenant's connection", async () => {
    const h = makeHarness(env);
    await expect(
      enqueueSync(h.deps, {
        orgId: ORG_B,
        connectionId: CONN_A,
        resources: ['orders'],
        mode: 'incremental',
      }),
    ).rejects.toBeInstanceOf(PermanentError);
    await expect(
      enqueueSync(h.deps, {
        orgId: ORG_A,
        connectionId: '00000000-0000-4000-8000-000000000000',
        resources: ['orders'],
        mode: 'incremental',
      }),
    ).rejects.toBeInstanceOf(PermanentError);
    expect(h.queue.size).toBe(0);
  });
});

describe('processSyncPage', () => {
  it('writes a page and the cursor in one step, then asks for the next page', async () => {
    const h = makeHarness(env);
    const job = await start(h, 'products');
    const result = await processSyncPage(h.deps, job);
    expect(result).toEqual({ kind: 'next', job });
    const c = await cursorRow('products');
    expect([c.cursor, Number(c.records_processed), c.status]).toEqual(['2', 2, 'running']);
    expect(
      Number(
        (
          await env.owner.query(`select count(*) c from sku_channel_listings where org_id = $1`, [
            ORG_A,
          ])
        ).rows[0].c,
      ),
    ).toBeGreaterThanOrEqual(3);
  });
  it('completes on the last page: cursor complete, run succeeded, watermark = run start', async () => {
    const h = makeHarness(env);
    const job = await start(h, 'locations');
    expect(await processSyncPage(h.deps, job)).toEqual({ kind: 'done' });
    const c = await cursorRow('locations');
    expect([c.status, c.cursor, c.current_sync_run_id, Number(c.records_processed)]).toEqual([
      'complete',
      null,
      null,
      2,
    ]);
    expect(c.updated_since.toISOString()).toBe('2026-10-06T12:00:00.000Z');
    expect(c.last_synced_at.toISOString()).toBe('2026-10-06T12:00:00.000Z');
    expect(await runRow(job.syncRunId)).toMatchObject({
      status: 'succeeded',
      records_processed: 2,
    });
  });
  it('ignores stale jobs (finished run or wrong run id)', async () => {
    const h = makeHarness(env);
    const job = await start(h, 'locations');
    await processSyncPage(h.deps, job);
    const before = h.connector.calls.length;
    expect(await processSyncPage(h.deps, job)).toEqual({ kind: 'done' }); // run already finished
    expect(
      await processSyncPage(h.deps, { ...job, syncRunId: '00000000-0000-4000-8000-000000000001' }),
    ).toEqual({ kind: 'done' });
    expect(h.connector.calls.length).toBe(before);
  });
  it("another tenant cannot process or touch this connection's job", async () => {
    const h = makeHarness(env);
    const job = await start(h, 'locations');
    expect(await processSyncPage(h.deps, { ...job, orgId: ORG_B })).toEqual({ kind: 'done' });
    expect(h.connector.calls.length).toBe(0);
    expect((await cursorRow('locations')).status).toBe('running');
  });
  it('delays without calling the connector when the rate limiter is empty', async () => {
    const limiter: RateLimiter = { take: async () => ({ allowed: false, retryAfterMs: 1500 }) };
    const h = makeHarness(env, { deps: { limiter } });
    const job = await start(h, 'locations');
    expect(await processSyncPage(h.deps, job)).toEqual({ kind: 'delayed', delayMs: 1500 });
    expect(h.connector.calls.length).toBe(0);
    expect((await cursorRow('locations')).status).toBe('running');
  });
  it('delays on a RateLimitedError from the platform and keeps the cursor', async () => {
    const h = makeHarness(env);
    const job = await start(h, 'products');
    h.connector.failNext(new RateLimitedError(2000));
    expect(await processSyncPage(h.deps, job)).toEqual({ kind: 'delayed', delayMs: 2000 });
    expect((await cursorRow('products')).cursor).toBeNull();
  });
  it('marks the connection errored on an AuthError and stops the run', async () => {
    const h = makeHarness(env);
    const job = await start(h, 'products');
    h.connector.failNext(new AuthError('token revoked'));
    const result = await processSyncPage(h.deps, job);
    expect(result).toMatchObject({ kind: 'failed' });
    const conn = (
      await env.owner.query(`select status, last_error from store_connections where id = $1`, [
        CONN_A,
      ])
    ).rows[0];
    expect(conn).toEqual({ status: 'error', last_error: 'token revoked' });
    expect(await cursorRow('products')).toMatchObject({
      status: 'failed',
      last_error: 'token revoked',
    });
    expect(await runRow(job.syncRunId)).toMatchObject({ status: 'failed', error: 'token revoked' });
    await env.owner.query(
      `update store_connections set status = 'active', last_error = null where id = $1`,
      [CONN_A],
    );
  });
  it('fails the run on a PermanentError without touching the connection', async () => {
    const h = makeHarness(env);
    const job = await start(h, 'products');
    h.connector.failNext(new PermanentError('bad request'));
    expect(await processSyncPage(h.deps, job)).toEqual({ kind: 'failed', reason: 'bad request' });
    expect(
      (await env.owner.query(`select status from store_connections where id = $1`, [CONN_A]))
        .rows[0].status,
    ).toBe('active');
    expect((await cursorRow('products')).status).toBe('failed');
  });
  it('rethrows a TransientError and leaves cursor and data untouched (the queue retries)', async () => {
    const h = makeHarness(env);
    const job = await start(h, 'products');
    h.connector.failNext(new TransientError('503'));
    await expect(processSyncPage(h.deps, job)).rejects.toBeInstanceOf(TransientError);
    expect((await cursorRow('products')).cursor).toBeNull();
    expect(await processSyncPage(h.deps, job)).toEqual({ kind: 'next', job }); // the retry succeeds
  });
  it('fails permanently when the data violates a database rule', async () => {
    const data = sampleData();
    data.orders[2]!.refunds[0]!.lines[0]!.quantity = 5; // refund 5 units of a 1-unit line
    const h = makeHarness(env, { data, pageSize: 50 });
    const prod = await start(h, 'products');
    await processSyncPage(h.deps, prod);
    const job = await start(h, 'orders');
    const result = await processSyncPage(h.deps, job);
    expect(result.kind).toBe('failed');
    expect((await cursorRow('orders')).status).toBe('failed');
    expect(
      Number(
        (await env.owner.query(`select count(*) c from orders where org_id = $1`, [ORG_A])).rows[0]
          .c,
      ),
    ).toBe(0); // the page rolled back
  });
  it('decrypts stored credentials for the connector and never puts them in job data', async () => {
    const h = makeHarness(env);
    await env.owner.query(`update store_connections set encrypted_credentials = $1 where id = $2`, [
      encryptConnectionCredentials({ accessToken: 'shpat_x' }, h.keyProvider, CONN_A),
      CONN_A,
    ]);
    const job = await start(h, 'locations');
    expect(JSON.stringify(job)).not.toContain('shpat_x');
    await processSyncPage(h.deps, job);
    expect(h.connector.calls[0]!.credentials).toEqual({ accessToken: 'shpat_x' });
    await env.owner.query(
      `update store_connections set encrypted_credentials = null where id = $1`,
      [CONN_A],
    );
  });
  it('commits a page once even if two workers hold the same job (compare-and-set on the cursor)', async () => {
    const h = makeHarness(env);
    const job = await start(h, 'products');
    let waiting = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    const inner = h.connector.fetchPage.bind(h.connector);
    h.connector.fetchPage = (async (...args: Parameters<typeof inner>) => {
      if (++waiting === 2) release();
      await barrier; // both workers have read cursor = null before either commits
      return inner(...args);
    }) as typeof inner;
    const [a, b] = await Promise.all([processSyncPage(h.deps, job), processSyncPage(h.deps, job)]);
    expect([a.kind, b.kind].sort()).toEqual(['done', 'next']);
    const c = await cursorRow('products');
    expect([c.cursor, Number(c.records_processed)]).toEqual(['2', 2]);
  });
});

describe('failSyncRun', () => {
  it('marks the current run and cursor failed (used after the last queue attempt)', async () => {
    const h = makeHarness(env);
    const job = await start(h, 'orders');
    await failSyncRun(h.deps, job, 'gave up after 5 attempts');
    expect(await cursorRow('orders')).toMatchObject({
      status: 'failed',
      last_error: 'gave up after 5 attempts',
    });
    expect(await runRow(job.syncRunId)).toMatchObject({ status: 'failed' });
  });
  it('does not touch a newer run', async () => {
    const h = makeHarness(env);
    const job = await start(h, 'orders');
    await failSyncRun(h.deps, { ...job, syncRunId: '00000000-0000-4000-8000-000000000002' }, 'old');
    expect((await cursorRow('orders')).status).toBe('running');
  });
  it('sanitizes the raw queue error before storing it (members can read it)', async () => {
    const h = makeHarness(env);
    const job = await start(h, 'orders');
    const raw =
      'fetch failed for https://a.myshopify.com/admin/api/2025-07/graphql.json?access_token=abc123 ' +
      'with token shpat_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE';
    await failSyncRun(h.deps, job, raw);
    const stored = (await cursorRow('orders')).last_error as string;
    expect(stored).not.toMatch(/shpat_|abc123|access_token=abc/);
    expect(stored).toContain('[redacted]');
    const run = await runRow(job.syncRunId);
    expect(run.error).not.toMatch(/shpat_|abc123/);
    expect(stored.length).toBeLessThanOrEqual(500);
  });
});

describe('resumeStalledRuns', () => {
  it('re-enqueues running cursors that have not moved, without credentials or chain', async () => {
    const h = makeHarness(env);
    const job = await start(h, 'orders');
    expect(await resumeStalledRuns(h.deps, new Date(Date.now() - 60_000))).toBe(0); // fresh: not stalled
    expect(await resumeStalledRuns(h.deps, new Date(Date.now() + 60_000))).toBe(1);
    expect(h.queue.take()!.job).toEqual({
      orgId: ORG_A,
      connectionId: CONN_A,
      resource: 'orders',
      syncRunId: job.syncRunId,
      resumed: true,
    });
  });
});

describe('connection health', () => {
  const conn = async () =>
    (
      await env.owner.query(
        `select status, last_error, last_synced_at from store_connections where id = $1`,
        [CONN_A],
      )
    ).rows[0];
  const setConn = (status: string, lastError: string | null = null) =>
    env.owner.query(
      `update store_connections set status = $2, last_error = $3, last_synced_at = null where id = $1`,
      [CONN_A, status, lastError],
    );
  beforeEach(() => setConn('active'));
  afterAll(() => setConn('active'));
  const runAll = (h: ReturnType<typeof makeHarness>) =>
    enqueueSync(h.deps, {
      orgId: ORG_A,
      connectionId: CONN_A,
      resources: 'all',
      mode: 'backfill',
      since,
    });

  it('a single-resource run keeps the connection status and does not claim the connection is fresh', async () => {
    const h = makeHarness(env);
    await processSyncPage(h.deps, await start(h, 'locations'));
    const c = await conn();
    expect(c.status).toBe('active');
    expect(c.last_synced_at).toBeNull();
  });
  it('returns an errored connection to active after the last page of a chain', async () => {
    await setConn('error', 'token revoked');
    const h = makeHarness(env);
    await runAll(h);
    await drain(h);
    const c = await conn();
    expect([c.status, c.last_error]).toEqual(['active', null]);
    expect(c.last_synced_at).not.toBeNull();
  });
  it('clears the "import did not start" warning on an active connection at the real chain end', async () => {
    await setConn('active', IMPORT_NOT_STARTED_MESSAGE);
    const h = makeHarness(env);
    await runAll(h);
    const first = await processSyncPage(h.deps, h.queue.take()!.job);
    expect(first).toMatchObject({ kind: 'done', followUp: { resource: 'products' } });
    expect((await conn()).last_error).toBe(IMPORT_NOT_STARTED_MESSAGE); // mid-chain: unchanged
    await h.queue.enqueue((first as { followUp: SyncPageJob }).followUp);
    await drain(h);
    const c = await conn();
    expect([c.status, c.last_error]).toEqual(['active', null]);
  });
  it('keeps any other warning on an active connection at the chain end', async () => {
    await setConn('active', 'Webhook setup failed. Reconnect to retry.');
    const h = makeHarness(env);
    await runAll(h);
    await drain(h);
    const c = await conn();
    expect([c.status, c.last_error]).toEqual([
      'active',
      'Webhook setup failed. Reconnect to retry.',
    ]);
  });
  it('keeps the "import did not start" warning when only a resumed job finishes', async () => {
    await setConn('active', IMPORT_NOT_STARTED_MESSAGE);
    const h = makeHarness(env);
    await start(h, 'locations');
    expect(await resumeStalledRuns(h.deps, new Date(Date.now() + 60_000))).toBe(1);
    expect(await processSyncPage(h.deps, h.queue.take()!.job)).toEqual({ kind: 'done' });
    expect((await conn()).last_error).toBe(IMPORT_NOT_STARTED_MESSAGE);
  });
  it('does not record or recover anything while a chain is still in progress', async () => {
    await setConn('error', 'token revoked');
    const h = makeHarness(env);
    await runAll(h);
    const first = await processSyncPage(h.deps, h.queue.take()!.job); // locations done, products follow
    expect(first).toMatchObject({ kind: 'done', followUp: { resource: 'products' } });
    const c = await conn();
    expect([c.status, c.last_error, c.last_synced_at]).toEqual(['error', 'token revoked', null]);
  });
  it('never changes the status of a disconnected connection', async () => {
    await setConn('disconnected', 'removed');
    const h = makeHarness(env);
    await processSyncPage(h.deps, await start(h, 'locations'));
    const c = await conn();
    expect([c.status, c.last_error]).toEqual(['disconnected', 'removed']);
  });
  it('leaves last_synced_at unchanged when the run fails', async () => {
    const h = makeHarness(env);
    const job = await start(h, 'products');
    h.connector.failNext(new PermanentError('bad request'));
    await processSyncPage(h.deps, job);
    expect((await conn()).last_synced_at).toBeNull();
    const again = await start(h, 'locations');
    h.connector.failNext(new AuthError('token revoked'));
    await processSyncPage(h.deps, again);
    const c = await conn();
    expect([c.status, c.last_synced_at]).toEqual(['error', null]);
  });
  it('does not recover while another resource of the connection has failed', async () => {
    const h = makeHarness(env);
    const orders = await start(h, 'orders');
    h.connector.failNext(new PermanentError('bad request'));
    await processSyncPage(h.deps, orders); // orders cursor is now failed
    await setConn('error', 'token revoked');
    await processSyncPage(h.deps, await start(h, 'locations'));
    const c = await conn();
    expect([c.status, c.last_error]).toEqual(['error', 'token revoked']);
  });
  it('records nothing when a resumed job finishes (its chain is lost)', async () => {
    await setConn('error', 'token revoked');
    const h = makeHarness(env);
    await start(h, 'locations');
    expect(await resumeStalledRuns(h.deps, new Date(Date.now() + 60_000))).toBe(1);
    const resumed = h.queue.take()!.job;
    expect(await processSyncPage(h.deps, resumed)).toEqual({ kind: 'done' });
    expect((await cursorRow('locations')).status).toBe('complete');
    const c = await conn();
    expect([c.status, c.last_error, c.last_synced_at]).toEqual(['error', 'token revoked', null]);
  });
  it('does not turn a disconnected connection into an error when a job fails', async () => {
    await setConn('disconnected');
    const h = makeHarness(env);
    const job = await start(h, 'locations');
    h.connector.failNext(new AuthError('token revoked'));
    expect(await processSyncPage(h.deps, job)).toMatchObject({ kind: 'failed' });
    const c = await conn();
    expect([c.status, c.last_error]).toEqual(['disconnected', null]);
    expect((await cursorRow('locations')).status).toBe('failed');
  });
  it('is not changed again by a duplicated final job', async () => {
    const h = makeHarness(env);
    await runAll(h);
    const first = h.queue.take()!.job; // the locations job
    await h.queue.enqueue(first);
    await drain(h);
    const before = (await conn()).last_synced_at.toISOString();
    h.clock.advance(3_600_000);
    expect(await processSyncPage(h.deps, first)).toEqual({ kind: 'done' }); // stale: its run finished
    expect((await conn()).last_synced_at.toISOString()).toBe(before);
  });
  it('does not recover an errored connection when another job fails a cursor while this chain ends (row lock)', async () => {
    await setConn('error', 'token revoked');
    // No orders in the page: the sink then takes no foreign-key lock, so the ONLY thing that can make the
    // chain end wait is the explicit connection row lock.
    const h = makeHarness(env, { data: { ...sampleData(), orders: [] } });
    const job = await start(h, 'orders');
    const blocker = await env.owner.connect();
    try {
      await blocker.query('begin');
      // The blocker holds FOR NO KEY UPDATE: the same mode the chain end now takes (and the mode of the token
      // refresh), so the chain end's own `for no key update` conflicts with it and must wait. (The blocker's
      // own insert into sync_cursors below takes FOR KEY SHARE on the connection row, which its own lock allows.)
      await blocker.query('select id from store_connections where id = $1 for no key update', [
        CONN_A,
      ]);
      const ending = processSyncPage(h.deps, job);
      await waitUntilBlocked();
      await blocker.query(
        `insert into sync_cursors (org_id, store_connection_id, resource, status, last_error)
         values ($1, $2, 'inventory', 'failed', 'boom')`,
        [ORG_A, CONN_A],
      );
      await blocker.query('commit');
      await ending;
    } finally {
      blocker.release();
    }
    const c = await conn();
    expect([c.status, c.last_error]).toEqual(['error', 'token revoked']); // the failed cursor was seen after the lock
  });
});

describe('drain helper sanity', () => {
  it('runs a single resource to completion', async () => {
    const h = makeHarness(env);
    await enqueueSync(h.deps, {
      orgId: ORG_A,
      connectionId: CONN_A,
      resources: ['locations'],
      mode: 'backfill',
      since,
    });
    const results = await drain(h);
    expect(results.map((r) => r.kind)).toEqual(['done']);
  });
});

describe('token refresh in the engine', () => {
  const NOWMS = Date.parse('2026-10-06T12:00:00Z');
  const SEED_RT = 'shprt_seed_0123456789';
  const seedExpiring = (h: ReturnType<typeof makeHarness>, accessInMs: number) =>
    env.owner.query(
      `update store_connections set encrypted_credentials = $1, status = 'active', last_error = null where id = $2`,
      [
        encryptConnectionCredentials(
          {
            accessToken: 'shpat_old_0123456789',
            accessTokenExpiresAt: new Date(NOWMS + accessInMs).toISOString(),
            refreshToken: SEED_RT,
            refreshTokenExpiresAt: new Date(NOWMS + 80 * 86_400_000).toISOString(),
          },
          h.keyProvider,
          CONN_A,
        ),
        CONN_A,
      ],
    );
  const grant: ShopifyRefreshGrant = {
    accessToken: 'shpat_new_0123456789',
    scopes: [],
    accessTokenExpiresInSec: 3600,
    refreshToken: 'shprt_new_0123456789',
    refreshTokenExpiresInSec: 7_776_000,
  };
  const row = async () =>
    (
      await env.owner.query(
        `select status, last_error, encrypted_credentials from store_connections where id = $1`,
        [CONN_A],
      )
    ).rows[0];
  afterEach(() =>
    env.owner.query(
      `update store_connections set encrypted_credentials = null, status = 'active', last_error = null where id = $1`,
      [CONN_A],
    ),
  );

  it('refreshes before the fetch, hands the connector ONLY the access token, and keeps every token out of job and run', async () => {
    const h = makeHarness(env);
    await seedExpiring(h, 60_000);
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
    const job = await start(h, 'locations');
    expect(await processSyncPage(h.deps, job)).toEqual({ kind: 'done' });
    expect(presented).toEqual([SEED_RT]);
    expect(h.connector.calls[0]!.credentials).toEqual({ accessToken: 'shpat_new_0123456789' });
    const visible = JSON.stringify([
      job,
      await runRow(job.syncRunId),
      await cursorRow('locations'),
    ]);
    for (const secret of [
      'shpat_new_0123456789',
      'shprt_new_0123456789',
      SEED_RT,
      'shpat_old_0123456789',
    ]) {
      expect(visible).not.toContain(secret);
    }
  });
  it('does not refresh a token that is far from expiry', async () => {
    const h = makeHarness(env);
    await seedExpiring(h, 3_600_000);
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
    await processSyncPage(h.deps, await start(h, 'locations'));
    expect(called).toBe(0);
    expect(h.connector.calls[0]!.credentials).toEqual({ accessToken: 'shpat_old_0123456789' });
  });
  it('a final refresh failure errors the connection with the fixed reconnect text, fails the run and sends no further job', async () => {
    const h = makeHarness(env);
    await seedExpiring(h, 60_000);
    h.deps.tokens = createTokenService({
      db: env.db,
      keyProvider: h.keyProvider,
      now: h.clock.now,
      refresh: async () => {
        throw new AuthError(SHOPIFY_RECONNECT_MESSAGE);
      },
    });
    await enqueueSync(h.deps, {
      orgId: ORG_A,
      connectionId: CONN_A,
      resources: 'all',
      mode: 'backfill',
      since,
    });
    const first = h.queue.take()!.job;
    expect(await processSyncPage(h.deps, first)).toEqual({
      kind: 'failed',
      reason: SHOPIFY_RECONNECT_MESSAGE,
    });
    const c = await row();
    expect([c.status, c.last_error]).toEqual(['error', SHOPIFY_RECONNECT_MESSAGE]);
    expect((await cursorRow('locations')).status).toBe('failed');
    expect(h.queue.size).toBe(0);
    expect(JSON.stringify(c)).not.toContain(SEED_RT);
  });
  it('rethrows a transient refresh failure for the queue to retry, leaving the run and the stored pair alone', async () => {
    const h = makeHarness(env);
    await seedExpiring(h, 60_000);
    const before = (await row()).encrypted_credentials;
    h.deps.tokens = createTokenService({
      db: env.db,
      keyProvider: h.keyProvider,
      now: h.clock.now,
      refresh: async () => {
        throw new TransientError('Shopify is temporarily unavailable');
      },
    });
    const job = await start(h, 'locations');
    await expect(processSyncPage(h.deps, job)).rejects.toBeInstanceOf(TransientError);
    expect((await cursorRow('locations')).status).toBe('running');
    expect((await row()).encrypted_credentials).toBe(before);
  });
  it('turns a rate-limited refresh into a delayed job', async () => {
    const h = makeHarness(env);
    await seedExpiring(h, 60_000);
    h.deps.tokens = createTokenService({
      db: env.db,
      keyProvider: h.keyProvider,
      now: h.clock.now,
      refresh: async () => {
        throw new RateLimitedError(3000);
      },
    });
    expect(await processSyncPage(h.deps, await start(h, 'locations'))).toEqual({
      kind: 'delayed',
      delayMs: 3000,
    });
  });
  it('sanitizes a stored failure that carries a refresh token', async () => {
    const h = makeHarness(env);
    const job = await start(h, 'locations');
    await failSyncRun(
      h.deps,
      job,
      `refresh failed for ${SEED_RT} with client_secret=topsecretvalue`,
    );
    const stored = JSON.stringify(await cursorRow('locations'));
    expect(stored).not.toContain(SEED_RT);
    expect(stored).not.toContain('topsecretvalue');
  });
});

// Kept last: these runs insert orders, and an earlier test counts the orders table.
const runMode = async (
  h: ReturnType<typeof makeHarness>,
  resources: SyncResource[],
  mode: 'backfill' | 'incremental' | 'full',
) => {
  await enqueueSync(h.deps, {
    orgId: ORG_A,
    connectionId: CONN_A,
    resources,
    mode,
    since: mode === 'backfill' ? since : undefined,
  });
  await drain(h);
};
const latestRun = async () =>
  (
    await env.owner.query(
      `select type from sync_runs where connection_id = $1 order by started_at desc limit 1`,
      [CONN_A],
    )
  ).rows[0];

describe('full passes', () => {
  it('a full run reads without a filter and stamps last_full_pass_at; an incremental run filters and does not', async () => {
    const h = makeHarness(env);
    await runMode(h, ['products'], 'backfill');
    expect((await cursorRow('products')).last_full_pass_at.toISOString()).toBe(
      '2026-10-06T12:00:00.000Z',
    );

    h.clock.advance(3_600_000);
    await runMode(h, ['products'], 'incremental');
    const incremental = h.connector.calls.at(-1)!;
    expect(incremental.options.updatedSince).toBeInstanceOf(Date);
    expect((await cursorRow('products')).last_full_pass_at.toISOString()).toBe(
      '2026-10-06T12:00:00.000Z',
    );

    h.clock.advance(3_600_000);
    const callsBefore = h.connector.calls.length;
    await runMode(h, ['products'], 'full');
    const fullCalls = h.connector.calls.slice(callsBefore);
    expect(fullCalls.length).toBeGreaterThan(0);
    for (const call of fullCalls) {
      expect(call.options.updatedSince).toBeUndefined();
      expect(call.options.since).toBeUndefined();
    }
    expect((await latestRun()).type).toBe('full');
    const cursor = await cursorRow('products');
    expect(cursor.last_full_pass_at.toISOString()).toBe('2026-10-06T14:00:00.000Z');
    expect(cursor.updated_since.toISOString()).toBe('2026-10-06T14:00:00.000Z'); // the watermark is back after the pass
  });
  it('a full run needs no since, and a backfill still does', async () => {
    const h = makeHarness(env);
    await expect(
      enqueueSync(h.deps, {
        orgId: ORG_A,
        connectionId: CONN_A,
        resources: ['products'],
        mode: 'full',
      }),
    ).resolves.toMatchObject({ resource: 'products', started: true });
    await resetSync(env);
    await expect(
      enqueueSync(h.deps, {
        orgId: ORG_A,
        connectionId: CONN_A,
        resources: ['products'],
        mode: 'backfill',
      }),
    ).rejects.toThrow(RangeError);
  });
  it('a failed full run leaves the watermark cleared, so the next incremental reads everything (more data, never less)', async () => {
    const h = makeHarness(env);
    await runMode(h, ['products'], 'backfill');
    h.clock.advance(60_000);
    h.connector.failNext(new PermanentError('boom'));
    await runMode(h, ['products'], 'full');
    const failed = await cursorRow('products');
    expect([failed.status, failed.updated_since]).toEqual(['failed', null]);
    h.clock.advance(60_000);
    const callsBefore = h.connector.calls.length;
    await runMode(h, ['products'], 'incremental');
    expect(h.connector.calls[callsBefore]!.options.updatedSince).toBeUndefined();
  });
  it('a full chain keeps its mode for every resource it carries', async () => {
    const h = makeHarness(env);
    await enqueueSync(h.deps, {
      orgId: ORG_A,
      connectionId: CONN_A,
      resources: ['products', 'inventory'],
      mode: 'full',
    });
    const first = h.queue.take()!.job;
    expect(first.then).toEqual({ resources: ['inventory'], mode: 'full', since: null });
  });
});

describe('connection freshness is the oldest resource', () => {
  const connRow = async () =>
    (await env.owner.query(`select last_synced_at from store_connections where id = $1`, [CONN_A]))
      .rows[0];
  beforeEach(() =>
    env.owner.query(
      `update store_connections set status = 'active', last_error = null, last_synced_at = null where id = $1`,
      [CONN_A],
    ),
  );
  it('a single-resource run does not mark the connection fresh', async () => {
    const h = makeHarness(env);
    await runMode(h, ['locations'], 'backfill');
    expect((await cursorRow('locations')).last_synced_at.toISOString()).toBe(
      '2026-10-06T12:00:00.000Z',
    );
    expect((await connRow()).last_synced_at).toBeNull();
  });
  it('is the OLDEST of the four resource times once all four have completed, and later runs of one resource do not move it', async () => {
    const h = makeHarness(env);
    await runMode(h, ['locations', 'products', 'inventory', 'orders'], 'backfill');
    expect((await connRow()).last_synced_at.toISOString()).toBe('2026-10-06T12:00:00.000Z');
    h.clock.advance(3_600_000);
    await runMode(h, ['locations'], 'incremental'); // locations now 13:00, the other three still 12:00
    expect((await connRow()).last_synced_at.toISOString()).toBe('2026-10-06T12:00:00.000Z');
    h.clock.advance(3_600_000);
    await runMode(h, ['products', 'inventory', 'orders'], 'incremental'); // now locations (13:00) is the oldest
    expect((await connRow()).last_synced_at.toISOString()).toBe('2026-10-06T13:00:00.000Z');
  });
});

describe('order-line link-up after products', () => {
  const lateOrder = async () => {
    const orderId = await seedOrder(env.owner, {
      orgId: ORG_A,
      connectionId: CONN_A,
      externalId: 'o-late',
      placedAt: '2026-09-15T12:00:00Z',
      lines: [{ skuId: null, qty: 1 }],
    });
    await env.owner.query(
      `update order_lines set external_variant_id = 'v-1' where order_id = $1`,
      [orderId],
    );
    return orderId;
  };
  const lineOf = async (orderId: string) =>
    (
      await env.owner.query(
        `select sku_id, unit_cogs_cents_snapshot as cogs from order_lines where order_id = $1`,
        [orderId],
      )
    ).rows[0];

  it('links a line to the product the sync just imported and fills the cost in effect on the order date', async () => {
    await env.owner.query(`delete from order_lines`);
    await env.owner.query(`delete from orders`);
    const h = makeHarness(env);
    const orderId = await lateOrder();
    await runMode(h, ['locations', 'products'], 'backfill'); // the sample product has variant v-1 with cost 800 from 2026-01-01
    const row = await lineOf(orderId);
    expect(row.sku_id).not.toBeNull();
    expect(row.cogs).toBe('800');
  });
  it('a failure in the link-up never fails the finished products run, and the next run repeats it', async () => {
    await env.owner.query(`delete from order_lines`);
    await env.owner.query(`delete from orders`);
    const h = makeHarness(env);
    const orderId = await lateOrder();
    const job = await start(h, 'products');
    const first = await processSyncPage(h.deps, job); // page 1 of 2
    if (first.kind !== 'next') throw new Error('expected a second page');
    const realDb = h.deps.db;
    let calls = 0;
    // The tenant transactions of the second page job, in order: load (1), token read (2, the engine's default
    // token service reads the credentials first), page transaction (3, it commits the cursor as `complete`),
    // link-up (4) fails. Counting from the start of THIS job, not of the test.
    h.deps.db = {
      ...realDb,
      withTenant: (org: string, fn: Parameters<typeof realDb.withTenant>[1]) =>
        ++calls >= 4 ? Promise.reject(new Error('link-up db down')) : realDb.withTenant(org, fn),
    } as typeof realDb;
    expect(await processSyncPage(h.deps, first.job)).toEqual({ kind: 'done' });
    h.deps.db = realDb;
    expect(calls).toBe(4); // the link-up WAS attempted (and failed) after the page transaction committed
    expect((await cursorRow('products')).status).toBe('complete');
    expect((await lineOf(orderId)).sku_id).toBeNull();
    h.clock.advance(60_000);
    await runMode(h, ['products'], 'incremental');
    expect((await lineOf(orderId)).sku_id).not.toBeNull();
  });
});
