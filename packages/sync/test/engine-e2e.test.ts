import { PermanentError, TransientError } from '@erq/connectors';
import { sampleData } from '@erq/connectors/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enqueueSync } from '../src/engine/start';
import { processSyncPage } from '../src/engine/process';
import { resumeStalledRuns } from '../src/engine/resume';
import { MemoryRateLimiter } from '../src/memory';
import { drain, makeHarness, resetSync } from './engine-helpers';
import { CONN_A, ORG_A, startEnv, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env?.stop();
});
beforeEach(async () => {
  await resetSync(env);
  for (const t of [
    'refund_lines',
    'refunds',
    'order_lines',
    'orders',
    'inventory_movements',
    'inventory_levels',
    'sku_channel_listings',
    'sku_cost_components',
    'skus',
    'products',
    'locations',
  ]) {
    await env.owner.query(`delete from ${t} where org_id = $1`, [ORG_A]);
  }
});

const since = new Date('2026-01-01T00:00:00Z');
const counts = async () => {
  const out: Record<string, number> = {};
  for (const t of [
    'locations',
    'products',
    'skus',
    'sku_channel_listings',
    'sku_cost_components',
    'inventory_levels',
    'inventory_movements',
    'orders',
    'order_lines',
    'refunds',
    'refund_lines',
  ]) {
    out[t] = Number(
      (await env.owner.query(`select count(*) c from ${t} where org_id = $1`, [ORG_A])).rows[0].c,
    );
  }
  return out;
};
const full = {
  locations: 2,
  products: 3,
  skus: 4,
  sku_channel_listings: 4,
  sku_cost_components: 3,
  inventory_levels: 6,
  inventory_movements: 6,
  orders: 5,
  order_lines: 6,
  refunds: 1,
  refund_lines: 1,
};
const backfillAll = (h: ReturnType<typeof makeHarness>) =>
  enqueueSync(h.deps, {
    orgId: ORG_A,
    connectionId: CONN_A,
    resources: 'all',
    mode: 'backfill',
    since,
  });

describe('backfill of every resource', () => {
  it('lands all data in dependency order, costs the orders, and finishes every run', async () => {
    const h = makeHarness(env);
    await backfillAll(h);
    const results = await drain(h);
    expect(results.every((r) => r.kind === 'done' || r.kind === 'next')).toBe(true);
    expect(await counts()).toEqual(full);

    const runs = (
      await env.owner.query(
        `select status, records_processed from sync_runs where org_id = $1 order by started_at, created_at`,
        [ORG_A],
      )
    ).rows;
    expect(runs).toHaveLength(4);
    expect(runs.every((r) => r.status === 'succeeded')).toBe(true);
    const cursors = (
      await env.owner.query(
        `select resource, status from sync_cursors where org_id = $1 order by resource`,
        [ORG_A],
      )
    ).rows;
    expect(cursors.every((c) => c.status === 'complete')).toBe(true);

    // Chain order: the first fetch of each resource follows locations -> products -> inventory -> orders.
    const seen: string[] = [];
    for (const c of h.connector.calls) if (!seen.includes(c.resource)) seen.push(c.resource);
    expect(seen).toEqual(['locations', 'products', 'inventory', 'orders']);
    expect(cursors.map((c) => c.resource).sort()).toEqual([
      'inventory',
      'locations',
      'orders',
      'products',
    ]);

    // products ran before orders, so the t-shirt line has its imported cost snapshot, the poster line (no cost) has null
    const snaps = (
      await env.owner.query(
        `select ol.external_line_id, ol.unit_cogs_cents_snapshot s from order_lines ol join orders o on o.id = ol.order_id where o.org_id = $1 and o.external_order_id = 'o-1' order by 1`,
        [ORG_A],
      )
    ).rows;
    expect(snaps.map((r) => (r.s === null ? null : Number(r.s)))).toEqual([800, null]);
  });

  it('is repeatable: a second backfill changes nothing', async () => {
    const h = makeHarness(env);
    await backfillAll(h);
    await drain(h);
    await backfillAll(h);
    await drain(h);
    expect(await counts()).toEqual(full);
  });
});

describe('crash recovery', () => {
  it('resumes from the stored cursor after a lost job, with no loss or duplication', async () => {
    const h = makeHarness(env);
    await backfillAll(h);
    // Process locations fully and the first products page, then "crash": the queue loses the next job.
    let item = h.queue.take()!;
    let r = await processSyncPage(h.deps, item.job); // locations (one page)
    if (r.kind !== 'done' || !r.followUp)
      throw new Error('expected the locations run to chain into products');
    await h.queue.enqueue(r.followUp);
    item = h.queue.take()!;
    r = await processSyncPage(h.deps, item.job); // first products page
    expect(r.kind).toBe('next');
    while (h.queue.take()) {
      /* the crash: pending jobs are gone */
    }

    // updated_at is stamped by the database clock, so use the real clock here (the fake clock only drives the engine)
    expect(await resumeStalledRuns(h.deps, new Date(Date.now() - 3_600_000))).toBe(0); // not stalled yet
    expect(await resumeStalledRuns(h.deps, new Date('2999-01-01T00:00:00Z'))).toBe(1);
    await drain(h);
    expect((await counts()).skus).toBe(4);
    expect(
      (
        await env.owner.query(
          `select status from sync_cursors where resource = 'products' and org_id = $1`,
          [ORG_A],
        )
      ).rows[0].status,
    ).toBe('complete');

    // The chain is not persisted: re-running the sync completes the rest.
    await enqueueSync(h.deps, {
      orgId: ORG_A,
      connectionId: CONN_A,
      resources: 'all',
      mode: 'incremental',
    });
    await drain(h);
    expect(await counts()).toEqual(full);
  });
});

