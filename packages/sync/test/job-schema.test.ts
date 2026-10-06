import { describe, expect, it } from 'vitest';
import { parseSyncPageJob } from '../src/job-schema';

const base = {
  orgId: '11111111-1111-4111-8111-111111111111',
  connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  resource: 'orders',
  syncRunId: '99999999-9999-4999-8999-999999999999',
};

describe('parseSyncPageJob', () => {
  it('accepts a valid job, with and without a chain', () => {
    expect(parseSyncPageJob(base)).toEqual(base);
    const chained = {
      ...base,
      then: {
        resources: ['inventory', 'orders'],
        mode: 'backfill',
        since: '2026-01-01T00:00:00.000Z',
      },
    };
    expect(parseSyncPageJob(chained)).toEqual(chained);
  });
  it.each([
    [{ ...base, orgId: 'nope' }],
    [{ ...base, resource: 'customers' }],
    [{ ...base, syncRunId: undefined }],
    [null],
    ['x'],
    [{ ...base, then: { resources: ['bogus'], mode: 'backfill', since: null } }],
    [{ ...base, then: { resources: [], mode: 'weekly', since: null } }],
  ])('rejects %j', (data) => {
    expect(() => parseSyncPageJob(data)).toThrow();
  });
  it('parses a job without a chain and does not invent one', () => {
    const job = parseSyncPageJob(base);
    expect(job).toEqual(base);
    expect('then' in job).toBe(false);
  });
  it('rejects unknown keys so credentials can never travel in job data', () => {
    expect(() => parseSyncPageJob({ ...base, accessToken: 'shpat_x' })).toThrow();
  });
  it('rejects a backfill chain without since, accepts an incremental chain without since', () => {
    expect(() =>
      parseSyncPageJob({
        ...base,
        then: { resources: ['products'], mode: 'backfill', since: null },
      }),
    ).toThrow(/a backfill chain requires since/);
    expect(() =>
      parseSyncPageJob({
        ...base,
        then: { resources: ['products'], mode: 'backfill', since: '2026-01-01T00:00:00.000Z' },
      }),
    ).not.toThrow();
    expect(() =>
      parseSyncPageJob({
        ...base,
        then: { resources: ['products'], mode: 'incremental', since: null },
      }),
    ).not.toThrow();
  });
});
