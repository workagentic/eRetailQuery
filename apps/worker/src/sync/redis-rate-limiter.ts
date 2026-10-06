import type { Redis } from 'ioredis';
import type { RateLimitDecision, RateLimitPolicy, RateLimiter } from '@erq/sync';

// Atomic token bucket. Uses the Redis clock so worker clock skew cannot matter.
const SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = capacity; ts = now end
tokens = math.min(capacity, tokens + ((now - ts) / 1000) * refill)
local allowed = 0
local retry = 0
if tokens >= cost then tokens = tokens - cost; allowed = 1 else retry = math.ceil(((cost - tokens) / refill) * 1000) end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], 3600000)
return { allowed, retry }
`;

type WithCommand = Redis & {
  erqTakeTokens(
    key: string,
    capacity: number,
    refill: number,
    cost: number,
  ): Promise<[number, number]>;
};

export class RedisRateLimiter implements RateLimiter {
  private readonly redis: WithCommand;

  constructor(redis: Redis) {
    if (!('erqTakeTokens' in redis))
      redis.defineCommand('erqTakeTokens', { numberOfKeys: 1, lua: SCRIPT });
    this.redis = redis as WithCommand;
  }

  async take(key: string, cost: number, policy: RateLimitPolicy): Promise<RateLimitDecision> {
    if (cost > policy.capacity)
      throw new RangeError(`cost ${cost} exceeds bucket capacity ${policy.capacity}`);
    const [allowed, retryAfterMs] = await this.redis.erqTakeTokens(
      `ratelimit:${key}`,
      policy.capacity,
      policy.refillPerSecond,
      cost,
    );
    return allowed === 1 ? { allowed: true } : { allowed: false, retryAfterMs };
  }
}
