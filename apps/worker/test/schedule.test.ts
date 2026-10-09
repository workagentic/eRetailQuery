import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { scheduleSyncTick } from '../src/sync/worker';

describe('scheduleSyncTick', () => {
  it('upserts ONE scheduler with a fixed id every 60 seconds, so restarts do not multiply it', async () => {
    const upsert = vi.fn(async () => undefined);
    const queue = { upsertJobScheduler: upsert } as unknown as Queue;
    await scheduleSyncTick(queue);
    await scheduleSyncTick(queue); // a restart
    expect(upsert).toHaveBeenCalledTimes(2);
    for (const call of upsert.mock.calls) {
      expect(call).toEqual(['sync-tick', { every: 60_000 }, { name: 'schedule-tick', data: {} }]);
    }
  });
});
