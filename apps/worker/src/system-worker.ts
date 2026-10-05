import { Worker, type ConnectionOptions, type Job } from 'bullmq';

export const SYSTEM_QUEUE = 'system';

export async function processSystemJob(job: Job): Promise<{ ok: true; at: string }> {
  if (job.name !== 'health') throw new Error(`unknown job: ${job.name}`);
  return { ok: true, at: new Date().toISOString() };
}

export function createSystemWorker(connection: ConnectionOptions): Worker {
  return new Worker(SYSTEM_QUEUE, processSystemJob, { connection });
}
