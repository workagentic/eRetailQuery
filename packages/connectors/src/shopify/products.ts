// packages/connectors/src/shopify/products.ts
// https://shopify.dev/docs/api/admin-graphql/latest/queries/products  (query filter: updated_at)
// https://shopify.dev/docs/api/admin-graphql/latest/objects/Product  (vendor, productType, status)
// https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant  (price, compareAtPrice, inventoryItem)
// https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryItem  (unitCost: MoneyV2)
// https://shopify.dev/docs/api/admin-graphql/latest/objects/Shop  (currencyCode)
import { z } from 'zod';
import { PermanentError } from '../errors';
import type { NormalizedProduct, NormalizedVariant, ProductStatus } from '../normalized';
import type { FetchOptions, Page } from '../types';
import {
  decodeCursor,
  MAX_EXTRA_PAGES,
  nextCursorOf,
  pageInfoSchema,
  PRODUCTS_PAGE_SIZE,
  VARIANTS_PAGE_SIZE,
} from './cursor';
import type { GraphqlContext, GraphqlOperation, ShopifyGraphqlClient } from './graphql';
import { parseMoneyToMinorUnits } from './money';

const VARIANT_FIELDS =
  'id sku barcode price compareAtPrice updatedAt inventoryItem { unitCost { amount currencyCode } }';

const PRODUCTS_DOCUMENT = `query ErqProducts($first: Int!, $after: String, $query: String) {
  shop { currencyCode }
  products(first: $first, after: $after, query: $query) {
    nodes {
      id title vendor productType status updatedAt
      variants(first: ${VARIANTS_PAGE_SIZE}) {
        nodes { ${VARIANT_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;
const VARIANTS_DOCUMENT = `query ErqProductVariants($id: ID!, $first: Int!, $after: String) {
  product(id: $id) {
    variants(first: $first, after: $after) {
      nodes { ${VARIANT_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const variantNode = z.object({
  id: z.string(),
  sku: z.string().nullable(),
  barcode: z.string().nullable(),
  price: z.string(),
  compareAtPrice: z.string().nullable(),
  updatedAt: z.string(),
  inventoryItem: z
    .object({
      unitCost: z.object({ amount: z.string(), currencyCode: z.string() }).nullable(),
    })
    .nullable(),
});
export type ShopifyVariantNode = z.infer<typeof variantNode>;
const variantConnection = z.object({ nodes: z.array(variantNode), pageInfo: pageInfoSchema });
const productNode = z.object({
  id: z.string(),
  title: z.string(),
  vendor: z.string(),
  productType: z.string(),
  status: z.string(),
  updatedAt: z.string(),
  variants: variantConnection,
});
export type ShopifyProductNode = z.infer<typeof productNode>;

const productsResponse = z.object({
  shop: z.object({ currencyCode: z.string() }),
  products: z.object({ nodes: z.array(productNode), pageInfo: pageInfoSchema }),
});
const variantsResponse = z.object({
  product: z.object({ variants: variantConnection }).nullable(),
});

export const PRODUCTS_OP = {
  name: 'ErqProducts',
  document: PRODUCTS_DOCUMENT,
  schema: productsResponse,
} satisfies GraphqlOperation<z.infer<typeof productsResponse>>;
export const PRODUCT_VARIANTS_OP = {
  name: 'ErqProductVariants',
  document: VARIANTS_DOCUMENT,
  schema: variantsResponse,
} satisfies GraphqlOperation<z.infer<typeof variantsResponse>>;

// Statuses added in newer API versions (e.g. UNLISTED) fall back to 'draft', never 'active'.
const STATUS: Record<string, ProductStatus> = {
  ACTIVE: 'active',
  DRAFT: 'draft',
  ARCHIVED: 'archived',
};

const UNEXPECTED = 'Shopify returned an unexpected response.';
const orNull = (s: string | null): string | null => {
  const t = s === null ? '' : s.trim();
  return t === '' ? null : t;
};
function parseDate(s: string): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new PermanentError(UNEXPECTED);
  return d;
}

export function normalizeVariant(
  node: ShopifyVariantNode,
  shopCurrency: string,
): NormalizedVariant {
  const cost = node.inventoryItem?.unitCost ?? null;
  return {
    externalId: node.id,
    skuCode: orNull(node.sku),
    barcode: orNull(node.barcode),
    priceCents: parseMoneyToMinorUnits(node.price, shopCurrency),
    compareAtPriceCents:
      node.compareAtPrice === null
        ? null
        : parseMoneyToMinorUnits(node.compareAtPrice, shopCurrency),
    currency: shopCurrency,
    // One currency per org: a cost in any other currency is ignored, never converted.
    unitCostCents:
      cost !== null && cost.currencyCode === shopCurrency
        ? parseMoneyToMinorUnits(cost.amount, shopCurrency)
        : null,
    updatedAt: parseDate(node.updatedAt),
  };
}

export function normalizeProduct(
  node: Pick<
    ShopifyProductNode,
    'id' | 'title' | 'vendor' | 'productType' | 'status' | 'updatedAt'
  >,
  variantNodes: ShopifyVariantNode[],
  shopCurrency: string,
): NormalizedProduct {
  const status = STATUS[node.status] ?? 'draft';
  return {
    externalId: node.id,
    title: node.title,
    brand: orNull(node.vendor),
    category: orNull(node.productType),
    status,
    updatedAt: parseDate(node.updatedAt),
    variants: variantNodes.map((v) => normalizeVariant(v, shopCurrency)),
  };
}

export async function fetchProducts(
  gql: ShopifyGraphqlClient,
  ctx: GraphqlContext,
  cursor: string | null,
  options: FetchOptions,
): Promise<Page<NormalizedProduct>> {
  const after = decodeCursor(cursor);
  const { data, cost: firstCost } = await gql.query(ctx, PRODUCTS_OP, {
    first: PRODUCTS_PAGE_SIZE,
    after,
    // Backfill imports every product; only incrementals filter. Note: editing only an inventory
    // item's cost does not bump the product's updated_at, so such changes are missed here and need
    // a backfill or periodic full sync (to be handled in 1b-3c).
    query: options.updatedSince ? `updated_at:>='${options.updatedSince.toISOString()}'` : null,
  });
  let cost = firstCost;
  const currency = data.shop.currencyCode;
  const items: NormalizedProduct[] = [];
  for (const node of data.products.nodes) {
    const variantNodes = [...node.variants.nodes];
    let info = node.variants.pageInfo;
    let extra = 0;
    while (info.hasNextPage && extra < MAX_EXTRA_PAGES) {
      if (!info.endCursor) throw new PermanentError(UNEXPECTED);
      const res = await gql.query(ctx, PRODUCT_VARIANTS_OP, {
        id: node.id,
        first: VARIANTS_PAGE_SIZE,
        after: info.endCursor,
      });
      cost += res.cost;
      if (res.data.product === null) throw new PermanentError(UNEXPECTED);
      variantNodes.push(...res.data.product.variants.nodes);
      info = res.data.product.variants.pageInfo;
      extra += 1;
    }
    if (info.hasNextPage) throw new PermanentError('A product has too many variants to import.');
    items.push(normalizeProduct(node, variantNodes, currency));
  }
  return { items, nextCursor: nextCursorOf(data.products.pageInfo), cost };
}
