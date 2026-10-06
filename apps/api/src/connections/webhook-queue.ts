import type { WebhookJob } from '@erq/shared';
import type { Queue } from 'bullmq';

export interface WebhookQueue {
  enqueue(job: WebhookJob): Promise<void>;
}

/** Deterministic job id: the same event is never queued twice while its job is retained. BullMQ ids may not contain ':'. */
export class BullMqWebhookQueue implements WebhookQueue {
  constructor(private readonly queue: Queue) {}
  async enqueue(job: WebhookJob): Promise<void> {
    await this.queue.add('webhook', job, {
      jobId: `${job.orgId}_${job.eventId}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { count: 1_000 },
      removeOnFail: { count: 5_000 },
    });
  }
}

export class NoopWebhookQueue implements WebhookQueue {
  async enqueue(): Promise<void> {
    // No REDIS_URL: events stay 'received' and the worker's sweep processes them.
  }
}