describe('incremental runs', () => {
  it('ask the platform only for changes since the previous run and apply them', async () => {
    const h = makeHarness(env, { pageSize: 50 });
    await backfillAll(h);
    await drain(h);
    h.clock.advance(3_600_000);
    const data = h.connector.data;
    const changed = {
      ...data.orders[4]!,
      updatedAt: new Date('2026-10-06T12:30:00Z'),
      status: 'closed' as const,
    };
    h.connector.data = { ...data, orders: [...data.orders.slice(0, 4), changed] };
    h.connector.calls.length = 0;

    await enqueueSync(h.deps, {
      orgId: ORG_A,
      connectionId: CONN_A,
      resources: ['orders'],
      mode: 'incremental',
    });
    await drain(h);
    expect(h.connector.calls[0]!.options.updatedSince?.toISOString()).toBe(
      '2026-10-06T12:00:00.000Z',
    ); // previous run's start
    expect(h.connector.calls[0]!.options.since).toBeUndefined();
    const run = (
      await env.owner.query(
        `select type, records_processed from sync_runs where org_id = $1 order by created_at desc limit 1`,
        [ORG_A],
      )
    ).rows[0];
    expect([run.type, Number(run.records_processed)]).toEqual(['incremental', 1]);
    expect(
      (
        await env.owner.query(
          `select status from orders where org_id = $1 and external_order_id = 'o-5'`,
          [ORG_A],
        )
      ).rows[0].status,
    ).toBe('closed');
    expect((await counts()).orders).toBe(5);
  });
});

describe('failures', () => {
  it('a permanent failure stops the chain and leaves later resources unstarted', async () => {
    const h = makeHarness(env);
    h.connector.failNext(new PermanentError('shop closed'), 1); // consumed by the very first fetch: the locations page
    await backfillAll(h);
    await drain(h);
    const cursors = (
      await env.owner.query(
        `select resource, status from sync_cursors where org_id = $1 order by resource`,
        [ORG_A],
      )
    ).rows;
    expect(cursors.find((c) => c.resource === 'locations')!.status).toBe('failed'); // the scripted failure hit the first fetch
    expect(cursors.find((c) => c.resource === 'orders')).toBeUndefined();
  });

  it('a transient failure is retried by the queue and the retry gives the same result', async () => {
    const h = makeHarness(env);
    await enqueueSync(h.deps, {
      orgId: ORG_A,
      connectionId: CONN_A,
      resources: ['locations'],
      mode: 'backfill',
      since,
    });
    const job = h.queue.take()!.job;
    h.connector.failNext(new TransientError('503'), 2);
    await expect(processSyncPage(h.deps, job)).rejects.toBeInstanceOf(TransientError);
    await expect(processSyncPage(h.deps, job)).rejects.toBeInstanceOf(TransientError);
    expect((await processSyncPage(h.deps, job)).kind).toBe('done');
    expect((await counts()).locations).toBe(2);
  });

  it('rate limiting delays jobs, never loses them, and the run still completes', async () => {
    const h = makeHarness(env);
    h.deps.limiter = new MemoryRateLimiter(() => h.clock.now().getTime());
    h.deps.policies = { shopify: { capacity: 1, refillPerSecond: 1, costPerPage: 1 } };
    await backfillAll(h);
    const results = await drain(h);
    expect(results.some((r) => r.kind === 'delayed')).toBe(true);
    expect(await counts()).toEqual(full);
  });
});

describe('data safety', () => {
  it('never advances a cursor without its data: a failed page leaves cursor and tables unchanged', async () => {
    const data = sampleData();
    data.orders[2]!.refunds[0]!.lines[0]!.quantity = 9; // violates refunded <= quantity on the last order page
    const h = makeHarness(env, { data, pageSize: 50 });
    await enqueueSync(h.deps, {
      orgId: ORG_A,
      connectionId: CONN_A,
      resources: ['products', 'orders'],
      mode: 'backfill',
      since,
    });
    await drain(h);
    const orders = (
      await env.owner.query(
        `select status, cursor, records_processed from sync_cursors where org_id = $1 and resource = 'orders'`,
        [ORG_A],
      )
    ).rows[0];
    expect(orders.status).toBe('failed');
    expect(Number(orders.records_processed)).toBe(0);
    expect((await counts()).orders).toBe(0);
    expect((await counts()).skus).toBe(4); // the successful products run is kept
  });
});
