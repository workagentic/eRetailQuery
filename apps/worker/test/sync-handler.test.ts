import { UnrecoverableError } from 'bullmq';
import { InMemoryJobQueue, type PageResult, type SyncDeps, type SyncPageJob } from '@erq/sync';
import { describe, expect, it, vi } from 'vitest';
import { handleSyncJob } from '../src/sync/handler';

const job: SyncPageJob = {
  orgId: '11111111-1111-4111-8111-111111111111',
  connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  resource: 'orders',
  syncRunId: '99999999-9999-4999-8999-999999999999',
};
const setup = (result: PageResult) => {
  const queue = new InMemoryJobQueue();
  const deps = { queue, now: () => new Date('2026-10-06T12:00:00Z') } as unknown as SyncDeps;
  const impl = {
    processSyncPage: vi.fn(async () => result),
    resumeStalledRuns: vi.fn(async () => 0),
  };
  return { queue, deps, impl };
};

describe('handleSyncJob', () => {
  it('enqueues the next page job', async () => {
    const { queue, deps, impl } = setup({ kind: 'next', job });
    await handleSyncJob(deps, { name: 'page', data: job }, impl);
    expect(queue.take()).toEqual({ job, delayMs: 0 });
  });
  it('re-enqueues a delayed job with its delay', async () => {
    const { queue, deps, impl } = setup({ kind: 'delayed', delayMs: 2500 });
    await handleSyncJob(deps, { name: 'page', data: job }, impl);
    expect(queue.take()).toEqual({ job, delayMs: 2500 });
  });
  it('enqueues the follow-up when a resource finishes, and nothing otherwise', async () => {
    const followUp = { ...job, resource: 'products' as const };
    const a = setup({ kind: 'done', followUp });
    await handleSyncJob(a.deps, { name: 'page', data: job }, a.impl);
    expect(a.queue.take()).toEqual({ job: followUp, delayMs: 0 });
    const b = setup({ kind: 'done' });
    await handleSyncJob(b.deps, { name: 'page', data: job }, b.impl);
    const c = setup({ kind: 'failed', reason: 'x' });
    await handleSyncJob(c.deps, { name: 'page', data: job }, c.impl);
    expect(b.queue.size + c.queue.size).toBe(0);
  });
  it('rejects malformed job data permanently, without processing it', async () => {
    const { deps, impl } = setup({ kind: 'done' });
    await expect(
      handleSyncJob(deps, { name: 'page', data: { ...job, orgId: 'nope' } }, impl),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(
      handleSyncJob(deps, { name: 'page', data: { ...job, accessToken: 'shpat_x' } }, impl),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(impl.processSyncPage).not.toHaveBeenCalled();
  });
  it('lets processing errors propagate so the queue retries', async () => {
    const { deps, impl } = setup({ kind: 'done' });
    impl.processSyncPage.mockRejectedValueOnce(new Error('503'));
    await expect(handleSyncJob(deps, { name: 'page', data: job }, impl)).rejects.toThrow('503');
  });
  it('resumes stalled runs older than 10 minutes on the resume-stalled job', async () => {
    const { deps, impl } = setup({ kind: 'done' });
    await handleSyncJob(deps, { name: 'resume-stalled', data: {} }, impl);
    expect(impl.resumeStalledRuns).toHaveBeenCalledWith(deps, new Date('2026-10-06T11:50:00Z'));
  });
});
