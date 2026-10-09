import path from 'node:path';
import { Queue } from 'bullmq';
import dotenv from 'dotenv';
import IORedis from 'ioredis';
import { createFetchHttpClient, sanitizeMessage, SHOPIFY_API_VERSION } from '@erq/connectors';
import { createConnectionsApi, createTenantDb, type TenantDb } from '@erq/db';
import { createLogger, EnvKeyProvider, WEBHOOK_QUEUE } from '@erq/shared';
import type { SchedulerDeps } from '@erq/sync';
import { BullMqJobQueue, SYNC_QUEUE } from './sync/bullmq-queue';
import { createWorkerConnectors, shopifyApiVersion } from './sync/connectors';
import { RedisRateLimiter } from './sync/redis-rate-limiter';
import { createWorkerTokenService, workerRefreshFn } from './sync/tokens';
import { createSyncWorker, scheduleResumeStalled, scheduleSyncTick } from './sync/worker';
import { createSystemWorker, SYSTEM_QUEUE } from './system-worker';
import { processWebhookEvent } from './webhooks/handler';
import { createWebhookReconciler } from './webhooks/reconcile';
import { sweepStaleWebhookEvents } from './webhooks/sweep';
import {
  BullMqWebhookEnqueuer,
  createWebhookWorker,
  scheduleWebhookSweep,
} from './webhooks/worker';

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

  // One TenantDb serves both the sync and webhook workers.
  const db: TenantDb | undefined = process.env.DATABASE_URL
    ? createTenantDb(process.env.DATABASE_URL)
    : undefined;

  let syncWorker: ReturnType<typeof createSyncWorker> | undefined;
  let syncQueue: Queue | undefined;
  if (db && process.env.ENCRYPTION_KEY) {
    syncQueue = new Queue(SYNC_QUEUE, { connection });
    const keyProvider = EnvKeyProvider.fromEnv(process.env);
    // Same check (trimmed) as the refresh function itself, so the warning and the behaviour agree.
    if (workerRefreshFn(process.env) === undefined) {
      log.warn(
        'SHOPIFY_API_KEY or SHOPIFY_API_SECRET is missing: expiring Shopify tokens cannot be refreshed',
      );
    }
    const tokens = createWorkerTokenService(process.env, db, keyProvider);
    // The daily re-register needs the public webhook URL; without it nothing is re-registered.
    const callbackUrl = process.env.API_PUBLIC_URL
      ? `${process.env.API_PUBLIC_URL.replace(/\/+$/, '')}/webhooks/shopify`
      : undefined;
    if (!callbackUrl)
      log.warn('API_PUBLIC_URL is missing: webhook subscriptions are not re-registered');
    const deps: SchedulerDeps = {
      db,
      connectors: createWorkerConnectors(process.env),
      limiter: new RedisRateLimiter(connection),
      queue: new BullMqJobQueue(syncQueue),
      keyProvider,
      tokens,
      // Messages are sanitized by the tick (no tokens); they name the connection only.
      onError: (message) => log.warn({ err: message }, 'sync tick problem'),
      reconcileWebhooks: callbackUrl
        ? createWebhookReconciler({
            db,
            tokens,
            http: createFetchHttpClient(),
            callbackUrl,
            apiVersion: shopifyApiVersion(process.env) ?? SHOPIFY_API_VERSION,
          })
        : undefined,
    };
    syncWorker = createSyncWorker(deps, connection, {
      concurrency: Number(process.env.SYNC_CONCURRENCY ?? 5),
    });
    // Page failures are recorded on the run; a failed tick only needs a log line (sanitized, no payload).
    syncWorker.on('failed', (job, err) => {
      if (job?.name === 'schedule-tick') {
        log.error({ job: job.name, err: sanitizeMessage(err) }, 'sync tick failed');
      }
    });
    await scheduleResumeStalled(syncQueue);
    await scheduleSyncTick(syncQueue);
  } else {
    log.info('sync worker disabled');
  }

  // The webhook worker needs the database but not ENCRYPTION_KEY.
  let webhookWorker: ReturnType<typeof createWebhookWorker> | undefined;
  let webhookQueue: Queue | undefined;
  if (db) {
    const connections = createConnectionsApi(db.pool);
    webhookQueue = new Queue(WEBHOOK_QUEUE, { connection });
    const enqueuer = new BullMqWebhookEnqueuer(webhookQueue);
    // Nudges need the sync queue; without it (no ENCRYPTION_KEY) a nudge topic ends `ignored`.
    const sync = syncQueue ? { queue: new BullMqJobQueue(syncQueue) } : undefined;
    webhookWorker = createWebhookWorker(
      {
        handle: (job) => processWebhookEvent({ db, connections, sync }, job),
        sweep: () =>
          sweepStaleWebhookEvents({
            connections,
            enqueuer,
            onError: (message) => log.warn({ err: message }, 'webhook sweep enqueue failed'),
          }),
      },
      connection,
    );
    // Log the job name only: webhook payloads are tenant data.
    webhookWorker.on('completed', (job) => log.info({ job: job.name }, 'webhook job completed'));
    webhookWorker.on('failed', (job, err) =>
      log.error({ job: job?.name, err: sanitizeMessage(err) }, 'webhook job failed'),
    );
    await scheduleWebhookSweep(webhookQueue);
  } else {
    log.info('webhook worker disabled');
  }

  const shutdown = async () => {
    await syncWorker?.close();
    await syncQueue?.close();
    await webhookWorker?.close();
    await webhookQueue?.close();
    await db?.close();
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
