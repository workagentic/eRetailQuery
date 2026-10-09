import { describe, expect, it } from 'vitest';
import {
  AuthError,
  registerWebhooks,
  SHOPIFY_FUTURE_DATA_WEBHOOK_TOPICS,
  SHOPIFY_WEBHOOK_TOPICS,
} from '../src';
import { FakeShopify } from '../src/testing';

const p = {
  shop: 'a.myshopify.com',
  accessToken: 'shpat_x',
  callbackUrl: 'https://api.example.com/webhooks/shopify',
  apiVersion: '2025-07',
};

describe('registerWebhooks', () => {
  it('registers the three subscribed topics by default, once each, and is idempotent on a second call', async () => {
    const http = new FakeShopify();
    const first = await registerWebhooks(http, p);
    const topics = ['app/uninstalled', 'products/update', 'inventory_levels/update'];
    expect(first.failed).toEqual([]);
    expect(first.registered).toEqual(topics);
    expect([...SHOPIFY_WEBHOOK_TOPICS]).toEqual(topics);
    expect([...http.subscriptions.keys()]).toEqual(topics);
    expect(http.subscriptions.get('products/update')).toBe(p.callbackUrl);
    expect(http.requests).toHaveLength(3);
    const second = await registerWebhooks(http, p);
    expect(second.failed).toEqual([]);
    expect(second.registered).toEqual(topics); // "already taken" counts as registered
  });
  it('never subscribes to order, refund or customer topics by default (protected customer data)', () => {
    for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
      expect(topic).not.toMatch(/^(orders|refunds|customers)\//);
    }
    for (const topic of SHOPIFY_FUTURE_DATA_WEBHOOK_TOPICS) {
      expect(SHOPIFY_WEBHOOK_TOPICS as readonly string[]).not.toContain(topic);
    }
  });
  it('reports a rejected subscription as failed and still registers the others', async () => {
    const http = new FakeShopify({ rejectTopics: new Set(['products/update']) });
    const res = await registerWebhooks(http, p);
    expect(res.failed).toEqual(['products/update']);
    expect(res.registered).toEqual(['app/uninstalled', 'inventory_levels/update']);
    expect([...http.subscriptions.keys()]).toEqual(['app/uninstalled', 'inventory_levels/update']);
  });
  it('keeps the subscription mutation tiny: one object, no connection, no pagination', async () => {
    const http = new FakeShopify();
    await registerWebhooks(http, { ...p, topics: ['products/update'] });
    const { query } = JSON.parse(http.requests[0]!.body!) as { query: string };
    expect(query).not.toMatch(/\bfirst\b|nodes|edges|pageInfo/);
    expect(query.length).toBeLessThan(400);
  });
  it('still registers the future data topics when asked (1b-3)', async () => {
    const http = new FakeShopify();
    const res = await registerWebhooks(http, { ...p, topics: SHOPIFY_FUTURE_DATA_WEBHOOK_TOPICS });
    expect(res.failed).toEqual([]);
    expect([...res.registered].sort()).toEqual([...SHOPIFY_FUTURE_DATA_WEBHOOK_TOPICS].sort());
    expect(http.subscriptions.get('orders/updated')).toBe(p.callbackUrl);
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
