import { describe, expect, it } from 'vitest';
import { DEFAULT_RATE_LIMIT_POLICY, policyFor } from '../src';

describe('rate-limit policies', () => {
  it('uses the Shopify cost bucket for shopify and the default for unknown platforms', () => {
    expect(policyFor('shopify')).toEqual({ capacity: 1000, refillPerSecond: 50, costPerPage: 100 });
    expect(policyFor('woocommerce')).toEqual(DEFAULT_RATE_LIMIT_POLICY);
  });
  it('lets a per-deployment override win', () => {
    expect(
      policyFor('shopify', { shopify: { capacity: 2000, refillPerSecond: 100, costPerPage: 100 } })
        .capacity,
    ).toBe(2000);
  });
});
