// packages/connectors/src/shopify/inventory.ts
// https://shopify.dev/docs/api/admin-graphql/latest/queries/inventoryItems  (query filter: updated_at)
// https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryLevel  (quantities(names: [...]))
// https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryQuantity
import { z } from 'zod';
import { PermanentError } from '../errors';
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

const LEVEL_FIELDS =
  'updatedAt location { id } quantities(names: ["on_hand", "committed", "reserved", "incoming"]) { name quantity }';

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

export function normalizeInventoryLevel(
  variantId: string,
  level: ShopifyInventoryLevelNode,
): NormalizedInventoryLevel {
  const q = (name: string): number => level.quantities.find((x) => x.name === name)?.quantity ?? 0;
  const updatedAt = new Date(level.updatedAt);
  if (Number.isNaN(updatedAt.getTime())) throw new PermanentError(UNEXPECTED);
  return {
    externalVariantId: variantId,
    locationExternalId: level.location.id,
    onHand: q('on_hand'),
    // "committed" (ordered, unfulfilled) and "reserved" (held, e.g. draft orders) both reduce what
    // can be sold; the sum is clamped at 0 so a bad negative never shrinks stock below zero.
    reserved: Math.max(0, q('committed') + q('reserved')),
    incoming: Math.max(0, q('incoming')),
    updatedAt,
  };
}

export async function fetchInventory(
  gql: ShopifyGraphqlClient,
  ctx: GraphqlContext,
  cursor: string | null,
  options: FetchOptions,
): Promise<Page<NormalizedInventoryLevel>> {
  const after = decodeCursor(cursor);
  const { data, cost: firstCost } = await gql.query(ctx, INVENTORY_OP, {
    first: INVENTORY_ITEMS_PAGE_SIZE,
    after,
    query: options.updatedSince ? `updated_at:>='${options.updatedSince.toISOString()}'` : null,
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
      if (res.data.inventoryItem === null) throw new PermanentError(UNEXPECTED);
      levels.push(...res.data.inventoryItem.inventoryLevels.nodes);
      info = res.data.inventoryItem.inventoryLevels.pageInfo;
      extra += 1;
    }
    if (info.hasNextPage) {
      throw new PermanentError('An inventory item has too many locations to import.');
    }
    for (const level of levels) {
      const key = `${variantId}\u0000${level.location.id}`;
      if (seen.has(key)) throw new PermanentError(UNEXPECTED);
      seen.add(key);
      items.push(normalizeInventoryLevel(variantId, level));
    }
  }
  return { items, nextCursor: nextCursorOf(data.inventoryItems.pageInfo), cost };
}
