import { describe, expect, it } from 'vitest';
import { AuthError, registerWebhooks, SHOPIFY_DATA_WEBHOOK_TOPICS } from '../src';
import { FakeShopify } from '../src/testing';

const p = {
  shop: 'a.myshopify.com',
  accessToken: 'shpat_x',
  callbackUrl: 'https://api.example.com/webhooks/shopify',
  apiVersion: '2025-07',
};

describe('registerWebhooks', () => {
  it('registers every topic once and is idempotent on a second call', async () => {
    const http = new FakeShopify();
    const first = await registerWebhooks(http, p);
    expect(first.failed).toEqual([]);
    expect([...first.registered].sort()).toEqual([...SHOPIFY_DATA_WEBHOOK_TOPICS].sort());
    expect(http.subscriptions.get('orders/updated')).toBe(p.callbackUrl);
    const second = await registerWebhooks(http, p);
    expect(second.failed).toEqual([]);
    expect(second.registered).toHaveLength(SHOPIFY_DATA_WEBHOOK_TOPICS.length);
  });
  it('sends the token as a header, targets the versioned GraphQL endpoint, keeps the token out of the body', async () => {
    const http = new FakeShopify();
    await registerWebhooks(http, { ...p, topics: ['orders/create'] });
    const req = http.requests[0]!;
    expect(req.url).toBe('https://a.myshopify.com/admin/api/2025-07/graphql.json');
    expect(req.headers?.['X-Shopify-Access-Token']).toBe('shpat_x');
    expect(req.body).not.toContain('shpat_x');
    expect(req.body).toContain('ORDERS_CREATE');
  });
  it('reports a topic as failed on user errors and throws AuthError on 401', async () => {
    const http = new FakeShopify();
    http.respondNext({
      status: 200,
      body: JSON.stringify({
        data: { webhookSubscriptionCreate: { userErrors: [{ message: 'Invalid topic' }] } },
      }),
    });
    const res = await registerWebhooks(http, { ...p, topics: ['orders/create', 'orders/updated'] });
    expect(res.failed).toEqual(['orders/create']);
    expect(res.registered).toEqual(['orders/updated']);
    const denied = new FakeShopify();
    denied.failNext(401);
    await expect(registerWebhooks(denied, p)).rejects.toBeInstanceOf(AuthError);
  });
  it('rejects an invalid shop', async () => {
    await expect(
      registerWebhooks(new FakeShopify(), { ...p, shop: 'evil.com' }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
