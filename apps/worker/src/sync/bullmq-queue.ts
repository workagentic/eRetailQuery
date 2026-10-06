import type { Queue } from 'bullmq';
import type { JobQueue, SyncPageJob } from '@erq/sync';

export const SYNC_QUEUE = 'sync';

/** Transient failures retry 5 times with exponential backoff; a rate-limit delay is a new delayed job, not a retry. */
export class BullMqJobQueue implements JobQueue {
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
