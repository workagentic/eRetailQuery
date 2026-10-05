import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockerAvailable } from '@erq/db/testing';
import { createSystemWorker, SYSTEM_QUEUE } from '../src/system-worker';

// Skipped (not failed) when Docker is unavailable; the Redis Testcontainer needs it.
// (No top-level await: this package compiles as CommonJS, so availability is resolved in beforeAll.)
describe('system worker (Redis testcontainer)', () => {
  let hasDocker = false;
  let redis: StartedTestContainer | undefined;
  let connection: IORedis | undefined;

  beforeAll(async () => {
    hasDocker = await dockerAvailable();
    if (!hasDocker) return;
    redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
    connection = new IORedis({
      host: redis.getHost(),
      port: redis.getMappedPort(6379),
      maxRetriesPerRequest: null,
    });
  });
  afterAll(async () => {
    await connection?.quit();
    await redis?.stop();
  });

  it('processes a health job end to end', async (ctx) => {
    ctx.skip(!hasDocker);
    const worker = createSystemWorker(connection!);
    const queue = new Queue(SYSTEM_QUEUE, { connection: connection! });
    const events = new QueueEvents(SYSTEM_QUEUE, { connection: connection! });
    try {
      const job = await queue.add('health', {});
      const result = await job.waitUntilFinished(events, 10_000);
      expect(result).toMatchObject({ ok: true });
    } finally {
      await worker.close();
      await queue.close();
      await events.close();
    }
  });

  it('fails unknown job names', async (ctx) => {
    ctx.skip(!hasDocker);
    const worker = createSystemWorker(connection!);
    const queue = new Queue(SYSTEM_QUEUE, { connection: connection! });
    const events = new QueueEvents(SYSTEM_QUEUE, { connection: connection! });
    try {
      const job = await queue.add('mystery', {}, { attempts: 1 });
      await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow(/unknown job/);
    } finally {
      await worker.close();
      await queue.close();
      await events.close();
    }
  });
});
