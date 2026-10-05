import { UnrecoverableError, type Job } from 'bullmq';
import type { TenantDb, Tx } from '@erq/db';
import { uuidSchema } from '@erq/shared';

/**
 * Wraps a job handler so it always runs inside withTenant(job.data.orgId).
 * A job without a valid orgId can never succeed, so it fails without retries.
 */
export function tenantJob<D extends { orgId: string }, R>(
  db: Pick<TenantDb, 'withTenant'>,
  handler: (job: Job<D>, tx: Tx) => Promise<R>,
): (job: Job<D>) => Promise<R> {
  return async (job) => {
    const orgId: unknown = job.data?.orgId;
    if (!uuidSchema.safeParse(orgId).success) {
      throw new UnrecoverableError('job is missing a valid orgId');
    }
    return db.withTenant(orgId as string, (tx) => handler(job, tx));
  };
}
