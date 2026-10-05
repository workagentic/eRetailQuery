import { UnrecoverableError, type Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { TenantDb, Tx } from '@erq/db';
import { tenantJob } from '../src/tenant-job';

const ORG = '11111111-1111-4111-8111-111111111111';
const fakeDb = () =>
  ({
    withTenant: vi.fn(async (_org: string, fn: (tx: Tx) => Promise<unknown>) => fn({} as Tx)),
  }) as unknown as Pick<TenantDb, 'withTenant'>; // the real withTenant is generic; the mock is not
const job = (data: unknown) => ({ data }) as Job<{ orgId: string }>;

describe('tenantJob', () => {
  it('runs the handler inside withTenant for the job org', async () => {
    const db = fakeDb();
    const handler = vi.fn(async () => 'done');
    const result = await tenantJob(db, handler)(job({ orgId: ORG }));
    expect(result).toBe('done');
    expect(db.withTenant).toHaveBeenCalledWith(ORG, expect.any(Function));
  });
  it.each([{}, { orgId: 'nope' }, { orgId: null }, undefined])(
    'fails permanently (no retries) when orgId is missing or invalid: %j',
    async (data) => {
      const db = fakeDb();
      const handler = vi.fn();
      await expect(tenantJob(db, handler)(job(data))).rejects.toBeInstanceOf(UnrecoverableError);
      expect(db.withTenant).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    },
  );
  it('propagates handler errors so BullMQ can retry', async () => {
    const db = fakeDb();
    await expect(
      tenantJob(db, async () => {
        throw new Error('boom');
      })(job({ orgId: ORG })),
    ).rejects.toThrow('boom');
  });
});
