import { UnrecoverableError, Worker, type ConnectionOptions, type Queue } from 'bullmq';
import { failSyncRun, parseSyncPageJob, type SyncDeps } from '@erq/sync';
import { SYNC_QUEUE } from './bullmq-queue';
import { handleSyncJob } from './handler';

export function createSyncWorker(
  deps: SyncDeps,
  connection: ConnectionOptions,
  opts: { concurrency?: number } = {},
): Worker {
  const worker = new Worker(SYNC_QUEUE, (job) => handleSyncJob(deps, job), {
    connection,
    concurrency: opts.concurrency ?? 5,
  });
  // After the last attempt, record the failure on the run so the owner sees it. The raw message is
  // passed on and failSyncRun sanitizes it before storing (members can read cursor errors).
  worker.on('failed', (job, error) => {
    if (!job || job.name !== 'page') return;
    const finalAttempt =
      error instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!finalAttempt) return;
    try {
      void failSyncRun(deps, parseSyncPageJob(job.data), error.message).catch(() => undefined);
    } catch {
      /* invalid payload: there is no run to mark */
    }
  });
  return worker;
}

/** Every 5 minutes, re-enqueue runs whose cursor has not moved for 10 minutes. */
export async function scheduleResumeStalled(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    'resume-stalled',
    { every: 300_000 },
    { name: 'resume-stalled', data: {} },
  );
}
