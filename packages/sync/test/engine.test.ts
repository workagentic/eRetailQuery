import {
  AuthError,
  PermanentError,
  RateLimitedError,
  TransientError,
  encryptConnectionCredentials,
} from '@erq/connectors';
import { sampleData } from '@erq/connectors/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enqueueSync } from '../src/engine/start';
import { failSyncRun } from '../src/engine/fail';
import { processSyncPage } from '../src/engine/process';
import { resumeStalledRuns } from '../src/engine/resume';
import type { RateLimiter, SyncPageJob } from '../src/ports';
import { drain, makeHarness, resetSync } from './engine-helpers';
import { CONN_A, ORG_A, ORG_B, startEnv, type TestEnv } from './helpers';

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

  it('records last_synced_at when a single-resource run completes and keeps the status', async () => {
    const h = makeHarness(env);
    await processSyncPage(h.deps, await start(h, 'locations'));
    const c = await conn();
    expect(c.status).toBe('active');
    expect(c.last_synced_at.toISOString()).toBe('2026-10-06T12:00:00.000Z');
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
    const job = await start(h, 'locations');
    await processSyncPage(h.deps, job);
    const before = (await conn()).last_synced_at.toISOString();
    h.clock.advance(3_600_000);
    expect(await processSyncPage(h.deps, job)).toEqual({ kind: 'done' });
    expect((await conn()).last_synced_at.toISOString()).toBe(before);
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
