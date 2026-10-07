import { randomBytes } from 'node:crypto';
import { ConnectorRegistry } from '@erq/connectors';
import { FakeConnector, sampleData, type FakeData } from '@erq/connectors/testing';
import { EnvKeyProvider } from '@erq/shared';
import type { SyncDeps } from '../src/engine/deps';
import { processSyncPage } from '../src/engine/process';
import { InMemoryJobQueue, MemoryRateLimiter } from '../src/memory';
import type { PageResult } from '../src/ports';
import type { TestEnv } from './helpers';

export interface Harness {
  deps: SyncDeps;
  queue: InMemoryJobQueue;
  connector: FakeConnector;
  keyProvider: EnvKeyProvider;
  clock: { now(): Date; advance(ms: number): void };
}

export function makeHarness(
  env: TestEnv,
  opts: {
    data?: FakeData;
    pageSize?: number;
    deps?: Partial<SyncDeps>;
    /** Replaces the default registry (the FakeConnector under 'shopify'); `connector` is then unused. */
    connectors?: ConnectorRegistry;
  } = {},
): Harness {
  const queue = new InMemoryJobQueue();
  const connector = new FakeConnector(opts.data ?? sampleData(), opts.pageSize ?? 2);
  const keyProvider = new EnvKeyProvider('k1', { k1: randomBytes(32).toString('base64') });
  let nowMs = Date.parse('2026-10-06T12:00:00Z');
  const clock = {
    now: () => new Date(nowMs),
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
  const deps: SyncDeps = {
    db: env.db,
    connectors: opts.connectors ?? new ConnectorRegistry().register('shopify', connector),
    limiter: new MemoryRateLimiter(() => nowMs),
    queue,
    keyProvider,
    now: clock.now,
    ...opts.deps,
  };
  return { deps, queue, connector, keyProvider, clock };
}

/** Plays the part of the worker: processes queued jobs FIFO until the queue is empty. */
export async function drain(h: Harness, maxJobs = 500): Promise<PageResult[]> {
  const results: PageResult[] = [];
  for (let i = 0; i < maxJobs; i++) {
    const item = h.queue.take();
    if (!item) return results;
    if (item.delayMs) h.clock.advance(item.delayMs);
    const result = await processSyncPage(h.deps, item.job);
    results.push(result);
    if (result.kind === 'next') await h.queue.enqueue(result.job);
    else if (result.kind === 'delayed')
      await h.queue.enqueue(item.job, { delayMs: result.delayMs });
    else if (result.kind === 'done' && result.followUp) await h.queue.enqueue(result.followUp);
  }
  throw new Error('drain exceeded maxJobs');
}

export async function resetSync(env: TestEnv): Promise<void> {
  await env.owner.query('delete from sync_cursors');
  await env.owner.query('delete from sync_runs');
}
