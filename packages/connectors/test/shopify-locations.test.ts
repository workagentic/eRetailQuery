import { describe, expect, it } from 'vitest';
import {
  createShopifyGraphqlClient,
  decodeCursor,
  encodeCursor,
  fetchLocations,
  normalizeLocation,
} from '../src';
import { FakeShopifyAdmin, gqlOk, paginate } from '../src/testing';

const ctx = { externalAccountId: 'a.myshopify.com', credentials: { accessToken: 'shpat_x' } };
const nodes = [
  {
    id: 'gid://shopify/Location/1',
    name: 'Main warehouse',
    isActive: true,
    isFulfillmentService: false,
    address: { formatted: ['1 Main St', 'Austin TX 78701', 'United States'] },
  },
  {
    id: 'gid://shopify/Location/2',
    name: 'ShipBob',
    isActive: true,
    isFulfillmentService: true,
    address: null,
  },
  {
    id: 'gid://shopify/Location/3',
    name: 'Old shop',
    isActive: false,
    isFulfillmentService: false,
    address: { formatted: [] },
  },
];
const adminFor = () =>
  new FakeShopifyAdmin().on('ErqLocations', (v) =>
    gqlOk({
      locations: paginate(nodes, v.first as number, (v.after as string | null) ?? null),
    }),
  );

describe('locations', () => {
  it('normalizes and maps types, addresses and activity', () => {
    expect(nodes.map(normalizeLocation)).toEqual([
      {
        externalId: 'gid://shopify/Location/1',
        name: 'Main warehouse',
        type: 'warehouse',
        address: '1 Main St, Austin TX 78701, United States',
        isActive: true,
      },
      {
        externalId: 'gid://shopify/Location/2',
        name: 'ShipBob',
        type: '3pl',
        address: null,
        isActive: true,
      },
      {
        externalId: 'gid://shopify/Location/3',
        name: 'Old shop',
        type: 'warehouse',
        address: null,
        isActive: false,
      },
    ]);
  });
  it('fetches one page of 100 and ends with a null cursor', async () => {
    const admin = adminFor();
    const gql = createShopifyGraphqlClient({ http: admin });
    const first = await fetchLocations(gql, ctx, null);
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).toBeNull();
    expect(first.cost).toBe(40);
    const vars = JSON.parse(admin.requests[0]!.body!).variables;
    expect(vars).toEqual({ first: 100, after: null });
  });
  it('rejects a tampered cursor before calling Shopify', async () => {
    const admin = adminFor();
    const err = await fetchLocations(createShopifyGraphqlClient({ http: admin }), ctx, 'abc').catch(
      (e) => e,
    );
    expect(err.message).toBe('Invalid sync cursor.');
    expect(admin.requests).toHaveLength(0);
  });
  it('sends the decoded cursor back to Shopify when continuing', async () => {
    const admin = new FakeShopifyAdmin().on('ErqLocations', () =>
      gqlOk({ locations: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'NEXT' } } }),
    );
    const gql = createShopifyGraphqlClient({ http: admin });
    const page = await fetchLocations(gql, ctx, encodeCursor('PREV'));
    expect(JSON.parse(admin.requests[0]!.body!).variables.after).toBe('PREV');
    expect(decodeCursor(page.nextCursor)).toBe('NEXT');
  });
});
