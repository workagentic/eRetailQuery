import type {
  JobQueue,
  RateLimitDecision,
  RateLimitPolicy,
  RateLimiter,
  SyncPageJob,
} from './ports';

export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly clock: () => number = Date.now) {}

  async take(key: string, cost: number, policy: RateLimitPolicy): Promise<RateLimitDecision> {
    if (cost > policy.capacity)
      throw new RangeError(`cost ${cost} exceeds bucket capacity ${policy.capacity}`);
    const now = this.clock();
    const bucket = this.buckets.get(key) ?? { tokens: policy.capacity, at: now };
    const refilled = Math.min(
      policy.capacity,
      bucket.tokens + ((now - bucket.at) / 1000) * policy.refillPerSecond,
    );
    if (refilled >= cost) {
      this.buckets.set(key, { tokens: refilled - cost, at: now });
      return { allowed: true };
    }
    this.buckets.set(key, { tokens: refilled, at: now });
    return {
      allowed: false,
      retryAfterMs: Math.ceil(((cost - refilled) / policy.refillPerSecond) * 1000),
    };
  }
}

export class InMemoryJobQueue implements JobQueue {
  private readonly jobs: { job: SyncPageJob; delayMs: number }[] = [];

  async enqueue(job: SyncPageJob, opts: { delayMs?: number } = {}): Promise<void> {
    this.jobs.push({ job, delayMs: opts.delayMs ?? 0 });
  }
  get size(): number {
    return this.jobs.length;
  }
  take(): { job: SyncPageJob; delayMs: number } | undefined {
    return this.jobs.shift();
  }
}
