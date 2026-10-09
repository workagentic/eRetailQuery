import { FakeShopify } from '@erq/connectors/testing';
import { describe, expect, it } from 'vitest';
import { workerRefreshFn } from '../src/sync/tokens';

describe('workerRefreshFn', () => {
  it('is undefined without the app key and secret (refresh is not configured)', () => {
    expect(workerRefreshFn({})).toBeUndefined();
    expect(workerRefreshFn({ SHOPIFY_API_KEY: 'k' })).toBeUndefined();
    expect(workerRefreshFn({ SHOPIFY_API_KEY: ' ', SHOPIFY_API_SECRET: 's' })).toBeUndefined();
  });
  it('refreshes with the app key and secret from the environment', async () => {
    const http = new FakeShopify({ refreshToken: 'shprt_w' });
    http.acceptRefreshToken('shprt_w_old');
    const refresh = workerRefreshFn({ SHOPIFY_API_KEY: 'k', SHOPIFY_API_SECRET: 's3cret' }, http)!;
    const grant = await refresh({ shop: 'a.myshopify.com', refreshToken: 'shprt_w_old' });
    expect(grant.refreshToken).toBe('shprt_w_1');
    expect(Object.fromEntries(new URLSearchParams(http.requests[0]!.body!))).toEqual({
      client_id: 'k',
      client_secret: 's3cret',
      grant_type: 'refresh_token',
      refresh_token: 'shprt_w_old',
    });
  });
});
