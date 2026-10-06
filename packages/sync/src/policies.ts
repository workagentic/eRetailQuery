import type { RateLimitPolicy } from './ports';

/** Conservative generic default. Real per-platform limits are set in 1b-2/1b-3 after reading each platform's current documentation. */
export const DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicy = {
  capacity: 10,
  refillPerSecond: 2,
  costPerPage: 1,
};

export const RATE_LIMIT_POLICIES: Record<string, RateLimitPolicy> = {
  shopify: { capacity: 10, refillPerSecond: 2, costPerPage: 1 },
};

export function policyFor(
  platform: string,
  overrides: Record<string, RateLimitPolicy> = {},
): RateLimitPolicy {
  return overrides[platform] ?? RATE_LIMIT_POLICIES[platform] ?? DEFAULT_RATE_LIMIT_POLICY;
}
