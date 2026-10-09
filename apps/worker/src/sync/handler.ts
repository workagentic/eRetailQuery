import { UnrecoverableError } from 'bullmq';
import {
  parseSyncPageJob,
  processSyncPage,
  resumeStalledRuns,
  runSchedulerTick,
  type SchedulerDeps,
} from '@erq/sync';

const STALL_AFTER_MS = 10 * 60 * 1000;

/** The queue-facing logic: validate, process one page, enqueue what comes next; or run a scheduled job. */
export async function handleSyncJob(
  deps: SchedulerDeps,
  job: { name: string; data: unknown },
  impl: {
    processSyncPage: typeof processSyncPage;
    resumeStalledRuns: typeof resumeStalledRuns;
    runSchedulerTick?: typeof runSchedulerTick;
  } = { processSyncPage, resumeStalledRuns },
): Promise<void> {
  if (job.name === 'schedule-tick') {
    await (impl.runSchedulerTick ?? runSchedulerTick)(deps);
    return;
  }
  if (job.name === 'resume-stalled') {
    const now = (deps.now ?? (() => new Date()))();
    await impl.resumeStalledRuns(deps, new Date(now.getTime() - STALL_AFTER_MS));
    return;
  }
  let data;
  try {
    data = parseSyncPageJob(job.data);
  } catch {
    throw new UnrecoverableError('invalid sync job payload'); // never retry, never log the payload
  }
  const result = await impl.processSyncPage(deps, data);
  switch (result.kind) {
    case 'next':
      await deps.queue.enqueue(result.job);
      break;
    case 'delayed':
      await deps.queue.enqueue(data, { delayMs: result.delayMs });
      break;
    case 'done':
      if (result.followUp) await deps.queue.enqueue(result.followUp);
      break;
    case 'failed':
      break;
  }
}
