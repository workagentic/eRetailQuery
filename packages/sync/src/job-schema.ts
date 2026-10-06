import { z } from 'zod';
import type { SyncPageJob } from './ports';

const resource = z.enum(['products', 'locations', 'inventory', 'orders']);
const schema = z
  .object({
    orgId: z.string().uuid(),
    connectionId: z.string().uuid(),
    resource,
    syncRunId: z.string().uuid(),
    then: z
      .object({
        resources: z.array(resource),
        mode: z.enum(['backfill', 'incremental']),
        since: z.string().datetime().nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Validates queue payloads. Strict: unknown keys (for example credentials) are rejected. */
export function parseSyncPageJob(data: unknown): SyncPageJob {
  return schema.parse(data) as SyncPageJob;
}
