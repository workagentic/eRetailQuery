import { dockerAvailable } from '@erq/db/testing';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BullMqJobQueue, SYNC_QUEUE } from '../src/sync/bullmq-queue';
import { RedisRateLimiter } from '../src/sync/redis-rate-limiter';

let hasDocker = false;
let container: StartedTestContainer | undefined;
let redis: IORedis | undefined;
const policy = { capacity: 2, refillPerSecond: 1, costPerPage: 1 };

beforeAll(async () => {
  hasDocker = await dockerAvailable();
  if (!hasDocker) return;
  container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  redis = new IORedis({
    host: container.getHost(),
    port: container.getMappedPort(6379),
    maxRetriesPerRequest: null,
  });
});
afterAll(async () => {
  await redis?.quit();
  await container?.stop();
});

describe('RedisRateLimiter', () => {
  it('allows up to capacity, reports a retry delay, then refills', async (ctx) => {
    ctx.skip(!hasDocker);
    const limiter = new RedisRateLimiter(redis!);
    const key = `test:${Date.now()}`;
    expect((await limiter.take(key, 1, policy)).allowed).toBe(true);
    expect((await limiter.take(key, 1, policy)).allowed).toBe(true);
    const denied = await limiter.take(key, 1, policy);
    expect(denied.allowed).toBe(false);
    expect(denied.allowed === false && denied.retryAfterMs).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 1200));
    expect((await limiter.take(key, 1, policy)).allowed).toBe(true);
  });
  it('rejects a cost above capacity', async (ctx) => {
    ctx.skip(!hasDocker);
    const limiter = new RedisRateLimiter(redis!);
    await expect(limiter.take('k', 3, policy)).rejects.toThrow(RangeError);
  });
});

describe('BullMqJobQueue', () => {
  it('adds a page job with retry options and an optional delay', async (ctx) => {
    ctx.skip(!hasDocker);
    const queue = new Queue(SYNC_QUEUE, { connection: redis! });
    try {
      await new BullMqJobQueue(queue).enqueue(
        { orgId: 'o', connectionId: 'c', resource: 'orders', syncRunId: 'r' },
        { delayMs: 5000 },
      );
      const [job] = await queue.getDelayed();
      expect(job!.name).toBe('page');
      expect(job!.opts.attempts).toBe(5);
      expect(job!.opts.delay).toBe(5000);
      expect(job!.data).toEqual({
        orgId: 'o',
        connectionId: 'c',
        resource: 'orders',
        syncRunId: 'r',
      });
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});
