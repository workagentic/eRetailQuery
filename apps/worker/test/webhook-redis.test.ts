import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockerAvailable } from '@erq/db/testing';
import { WEBHOOK_QUEUE, type WebhookJob } from '@erq/shared';
import { BullMqWebhookEnqueuer, createWebhookWorker } from '../src/webhooks/worker';

// Skipped (not failed) when Docker is unavailable; reported as unverified until CI runs it.
describe('webhook queue (Redis testcontainer)', () => {
  let hasDocker = false;
  let redis: StartedTestContainer | undefined;
  let connection: IORedis | undefined;
  const ORG = '11111111-1111-4111-8111-111111111111';
  const EVENT = '22222222-2222-4222-8222-222222222222';

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

  it('deduplicates repeated enqueues of one event and processes it once', async (ctx) => {
    ctx.skip(!hasDocker);
    const queue = new Queue(WEBHOOK_QUEUE, { connection: connection! });
    const events = new QueueEvents(WEBHOOK_QUEUE, { connection: connection! });
    const handled: WebhookJob[] = [];
    const enqueuer = new BullMqWebhookEnqueuer(queue);
    await enqueuer.enqueue({ orgId: ORG, eventId: EVENT });
    await enqueuer.enqueue({ orgId: ORG, eventId: EVENT });
    expect(await queue.count()).toBe(1);
    const worker = createWebhookWorker(
      { handle: async (j) => void handled.push(j), sweep: async () => 0 },
      connection!,
    );
    try {
      const job = (await queue.getJobs(['waiting', 'active', 'delayed']))[0]!;
      await job.waitUntilFinished(events, 10_000);
      expect(handled).toEqual([{ orgId: ORG, eventId: EVENT }]);
    } finally {
      await worker.close();
      await queue.close();
      await events.close();
    }
  });

  it('fails invalid job data without retrying and runs the sweep job', async (ctx) => {
    ctx.skip(!hasDocker);
    const queue = new Queue(WEBHOOK_QUEUE, { connection: connection! });
    const events = new QueueEvents(WEBHOOK_QUEUE, { connection: connection! });
    let sweeps = 0;
    const worker = createWebhookWorker(
      { handle: async () => undefined, sweep: async () => void sweeps++ },
      connection!,
    );
    try {
      const bad = await queue.add('webhook', { orgId: 'not-a-uuid', extra: 1 }, { attempts: 3 });
      await expect(bad.waitUntilFinished(events, 10_000)).rejects.toThrow();
      expect((await queue.getJob(bad.id!))?.attemptsMade).toBe(1);
      const sweep = await queue.add('sweep', {});
      await sweep.waitUntilFinished(events, 10_000);
      expect(sweeps).toBe(1);
    } finally {
      await worker.close();
      await queue.close();
      await events.close();
    }
  });
});
