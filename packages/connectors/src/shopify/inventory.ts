// packages/connectors/src/shopify/inventory.ts
// https://shopify.dev/docs/api/admin-graphql/latest/queries/inventoryItems
// https://shopify.dev/docs/apps/build/orders-fulfillment/inventory-management-apps  (quantity states)
// https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryLevel  (quantities(names: [...]))
// https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryQuantity
import { z } from 'zod';
import { PermanentError, TransientError } from '../errors';
import type { NormalizedInventoryLevel } from '../normalized';
import type { FetchOptions, Page } from '../types';
import {
  decodeCursor,
  INVENTORY_ITEMS_PAGE_SIZE,
  INVENTORY_LEVELS_EXTRA_PAGE_SIZE,
  INVENTORY_LEVELS_INLINE,
  MAX_EXTRA_PAGES,
  nextCursorOf,
  pageInfoSchema,
} from './cursor';
import type { GraphqlContext, GraphqlOperation, ShopifyGraphqlClient } from './graphql';

/**
 * The quantity names requested per level. `available` is what Shopify lets the shop sell: on hand
 * minus committed, reserved, damaged, safety_stock and quality_control. Each name costs about one
 * point per level, so adding one changes the cost budget in cursor.ts (a test pins the list).
 */
export const INVENTORY_QUANTITY_NAMES = ['on_hand', 'available', 'incoming'] as const;
const LEVEL_FIELDS = `updatedAt location { id } quantities(names: [${INVENTORY_QUANTITY_NAMES.map((n) => `"${n}"`).join(', ')}]) { name quantity }`;

const INVENTORY_DOCUMENT = `query ErqInventory($first: Int!, $after: String, $query: String) {
  inventoryItems(first: $first, after: $after, query: $query) {
    nodes {
      id
      variant { id }
      inventoryLevels(first: ${INVENTORY_LEVELS_INLINE}) {
        nodes { ${LEVEL_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;
const LEVELS_DOCUMENT = `query ErqInventoryLevels($id: ID!, $first: Int!, $after: String) {
  inventoryItem(id: $id) {
    inventoryLevels(first: $first, after: $after) {
      nodes { ${LEVEL_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const levelNode = z.object({
  updatedAt: z.string(),
  location: z.object({ id: z.string() }),
  quantities: z.array(z.object({ name: z.string(), quantity: z.number().int() })),
});
export type ShopifyInventoryLevelNode = z.infer<typeof levelNode>;
const levelConnection = z.object({ nodes: z.array(levelNode), pageInfo: pageInfoSchema });
const itemNode = z.object({
  id: z.string(),
  variant: z.object({ id: z.string() }).nullable(),
  inventoryLevels: levelConnection,
});
const inventoryResponse = z.object({
  inventoryItems: z.object({ nodes: z.array(itemNode), pageInfo: pageInfoSchema }),
});
const levelsResponse = z.object({
  inventoryItem: z.object({ inventoryLevels: levelConnection }).nullable(),
});

export const INVENTORY_OP = {
  name: 'ErqInventory',
  document: INVENTORY_DOCUMENT,
  schema: inventoryResponse,
} satisfies GraphqlOperation<z.infer<typeof inventoryResponse>>;
export const INVENTORY_LEVELS_OP = {
  name: 'ErqInventoryLevels',
  document: LEVELS_DOCUMENT,
  schema: levelsResponse,
} satisfies GraphqlOperation<z.infer<typeof levelsResponse>>;

const UNEXPECTED = 'Shopify returned an unexpected response.';
const RACE = 'Shopify data changed while it was being read. Retrying.';

export function normalizeInventoryLevel(
  variantId: string,
  level: ShopifyInventoryLevelNode,
): NormalizedInventoryLevel {
  const find = (name: string): number | undefined =>
    level.quantities.find((x) => x.name === name)?.quantity;
  const updatedAt = new Date(level.updatedAt);
  if (Number.isNaN(updatedAt.getTime())) throw new PermanentError(UNEXPECTED);
  const onHand = find('on_hand') ?? 0;
  const available = find('available');
  return {
    externalVariantId: variantId,
    locationExternalId: level.location.id,
    onHand,
    // Everything on hand that cannot be sold (committed, reserved, damaged, safety stock, quality
    // control) counts as reserved, so on_hand - reserved = Shopify's available. Clamped at 0 so bad
    // data never inflates stock; a missing `available` treats nothing as held.
    reserved: available === undefined ? 0 : Math.max(0, onHand - available),
    incoming: Math.max(0, find('incoming') ?? 0),
    updatedAt,
  };
}

export async function fetchInventory(
  gql: ShopifyGraphqlClient,
  ctx: GraphqlContext,
  cursor: string | null,
  // Accepted for the common signature only: see the full-pass note below.
  _options: FetchOptions,
): Promise<Page<NormalizedInventoryLevel>> {
  const after = decodeCursor(cursor);
  // Always a full pass, also for incrementals: the inventory item's updated_at does not move when
  // only a quantity changes, so an updated_at filter would miss stock changes. Inventory has no
  // history window and the sink is idempotent, so a full pass is safe. 1b-3c revisits this
  // (webhooks or a better change signal).
  const { data, cost: firstCost } = await gql.query(ctx, INVENTORY_OP, {
    first: INVENTORY_ITEMS_PAGE_SIZE,
    after,
    query: null,
  });
  let cost = firstCost;
  const items: NormalizedInventoryLevel[] = [];
  const seen = new Set<string>();
  for (const node of data.inventoryItems.nodes) {
    if (node.variant === null) continue;
    const variantId = node.variant.id;
    const levels = [...node.inventoryLevels.nodes];
    let info = node.inventoryLevels.pageInfo;
    let extra = 0;
    while (info.hasNextPage && extra < MAX_EXTRA_PAGES) {
      if (!info.endCursor) throw new PermanentError(UNEXPECTED);
      const res = await gql.query(ctx, INVENTORY_LEVELS_OP, {
        id: node.id,
        first: INVENTORY_LEVELS_EXTRA_PAGE_SIZE,
        after: info.endCursor,
      });
      cost += res.cost;
      // The item can vanish between the two queries; retry the page instead of failing for good.
      if (res.data.inventoryItem === null) throw new TransientError(RACE);
      levels.push(...res.data.inventoryItem.inventoryLevels.nodes);
      info = res.data.inventoryItem.inventoryLevels.pageInfo;
      extra += 1;
    }
    if (info.hasNextPage) {
      throw new PermanentError('An inventory item has too many locations to import.');
    }
    for (const level of levels) {
      const key = `${variantId}\u0000${level.location.id}`;
      // Locations added or removed between pages shift the cursor and can repeat a level: retry.
      if (seen.has(key)) throw new TransientError(RACE);
      seen.add(key);
      items.push(normalizeInventoryLevel(variantId, level));
    }
  }
  return { items, nextCursor: nextCursorOf(data.inventoryItems.pageInfo), cost };
}
