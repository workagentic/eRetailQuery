import type { RateLimitPolicy } from './ports';

/**
 * Conservative generic default for a platform without its own entry below. Each platform gets its
 * own policy once its current rate-limit documentation has been read (Shopify: see below).
 */
export const DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicy = {
  capacity: 10,
  refillPerSecond: 2,
  costPerPage: 1,
};

export const RATE_LIMIT_POLICIES: Record<string, RateLimitPolicy> = {
  // Shopify's GraphQL Admin API uses a calculated-cost leaky bucket; the standard plan is a
  // 1000-point bucket restoring 50 points/second. Plans above standard (Advanced, Plus) have
  // larger buckets and faster restore rates, so this policy is conservative for them; the
  // connector waits out THROTTLED responses in place and RateLimitedError covers the rest.
  // https://shopify.dev/docs/api/usage/rate-limits
  // The limiter charges a fixed costPerPage before each fetch and does not see the page's
  // reported cost. A page requests 300-850 points but Shopify bills the actual cost, usually far
  // lower, so 100 is an estimate of the actual cost: at 50 points/s that sustains about one page
  // every 2 seconds with a burst of 10 pages. Charging the requested cost would throttle needlessly.
  // First-install checklist: compare real extensions.cost.actualQueryCost with 100 and adjust.
  shopify: { capacity: 1000, refillPerSecond: 50, costPerPage: 100 },
};

export function policyFor(
  platform: string,
  overrides: Record<string, RateLimitPolicy> = {},
): RateLimitPolicy {
  return overrides[platform] ?? RATE_LIMIT_POLICIES[platform] ?? DEFAULT_RATE_LIMIT_POLICY;
}
