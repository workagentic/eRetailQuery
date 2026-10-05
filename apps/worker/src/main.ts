import path from 'node:path';
import { Queue } from 'bullmq';
import dotenv from 'dotenv';
import IORedis from 'ioredis';
import { createLogger } from '@erq/shared';
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

  const shutdown = async () => {
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
