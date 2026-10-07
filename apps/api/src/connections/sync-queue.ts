import type { Queue } from 'bullmq';
import type { JobQueue, SyncPageJob } from '@erq/sync';

/** Queue name and job options mirror the consumer's contract in apps/worker/src/sync/bullmq-queue.ts. */
export const SYNC_QUEUE_NAME = 'sync';

export interface SyncQueuePort extends JobQueue {
  /** False when no Redis is configured: nothing can be enqueued. */
  readonly available: boolean;
}

export class BullMqSyncQueue implements SyncQueuePort {
  readonly available = true;
  constructor(private readonly queue: Queue) {}

  async enqueue(job: SyncPageJob, opts: { delayMs?: number } = {}): Promise<void> {
    await this.queue.add('page', job, {
      delay: opts.delayMs,
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    });
  }
}

export class NoopSyncQueue implements SyncQueuePort {
  readonly available = false;
  async enqueue(): Promise<void> {
    // No REDIS_URL: syncs cannot start from the API.
  }
}
