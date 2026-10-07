import { describe, expect, it } from 'vitest';
import {
  createShopifyGraphqlClient,
  decodeCursor,
  encodeCursor,
  fetchProducts,
  PermanentError,
  PRODUCTS_OP,
  PRODUCTS_PAGE_SIZE,
  VARIANTS_PAGE_SIZE,
} from '../src';
import { FakeShopifyAdmin, gqlOk, paginate, productsQueryCost } from '../src/testing';

const ctx = { externalAccountId: 'a.myshopify.com', credentials: { accessToken: 'shpat_x' } };
const variant = (n: number, over: Record<string, unknown> = {}) => ({
  id: `gid://shopify/ProductVariant/${n}`,
  sku: `SKU-${n}`,
  barcode: null,
  price: '19.99',
  compareAtPrice: null,
  updatedAt: '2026-03-01T10:00:00Z',
  inventoryItem: { unitCost: { amount: '7.50', currencyCode: 'USD' } },
  ...over,
});
const product = (n: number, variants: unknown[], over: Record<string, unknown> = {}) => ({
  id: `gid://shopify/Product/${n}`,
  title: `Product ${n}`,
  vendor: 'Acme',
  productType: 'Shirts',
  status: 'ACTIVE',
  updatedAt: '2026-03-02T10:00:00Z',
  variants: { nodes: variants, pageInfo: { hasNextPage: false, endCursor: null } },
  ...over,
});
const productsHandler =
  (items: unknown[], currency = 'USD') =>
  (v: Record<string, unknown>) =>
    gqlOk(
      {
        shop: { currencyCode: currency },
        products: paginate(items, v.first as number, (v.after as string | null) ?? null),
      },
      { requested: productsQueryCost(v.first as number, VARIANTS_PAGE_SIZE) },
    );
const gqlOf = (admin: FakeShopifyAdmin) => createShopifyGraphqlClient({ http: admin });

