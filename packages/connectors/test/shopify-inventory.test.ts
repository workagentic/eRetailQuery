import { describe, expect, it } from 'vitest';
import {
  createShopifyGraphqlClient,
  decodeCursor,
  fetchInventory,
  INVENTORY_ITEMS_PAGE_SIZE,
  INVENTORY_LEVELS_EXTRA_PAGE_SIZE,
  INVENTORY_LEVELS_INLINE,
  INVENTORY_LEVELS_OP,
  INVENTORY_OP,
  INVENTORY_QUANTITY_NAMES,
  normalizeInventoryLevel,
  PermanentError,
  TransientError,
} from '../src';
import {
  FakeShopifyAdmin,
  gqlOk,
  inventoryLevelsQueryCost,
  inventoryQueryCost,
  paginate,
} from '../src/testing';

const RACE = 'Shopify data changed while it was being read. Retrying.';

const ctx = { externalAccountId: 'a.myshopify.com', credentials: { accessToken: 'shpat_x' } };
const level = (
  loc: number,
  qty: Record<string, unknown> = {},
  updatedAt = '2026-03-01T10:00:00Z',
) => ({
  updatedAt,
  location: { id: `gid://shopify/Location/${loc}` },
  quantities: Object.entries({ on_hand: 5, ...qty }).map(([name, quantity]) => ({
    name,
    quantity,
  })),
});
const item = (
  n: number,
  levels: unknown[],
  variantId: string | null = `gid://shopify/ProductVariant/${n}`,
) => {
  const more = levels.length > INVENTORY_LEVELS_INLINE;
  return {
    id: `gid://shopify/InventoryItem/${n}`,
    variant: variantId === null ? null : { id: variantId },
    inventoryLevels: {
      nodes: levels.slice(0, INVENTORY_LEVELS_INLINE),
      pageInfo: { hasNextPage: more, endCursor: more ? String(INVENTORY_LEVELS_INLINE - 1) : null },
    },
  };
};
const handler = (items: unknown[]) => (v: Record<string, unknown>) =>
  gqlOk(
    { inventoryItems: paginate(items, v.first as number, (v.after as string | null) ?? null) },
    { requested: inventoryQueryCost(v.first as number, INVENTORY_LEVELS_INLINE) },
  );
const levelsHandler = (all: unknown[]) => (v: Record<string, unknown>) =>
  gqlOk({
    inventoryItem: {
      inventoryLevels: paginate(all, v.first as number, (v.after as string | null) ?? null),
    },
  });
const gqlOf = (admin: FakeShopifyAdmin) => createShopifyGraphqlClient({ http: admin });

