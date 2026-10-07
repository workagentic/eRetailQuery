import { describe, expect, it } from 'vitest';
import { DEFAULT_SHOPIFY_SCOPES } from '../src';

describe('DEFAULT_SHOPIFY_SCOPES', () => {
  it('requests the read scopes the sync needs plus read_all_orders, and nothing protected', () => {
    expect(DEFAULT_SHOPIFY_SCOPES).toEqual([
      'read_products',
      'read_inventory',
      'read_locations',
      'read_orders',
      'read_all_orders',
    ]);
    expect(DEFAULT_SHOPIFY_SCOPES.some((s) => /customer|write_/.test(s))).toBe(false);
  });
});
