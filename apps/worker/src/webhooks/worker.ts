import { UnrecoverableError, Worker, type ConnectionOptions, type Queue } from 'bullmq';
import { WEBHOOK_QUEUE, webhookJobSchema, type WebhookJob } from '@erq/shared';

export interface WebhookEnqueuer {
  enqueue(job: WebhookJob): Promise<void>;
}

/** Same deterministic job id and options as the API's queue, so a sweep never duplicates a live job. BullMQ ids may not contain ':'. */
export class BullMqWebhookEnqueuer implements WebhookEnqueuer {
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

export interface WebhookHandlers {
  handle(job: WebhookJob): Promise<unknown>;
  sweep(): Promise<unknown>;
}

export function createWebhookWorker(
  handlers: WebhookHandlers,
  connection: ConnectionOptions,
  opts: { concurrency?: number } = {},
): Worker {
  return new Worker(
    WEBHOOK_QUEUE,
    async (job) => {
      if (job.name === 'sweep') return handlers.sweep();
      if (job.name === 'webhook') {
        const parsed = webhookJobSchema.safeParse(job.data);
        if (!parsed.success) throw new UnrecoverableError('invalid webhook job data');
        return handlers.handle(parsed.data);
      }
      throw new UnrecoverableError(`unknown job name ${job.name}`);
    },
    { connection, concurrency: opts.concurrency ?? 5 },
  );
}

/** Every 5 minutes, re-enqueue events the API stored but never managed to queue. */
export async function scheduleWebhookSweep(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler('webhook-sweep', { every: 300_000 }, { name: 'sweep' });
}