describe('inventory', () => {
  it('maps quantities: reserved = on_hand - available, clamped at 0; missing names are 0', async () => {
    const items = [
      item(1, [
        // 3 units are committed, reserved, damaged, safety stock or in quality control.
        level(1, { on_hand: 10, available: 7, incoming: 4 }),
        // available above on_hand (bad data) never makes reserved negative.
        level(2, { on_hand: -2, available: 5, incoming: -3 }),
        // No available reported: nothing is treated as held.
        level(3, { on_hand: 7 }),
      ]),
    ];
    const admin = new FakeShopifyAdmin().on('ErqInventory', handler(items));
    const page = await fetchInventory(gqlOf(admin), ctx, null, {});
    const updatedAt = new Date('2026-03-01T10:00:00Z');
    const externalVariantId = 'gid://shopify/ProductVariant/1';
    const row = (loc: number, onHand: number, reserved: number, incoming: number) => ({
      externalVariantId,
      locationExternalId: `gid://shopify/Location/${loc}`,
      onHand,
      reserved,
      incoming,
      updatedAt,
    });
    expect(page.items).toEqual([row(1, 10, 3, 4), row(2, -2, 0, 0), row(3, 7, 0, 0)]);
    expect(page.nextCursor).toBeNull();
  });
  it('ignores quantity names it does not know', () => {
    const n = normalizeInventoryLevel('v', level(1, { committed: 99, damaged: 3 }));
    expect(n.onHand).toBe(5);
    expect(n.reserved).toBe(0);
  });
  it('skips items without a variant', async () => {
    const items = [item(1, [level(1)], null), item(2, [level(1)])];
    const admin = new FakeShopifyAdmin().on('ErqInventory', handler(items));
    const page = await fetchInventory(gqlOf(admin), ctx, null, {});
    expect(page.items.map((x) => x.externalVariantId)).toEqual(['gid://shopify/ProductVariant/2']);
  });
  it('pages by the items page size and round-trips the cursor', async () => {
    const total = INVENTORY_ITEMS_PAGE_SIZE + 5;
    const items = Array.from({ length: total }, (_, i) => item(i + 1, [level(1)]));
    const admin = new FakeShopifyAdmin().on('ErqInventory', handler(items));
    const first = await fetchInventory(gqlOf(admin), ctx, null, {});
    expect(first.items).toHaveLength(INVENTORY_ITEMS_PAGE_SIZE);
    expect(decodeCursor(first.nextCursor)).toBe(String(INVENTORY_ITEMS_PAGE_SIZE - 1));
    const second = await fetchInventory(gqlOf(admin), ctx, first.nextCursor, {});
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
  });
  it('always reads every item: the updated_at filter misses quantity-only changes', async () => {
    const admin = new FakeShopifyAdmin().on('ErqInventory', handler([]));
    await fetchInventory(gqlOf(admin), ctx, null, {});
    await fetchInventory(gqlOf(admin), ctx, null, { since: new Date('2026-01-01T00:00:00Z') });
    await fetchInventory(gqlOf(admin), ctx, null, {
      updatedSince: new Date('2026-02-03T04:05:06.000Z'),
    });
    const queries = admin.requests.map((r) => JSON.parse(r.body!).variables.query);
    expect(queries).toEqual([null, null, null]);
  });
  it('fetches the remaining levels of an item with many locations', async () => {
    const all = Array.from({ length: 120 }, (_, i) => level(i + 1));
    const admin = new FakeShopifyAdmin()
      .on('ErqInventory', handler([item(1, all)]))
      .on('ErqInventoryLevels', levelsHandler(all));
    const page = await fetchInventory(gqlOf(admin), ctx, null, {});
    expect(page.items).toHaveLength(120);
    const pairs = page.items.map((x) => `${x.externalVariantId}|${x.locationExternalId}`);
    expect(new Set(pairs).size).toBe(120);
    // 10 inline, then 50 + 50 + 10.
    expect(admin.callsOf('ErqInventoryLevels')).toBe(3);
  });
  it('fails with the fixed message when an item has absurdly many locations', async () => {
    const all = Array.from({ length: 1500 }, (_, i) => level(i + 1));
    const admin = new FakeShopifyAdmin()
      .on('ErqInventory', handler([item(1, all)]))
      .on('ErqInventoryLevels', levelsHandler(all));
    const err = await fetchInventory(gqlOf(admin), ctx, null, {}).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.message).toBe('An inventory item has too many locations to import.');
  });
  it('retries the page (transient) on a repeated (variant, location) pair', async () => {
    const admin = new FakeShopifyAdmin().on(
      'ErqInventory',
      handler([item(1, [level(1), level(1)])]),
    );
    const err = await fetchInventory(gqlOf(admin), ctx, null, {}).catch((e) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect(err.message).toBe(RACE);
  });
  it('retries the page (transient) when a level repeats across follow-up pages', async () => {
    const all = Array.from({ length: 12 }, (_, i) => level(i + 1));
    // The follow-up starts over at the first level, as if a location was added between queries.
    const admin = new FakeShopifyAdmin()
      .on('ErqInventory', handler([item(1, all)]))
      .on('ErqInventoryLevels', (v) =>
        gqlOk({ inventoryItem: { inventoryLevels: paginate(all, v.first as number, null) } }),
      );
    const err = await fetchInventory(gqlOf(admin), ctx, null, {}).catch((e) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect(err.message).toBe(RACE);
  });
  it('fails on an unreadable quantity', async () => {
    const admin = new FakeShopifyAdmin().on(
      'ErqInventory',
      handler([item(1, [level(1, { on_hand: 'x' })])]),
    );
    await expect(fetchInventory(gqlOf(admin), ctx, null, {})).rejects.toBeInstanceOf(
      PermanentError,
    );
  });
  it('fails on an unreadable updatedAt', async () => {
    const admin = new FakeShopifyAdmin().on(
      'ErqInventory',
      handler([item(1, [level(1, {}, 'not-a-date')])]),
    );
    await expect(fetchInventory(gqlOf(admin), ctx, null, {})).rejects.toBeInstanceOf(
      PermanentError,
    );
  });
  it('requests exactly three quantity names, which the cost budget below is priced for', () => {
    const names = [...INVENTORY_OP.document.matchAll(/quantities\(names: \[([^\]]*)\]\)/g)].map(
      (m) => [...m[1]!.matchAll(/"([^"]+)"/g)].map((n) => n[1]),
    );
    expect(names).toEqual([['on_hand', 'available', 'incoming']]);
    expect(INVENTORY_LEVELS_OP.document).toContain(
      'quantities(names: ["on_hand", "available", "incoming"])',
    );
    expect([...INVENTORY_QUANTITY_NAMES]).toEqual(names[0]);
    // Pinned: one more name raises each level to 6 points and this fails, forcing a budget review.
    expect(inventoryQueryCost(INVENTORY_ITEMS_PAGE_SIZE, INVENTORY_LEVELS_INLINE)).toBe(520);
    expect(inventoryLevelsQueryCost(INVENTORY_LEVELS_EXTRA_PAGE_SIZE)).toBe(253);
  });
  it('keeps the inventory query under the 1000 point cost cap with the real constants', async () => {
    expect(INVENTORY_OP.document).toContain(`inventoryLevels(first: ${INVENTORY_LEVELS_INLINE})`);
    const admin = new FakeShopifyAdmin().on('ErqInventory', (v) => {
      const requested = inventoryQueryCost(v.first as number, INVENTORY_LEVELS_INLINE);
      expect(requested).toBeLessThan(1000);
      return gqlOk({ inventoryItems: paginate([], v.first as number, null) }, { requested });
    });
    await fetchInventory(gqlOf(admin), ctx, null, {});
    expect(JSON.parse(admin.requests[0]!.body!).variables.first).toBe(INVENTORY_ITEMS_PAGE_SIZE);
    // The one-item follow-up query asks for 50 levels.
    expect(inventoryLevelsQueryCost(INVENTORY_LEVELS_EXTRA_PAGE_SIZE)).toBeLessThan(1000);
  });
  it('fails instead of looping when nested levels say hasNextPage without a cursor', async () => {
    const stuck = {
      ...item(1, [level(1)]),
      inventoryLevels: { nodes: [level(1)], pageInfo: { hasNextPage: true, endCursor: null } },
    };
    const admin = new FakeShopifyAdmin().on('ErqInventory', handler([stuck]));
    await expect(fetchInventory(gqlOf(admin), ctx, null, {})).rejects.toBeInstanceOf(
      PermanentError,
    );
    expect(admin.callsOf('ErqInventoryLevels')).toBe(0);
  });
  it('fails instead of looping when the items page says hasNextPage without a cursor', async () => {
    const admin = new FakeShopifyAdmin().on('ErqInventory', () =>
      gqlOk({ inventoryItems: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } }),
    );
    await expect(fetchInventory(gqlOf(admin), ctx, null, {})).rejects.toBeInstanceOf(
      PermanentError,
    );
  });
  it('retries the page (transient) when the item disappears while its levels are fetched', async () => {
    const all = Array.from({ length: 12 }, (_, i) => level(i + 1));
    const admin = new FakeShopifyAdmin()
      .on('ErqInventory', handler([item(1, all)]))
      .on('ErqInventoryLevels', () => gqlOk({ inventoryItem: null }));
    const err = await fetchInventory(gqlOf(admin), ctx, null, {}).catch((e) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect(err.message).toBe(RACE);
  });
  it('rejects a tampered cursor before calling Shopify', async () => {
    const admin = new FakeShopifyAdmin().on('ErqInventory', handler([]));
    const err = await fetchInventory(gqlOf(admin), ctx, 'abc', {}).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.message).toBe('Invalid sync cursor.');
    expect(admin.requests).toHaveLength(0);
  });
});
