import { describe, expect, it } from 'vitest';
import { InMemoryJobQueue, MemoryRateLimiter } from '../src/memory';
import { DEFAULT_RATE_LIMIT_POLICY, RATE_LIMIT_POLICIES, policyFor } from '../src/policies';

const policy = { capacity: 3, refillPerSecond: 1, costPerPage: 1 };

describe('MemoryRateLimiter (token bucket)', () => {
  it('allows up to capacity, then tells the caller how long to wait', async () => {
    const now = 0;
    const limiter = new MemoryRateLimiter(() => now);
    for (let i = 0; i < 3; i++)
      expect(await limiter.take('k', 1, policy)).toEqual({ allowed: true });
    expect(await limiter.take('k', 1, policy)).toEqual({ allowed: false, retryAfterMs: 1000 });
  });
  it('refills over time, never above capacity', async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(() => now);
    for (let i = 0; i < 3; i++) await limiter.take('k', 1, policy);
    now = 1000;
    expect(await limiter.take('k', 1, policy)).toEqual({ allowed: true });
    expect((await limiter.take('k', 1, policy)).allowed).toBe(false);
    now = 3_600_000;
    for (let i = 0; i < 3; i++) expect((await limiter.take('k', 1, policy)).allowed).toBe(true);
    expect((await limiter.take('k', 1, policy)).allowed).toBe(false);
  });
  it('keeps keys independent', async () => {
    const limiter = new MemoryRateLimiter(() => 0);
    for (let i = 0; i < 3; i++) await limiter.take('a', 1, policy);
    expect((await limiter.take('a', 1, policy)).allowed).toBe(false);
    expect((await limiter.take('b', 1, policy)).allowed).toBe(true);
  });
  it('supports costs above 1 and rejects costs above capacity', async () => {
    const limiter = new MemoryRateLimiter(() => 0);
    expect(await limiter.take('k', 2, policy)).toEqual({ allowed: true });
    expect(await limiter.take('k', 2, policy)).toEqual({ allowed: false, retryAfterMs: 1000 });
    await expect(limiter.take('k', 4, policy)).rejects.toThrow(RangeError);
  });
});

describe('InMemoryJobQueue', () => {
  const job = { orgId: 'o', connectionId: 'c', resource: 'orders' as const, syncRunId: 'r' };
  it('is FIFO and records delays', async () => {
    const q = new InMemoryJobQueue();
    await q.enqueue(job);
    await q.enqueue({ ...job, resource: 'products' }, { delayMs: 500 });
    expect(q.size).toBe(2);
    expect(q.take()).toEqual({ job, delayMs: 0 });
    expect(q.take()?.delayMs).toBe(500);
    expect(q.take()).toBeUndefined();
  });
});

describe('policies', () => {
  it('uses the platform policy or the default', () => {
    expect(policyFor('shopify')).toEqual(RATE_LIMIT_POLICIES.shopify);
    expect(policyFor('woocommerce')).toEqual(DEFAULT_RATE_LIMIT_POLICY);
    expect(
      policyFor('shopify', { shopify: { capacity: 1, refillPerSecond: 1, costPerPage: 1 } })
        .capacity,
    ).toBe(1);
  });
});
