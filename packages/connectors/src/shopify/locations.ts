// packages/connectors/src/shopify/locations.ts
// https://shopify.dev/docs/api/admin-graphql/latest/queries/locations  (includeInactive argument)
// https://shopify.dev/docs/api/admin-graphql/latest/objects/Location  (isActive, isFulfillmentService, address.formatted)
import { z } from 'zod';
import type { NormalizedLocation } from '../normalized';
import type { Page } from '../types';
import { decodeCursor, LOCATIONS_PAGE_SIZE, nextCursorOf, pageInfoSchema } from './cursor';
import type { GraphqlContext, GraphqlOperation, ShopifyGraphqlClient } from './graphql';

const LOCATIONS_DOCUMENT = `query ErqLocations($first: Int!, $after: String) {
  locations(first: $first, after: $after, includeInactive: true) {
    nodes { id name isActive isFulfillmentService address { formatted } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const locationNode = z.object({
  id: z.string(),
  name: z.string(),
  isActive: z.boolean(),
  isFulfillmentService: z.boolean(),
  address: z.object({ formatted: z.array(z.string()) }).nullable(),
});
export type ShopifyLocationNode = z.infer<typeof locationNode>;
const locationsResponse = z.object({
  locations: z.object({ nodes: z.array(locationNode), pageInfo: pageInfoSchema }),
});

export const LOCATIONS_OP = {
  name: 'ErqLocations',
  document: LOCATIONS_DOCUMENT,
  schema: locationsResponse,
} satisfies GraphqlOperation<z.infer<typeof locationsResponse>>;

export function normalizeLocation(node: ShopifyLocationNode): NormalizedLocation {
  const address = node.address?.formatted.join(', ') ?? '';
  return {
    externalId: node.id,
    name: node.name,
    type: node.isFulfillmentService ? '3pl' : 'warehouse',
    address: address === '' ? null : address,
    isActive: node.isActive,
  };
}

export async function fetchLocations(
  gql: ShopifyGraphqlClient,
  ctx: GraphqlContext,
  cursor: string | null,
): Promise<Page<NormalizedLocation>> {
  const after = decodeCursor(cursor);
  const { data, cost } = await gql.query(ctx, LOCATIONS_OP, {
    first: LOCATIONS_PAGE_SIZE,
    after,
  });
  return {
    items: data.locations.nodes.map(normalizeLocation),
    nextCursor: nextCursorOf(data.locations.pageInfo),
    cost,
  };
}
