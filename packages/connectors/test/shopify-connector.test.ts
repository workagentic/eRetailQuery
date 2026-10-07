import { describe, expect, it } from 'vitest';
import {
  AuthError,
  createShopifyConnector,
  ORDERS_PAGE_SIZE,
  PermanentError,
  SYNC_RESOURCES,
  type FetchOptions,
  type Page,
  type SyncResource,
} from '../src';
import { runConnectorContract } from '../src/testing/contract';
import { createShopifyFixture } from '../src/testing';

runConnectorContract({
  name: 'shopify (fixture)',
  create() {
    const { admin, ctx } = createShopifyFixture();
    return { connector: createShopifyConnector({ http: admin }), ctx };
  },
});

async function drain(resource: SyncResource, options: FetchOptions = {}, extraOrders = 0) {
  const { admin, ctx, expected } = createShopifyFixture({ extraOrders });
  const connector = createShopifyConnector({ http: admin });
  const items: unknown[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let cost = 0;
  do {
    const page: Page<unknown> = await connector.fetchPage(ctx, resource, cursor, options);
    items.push(...page.items);
    cost += page.cost ?? 0;
    cursor = page.nextCursor;
    pages++;
  } while (cursor !== null);
  return { items, expected, pages, admin, cost };
}

const ids = (items: unknown[]) => (items as { externalId: string }[]).map((i) => i.externalId);

describe('createShopifyConnector', () => {
  it.each(SYNC_RESOURCES)('returns exactly the expected normalized %s', async (resource) => {
    const { items, expected, cost } = await drain(resource);
    expect(items).toEqual(expected[resource]);
    expect(cost).toBeGreaterThan(0);
  });

  it('pages orders across several requests, in order and without gaps', async () => {
    const extra = 70;
    // Several pages need more orders than one page holds; 70 extra orders cover that only while the
    // page stays small, so raising the page size must also raise `extra`.
    expect(ORDERS_PAGE_SIZE).toBeLessThan(75);
    const { items, expected, pages } = await drain('orders', {}, extra);
    expect(items).toHaveLength(5 + extra);
    expect(pages).toBe(Math.ceil((5 + extra) / ORDERS_PAGE_SIZE));
    expect(items).toEqual(expected.orders);
  });

  it('only returns rows changed since updatedSince', async () => {
    const since = { updatedSince: new Date('2026-02-15T00:00:00Z') };
    const products = await drain('products', since);
    expect(ids(products.items)).toEqual(['gid://shopify/Product/102', 'gid://shopify/Product/103']);
    // Inventory ignores updatedSince and always reads every level (quantity-only changes do not
    // move updated_at), so an incremental still refreshes stock.
    const inventory = await drain('inventory', since);
    expect(inventory.items).toEqual(inventory.expected.inventory);
    expect(
      inventory.admin.requests.map((r) => JSON.parse(r.body!).variables.query as unknown),
    ).toEqual(inventory.admin.requests.map(() => null));
    const orders = await drain('orders', { updatedSince: new Date('2026-03-03T00:00:00Z') });
    expect(ids(orders.items)).toEqual([
      'gid://shopify/Order/3003',
      'gid://shopify/Order/3004',
      'gid://shopify/Order/3005',
    ]);
  });

  it('only returns orders created since the backfill start date', async () => {
    const orders = await drain('orders', { since: new Date('2026-03-04T00:00:00Z') });
    expect(ids(orders.items)).toEqual(['gid://shopify/Order/3004', 'gid://shopify/Order/3005']);
  });

  it('never asks Shopify for customer, marketing or other protected fields', async () => {
    const orders = await drain('orders');
    const products = await drain('products');
    const documents = [...orders.admin.requests, ...products.admin.requests]
      .map((r) => (JSON.parse(r.body!) as { query: string }).query)
      .join('\n');
    expect(documents).toContain('ErqOrders');
    expect(documents).not.toMatch(
      /customer\b|email|phone|shippingAddress|billingAddress|customerJourney|landingPage|utm/i,
    );
  });

  it('sends the access token only as a header, to the connected shop', async () => {
    const { admin } = await drain('locations');
    expect(admin.requests).toHaveLength(1);
    const req = admin.requests[0]!;
    expect(req.url).toMatch(
      /^https:\/\/fixture-shop\.myshopify\.com\/admin\/api\/[\w-]+\/graphql\.json$/,
    );
    expect(req.headers?.['X-Shopify-Access-Token']).toBe('shpat_fixture');
    expect(req.body).not.toContain('shpat_fixture');
  });

  it('rejects unusable credentials as an auth error without a request', async () => {
    const { admin, ctx } = createShopifyFixture();
    const connector = createShopifyConnector({ http: admin });
    const err = await connector
      .fetchPage({ ...ctx, credentials: { nope: true } }, 'orders', null, {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(admin.requests).toHaveLength(0);
  });

  it('rejects an invalid shop domain as permanent for every resource without a request', async () => {
    const { admin, ctx } = createShopifyFixture();
    const connector = createShopifyConnector({ http: admin });
    for (const resource of SYNC_RESOURCES) {
      const err = await connector
        .fetchPage({ ...ctx, externalAccountId: 'evil.com' }, resource, null, {})
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PermanentError);
    }
    expect(admin.requests).toHaveLength(0);
  });

  it('rejects a tampered cursor for every resource before any request', async () => {
    const { admin, ctx } = createShopifyFixture();
    const connector = createShopifyConnector({ http: admin });
    for (const resource of SYNC_RESOURCES) {
      await expect(connector.fetchPage(ctx, resource, 'not a cursor!', {})).rejects.toThrow(
        'Invalid sync cursor.',
      );
    }
    expect(admin.requests).toHaveLength(0);
  });

  it('rejects connect() and ignores webhooks', async () => {
    const { admin } = createShopifyFixture();
    const connector = createShopifyConnector({ http: admin });
    const err = await connector.connect({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as Error).message).toBe(
      'Shopify connections are created through the install flow.',
    );
    await expect(connector.handleWebhook({}, {})).resolves.toBeUndefined();
    expect(admin.requests).toHaveLength(0);
  });

  it('rejects an unknown resource without a request', async () => {
    const { admin, ctx } = createShopifyFixture();
    const connector = createShopifyConnector({ http: admin });
    await expect(connector.fetchPage(ctx, 'nope' as SyncResource, null, {})).rejects.toBeInstanceOf(
      PermanentError,
    );
    expect(admin.requests).toHaveLength(0);
  });
});

describe('createShopifyFixture follow-up operations', () => {
  it('serves later pages of variants, inventory levels and order lines', async () => {
    const { admin, ctx } = createShopifyFixture();
    const post = async (operationName: string, variables: Record<string, unknown>) => {
      const res = await admin.request({
        method: 'POST',
        url: `https://${ctx.externalAccountId}/admin/api/x/graphql.json`,
        headers: {},
        body: JSON.stringify({ operationName, query: '', variables }),
      });
      return (JSON.parse(res.body) as { data: any }).data; // eslint-disable-line @typescript-eslint/no-explicit-any -- inspecting an untyped fake response
    };
    const variants = await post('ErqProductVariants', {
      id: 'gid://shopify/Product/101',
      first: 1,
      after: '0',
    });
    expect(variants.product.variants.nodes.map((n: { id: string }) => n.id)).toEqual([
      'gid://shopify/ProductVariant/1002',
    ]);
    expect(variants.product.variants.pageInfo).toEqual({ hasNextPage: false, endCursor: '1' });
    const levels = await post('ErqInventoryLevels', {
      id: 'gid://shopify/InventoryItem/2001',
      first: 1,
      after: null,
    });
    expect(levels.inventoryItem.inventoryLevels.nodes).toHaveLength(1);
    expect(levels.inventoryItem.inventoryLevels.pageInfo.hasNextPage).toBe(true);
    const lines = await post('ErqOrderLines', {
      id: 'gid://shopify/Order/3001',
      first: 1,
      after: '0',
    });
    expect(lines.order.lineItems.nodes.map((n: { id: string }) => n.id)).toEqual([
      'gid://shopify/LineItem/4002',
    ]);
  });
});