describe('products', () => {
  it('normalizes variants, costs, status, brand and category', async () => {
    const items = [
      product(1, [
        variant(1),
        variant(2, {
          sku: '  ',
          barcode: ' 123 ',
          compareAtPrice: '29.00',
          inventoryItem: { unitCost: null },
        }),
      ]),
      product(2, [variant(3, { inventoryItem: null, price: '5' })], {
        vendor: ' ',
        productType: '',
        status: 'DRAFT',
      }),
      product(3, [], { status: 'ARCHIVED' }),
    ];
    const admin = new FakeShopifyAdmin().on('ErqProducts', productsHandler(items));
    const page = await fetchProducts(gqlOf(admin), ctx, null, {});
    expect(page.nextCursor).toBeNull();
    const u = new Date('2026-03-01T10:00:00Z');
    const pu = new Date('2026-03-02T10:00:00Z');
    expect(page.items).toEqual([
      {
        externalId: 'gid://shopify/Product/1',
        title: 'Product 1',
        brand: 'Acme',
        category: 'Shirts',
        status: 'active',
        updatedAt: pu,
        variants: [
          {
            externalId: 'gid://shopify/ProductVariant/1',
            skuCode: 'SKU-1',
            barcode: null,
            priceCents: 1999,
            compareAtPriceCents: null,
            currency: 'USD',
            unitCostCents: 750,
            updatedAt: u,
          },
          {
            externalId: 'gid://shopify/ProductVariant/2',
            skuCode: null,
            barcode: '123',
            priceCents: 1999,
            compareAtPriceCents: 2900,
            currency: 'USD',
            unitCostCents: null,
            updatedAt: u,
          },
        ],
      },
      {
        externalId: 'gid://shopify/Product/2',
        title: 'Product 2',
        brand: null,
        category: null,
        status: 'draft',
        updatedAt: pu,
        variants: [
          {
            externalId: 'gid://shopify/ProductVariant/3',
            skuCode: 'SKU-3',
            barcode: null,
            priceCents: 500,
            compareAtPriceCents: null,
            currency: 'USD',
            unitCostCents: null,
            updatedAt: u,
          },
        ],
      },
      {
        externalId: 'gid://shopify/Product/3',
        title: 'Product 3',
        brand: 'Acme',
        category: 'Shirts',
        status: 'archived',
        updatedAt: pu,
        variants: [],
      },
    ]);
  });
  it('ignores a unit cost in another currency and handles zero-decimal shops', async () => {
    const items = [
      product(1, [
        variant(1, {
          price: '1500',
          inventoryItem: { unitCost: { amount: '700', currencyCode: 'JPY' } },
        }),
        variant(2, {
          price: '1500',
          inventoryItem: { unitCost: { amount: '7.00', currencyCode: 'USD' } },
        }),
      ]),
    ];
    const admin = new FakeShopifyAdmin().on('ErqProducts', productsHandler(items, 'JPY'));
    const page = await fetchProducts(gqlOf(admin), ctx, null, {});
    expect(page.items[0]!.variants.map((x) => [x.priceCents, x.unitCostCents, x.currency])).toEqual(
      [
        [1500, 700, 'JPY'],
        [1500, null, 'JPY'],
      ],
    );
  });
  it('pages 8 products at a time and decodes/encodes cursors', async () => {
    const items = Array.from({ length: 30 }, (_, i) => product(i + 1, [variant(i + 1)]));
    const admin = new FakeShopifyAdmin().on('ErqProducts', productsHandler(items));
    const first = await fetchProducts(gqlOf(admin), ctx, null, {});
    expect(first.items).toHaveLength(8);
    expect(first.nextCursor).not.toBeNull();
    expect(decodeCursor(first.nextCursor)).toBe('7');
    const second = await fetchProducts(gqlOf(admin), ctx, first.nextCursor, {});
    expect(second.items.map((p) => p.title)).toEqual(
      Array.from({ length: 8 }, (_, i) => `Product ${i + 9}`),
    );
    expect(second.nextCursor).not.toBeNull();
  });
  it('sends the updated_at filter only for incrementals', async () => {
    const admin = new FakeShopifyAdmin().on('ErqProducts', productsHandler([]));
    await fetchProducts(gqlOf(admin), ctx, null, {});
    await fetchProducts(gqlOf(admin), ctx, null, { since: new Date('2026-01-01T00:00:00Z') });
    await fetchProducts(gqlOf(admin), ctx, null, {
      updatedSince: new Date('2026-02-03T04:05:06.000Z'),
    });
    const queries = admin.requests.map((r) => JSON.parse(r.body!).variables.query);
    expect(queries).toEqual([null, null, "updated_at:>='2026-02-03T04:05:06.000Z'"]);
  });
  it('fetches the remaining variants of a product with more than 100 variants', async () => {
    const all = Array.from({ length: 250 }, (_, i) => variant(i + 1));
    const first = paginate(all, 50, null);
    const items = [product(1, first.nodes, {})];
    (items[0] as { variants: unknown }).variants = first;
    const admin = new FakeShopifyAdmin()
      .on('ErqProducts', productsHandler(items))
      .on('ErqProductVariants', (v) =>
        gqlOk({
          product: {
            variants: paginate(all, v.first as number, (v.after as string | null) ?? null),
          },
        }),
      );
    const page = await fetchProducts(gqlOf(admin), ctx, null, {});
    expect(page.items[0]!.variants).toHaveLength(250);
    expect(new Set(page.items[0]!.variants.map((x) => x.externalId)).size).toBe(250);
    // 250 variants: 50 inline, then 4 extra pages of 50.
    expect(admin.callsOf('ErqProductVariants')).toBe(4);
    expect(page.cost).toBe(40 * 5);
  });
  it('fails loudly instead of truncating when a product has an absurd number of variants', async () => {
    const all = Array.from({ length: 1200 }, (_, i) => variant(i + 1));
    const first = paginate(all, 50, null);
    const items = [{ ...product(1, []), variants: first }];
    const admin = new FakeShopifyAdmin()
      .on('ErqProducts', productsHandler(items))
      .on('ErqProductVariants', (v) =>
        gqlOk({
          product: {
            variants: paginate(all, v.first as number, (v.after as string | null) ?? null),
          },
        }),
      );
    const err = await fetchProducts(gqlOf(admin), ctx, null, {}).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.message).toBe('A product has too many variants to import.');
  });
  it('rejects an unreadable price', async () => {
    const admin = new FakeShopifyAdmin().on(
      'ErqProducts',
      productsHandler([product(1, [variant(1, { price: 'abc' })])]),
    );
    await expect(fetchProducts(gqlOf(admin), ctx, null, {})).rejects.toBeInstanceOf(PermanentError);
  });
  it('maps an unrecognised product status to draft, never active', async () => {
    const admin = new FakeShopifyAdmin().on(
      'ErqProducts',
      productsHandler([product(1, [variant(1)], { status: 'UNLISTED' })]),
    );
    const page = await fetchProducts(gqlOf(admin), ctx, null, {});
    expect(page.items[0]!.status).toBe('draft');
  });
  it('keeps the products query under the 1000 point cost cap with the real constants', async () => {
    expect(PRODUCTS_OP.document).toContain(`variants(first: ${VARIANTS_PAGE_SIZE})`);
    const admin = new FakeShopifyAdmin().on('ErqProducts', (v) => {
      const requested = productsQueryCost(v.first as number, VARIANTS_PAGE_SIZE);
      expect(requested).toBeLessThan(1000);
      return gqlOk(
        { shop: { currencyCode: 'USD' }, products: paginate([], v.first as number, null) },
        { requested },
      );
    });
    await fetchProducts(gqlOf(admin), ctx, null, {});
    expect(JSON.parse(admin.requests[0]!.body!).variables.first).toBe(PRODUCTS_PAGE_SIZE);
    expect(productsQueryCost(PRODUCTS_PAGE_SIZE, VARIANTS_PAGE_SIZE)).toBeLessThan(1000);
  });
  it('fails instead of looping when nested variants say hasNextPage without a cursor', async () => {
    const stuck = {
      ...product(1, [variant(1)]),
      variants: { nodes: [variant(1)], pageInfo: { hasNextPage: true, endCursor: null } },
    };
    const admin = new FakeShopifyAdmin().on('ErqProducts', productsHandler([stuck]));
    await expect(fetchProducts(gqlOf(admin), ctx, null, {})).rejects.toBeInstanceOf(PermanentError);
    expect(admin.callsOf('ErqProductVariants')).toBe(0);
  });
  it('fails when the product disappears while its variants are fetched', async () => {
    const first = { nodes: [variant(1)], pageInfo: { hasNextPage: true, endCursor: '0' } };
    const items = [{ ...product(1, []), variants: first }];
    const admin = new FakeShopifyAdmin()
      .on('ErqProducts', productsHandler(items))
      .on('ErqProductVariants', () => gqlOk({ product: null }));
    await expect(fetchProducts(gqlOf(admin), ctx, null, {})).rejects.toBeInstanceOf(PermanentError);
  });
  it('rejects a tampered cursor before calling Shopify', async () => {
    const admin = new FakeShopifyAdmin().on('ErqProducts', productsHandler([]));
    const err = await fetchProducts(gqlOf(admin), ctx, 'abc', {}).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.message).toBe('Invalid sync cursor.');
    expect(admin.requests).toHaveLength(0);
    expect(encodeCursor('x')).toBeTruthy();
  });
});
