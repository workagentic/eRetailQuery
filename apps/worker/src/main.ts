import path from 'node:path';
import { Queue } from 'bullmq';
import dotenv from 'dotenv';
import IORedis from 'ioredis';
import { ConnectorRegistry } from '@erq/connectors';
import { createTenantDb } from '@erq/db';
import { createLogger, EnvKeyProvider } from '@erq/shared';
import type { SyncDeps } from '@erq/sync';
import { BullMqJobQueue, SYNC_QUEUE } from './sync/bullmq-queue';
import { RedisRateLimiter } from './sync/redis-rate-limiter';
import { createSyncWorker, scheduleResumeStalled } from './sync/worker';
import { createSystemWorker, SYSTEM_QUEUE } from './system-worker';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

async function main(): Promise<void> {
  const log = createLogger({ level: process.env.LOG_LEVEL ?? 'info' });
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is required');
  const connection = new IORedis(url, { maxRetriesPerRequest: null });

  const worker = createSystemWorker(connection);
  worker.on('completed', (job) => log.info({ job: job.name }, 'job completed'));
  worker.on('failed', (job, err) => log.error({ job: job?.name, err }, 'job failed'));

  // Repeatable health heartbeat. BullMQ job schedulers: https://docs.bullmq.io/guide/job-schedulers
  const queue = new Queue(SYSTEM_QUEUE, { connection });
  await queue.upsertJobScheduler('health-every-minute', { every: 60_000 }, { name: 'health' });

  let syncWorker: ReturnType<typeof createSyncWorker> | undefined;
  let syncQueue: Queue | undefined;
  let syncDb: ReturnType<typeof createTenantDb> | undefined;
  if (process.env.DATABASE_URL && process.env.ENCRYPTION_KEY) {
    syncDb = createTenantDb(process.env.DATABASE_URL);
    syncQueue = new Queue(SYNC_QUEUE, { connection });
    const deps: SyncDeps = {
      db: syncDb,
      // Real connectors are registered in 1b-3.
      connectors: new ConnectorRegistry(),
      limiter: new RedisRateLimiter(connection),
      queue: new BullMqJobQueue(syncQueue),
      keyProvider: EnvKeyProvider.fromEnv(process.env),
    };
    syncWorker = createSyncWorker(deps, connection, {
      concurrency: Number(process.env.SYNC_CONCURRENCY ?? 5),
    });
    await scheduleResumeStalled(syncQueue);
  } else {
    log.info('sync worker disabled');
  }

  const shutdown = async () => {
    await syncWorker?.close();
    await syncQueue?.close();
    await syncDb?.close();
    await worker.close();
    await queue.close();
    await connection.quit();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  log.info('worker started');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
