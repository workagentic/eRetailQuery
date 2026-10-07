// packages/connectors/src/shopify/orders.ts
// https://shopify.dev/docs/api/admin-graphql/latest/queries/orders  (query filters: created_at, updated_at)
// https://shopify.dev/docs/api/admin-graphql/latest/objects/Order
// https://shopify.dev/docs/api/admin-graphql/latest/objects/Refund
// UNVERIFIED against real Shopify (first-install checklist): the field names below (sourceName,
// totalShippingPriceSet, refundShippingLines.subtotalAmountSet, refundLineItems.restockType,
// Order.refunds(first:)) and the API version they exist in were written from the docs, not run.
// Protected customer data is not requested: customer, UTM and landing_site stay null.
import { z } from 'zod';
import { PermanentError } from '../errors';
import type { NormalizedOrder, NormalizedOrderLine, NormalizedRefund } from '../normalized';
import type { FetchOptions, Page } from '../types';
import {
  decodeCursor,
  MAX_EXTRA_PAGES,
  nextCursorOf,
  ORDER_LINES_EXTRA_PAGE_SIZE,
  ORDER_LINES_INLINE,
  ORDER_REFUNDS_INLINE,
  ORDERS_PAGE_SIZE,
  pageInfoSchema,
  REFUND_LINES_INLINE,
  REFUND_SHIPPING_INLINE,
} from './cursor';
import type { GraphqlContext, GraphqlOperation, ShopifyGraphqlClient } from './graphql';
import { parseMoneyToMinorUnits } from './money';

const MONEY = '{ shopMoney { amount currencyCode } }';
const LINE_FIELDS = `id title quantity variant { id } originalUnitPriceSet ${MONEY} totalDiscountSet ${MONEY}`;

// Refunds are requested one beyond the supported count so that an overflow is detected, not truncated.
const ORDERS_DOCUMENT = `query ErqOrders($first: Int!, $after: String, $query: String, $sortKey: OrderSortKeys!) {
  orders(first: $first, after: $after, query: $query, sortKey: $sortKey) {
    nodes {
      id createdAt updatedAt cancelledAt closedAt test sourceName
      totalDiscountsSet ${MONEY}
      totalTaxSet ${MONEY}
      totalShippingPriceSet ${MONEY}
      lineItems(first: ${ORDER_LINES_INLINE}) {
        nodes { ${LINE_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
      refunds(first: ${ORDER_REFUNDS_INLINE + 1}) {
        id createdAt totalRefundedSet ${MONEY}
        refundLineItems(first: ${REFUND_LINES_INLINE}) {
          nodes { quantity restockType lineItem { id } subtotalSet ${MONEY} }
          pageInfo { hasNextPage endCursor }
        }
        refundShippingLines(first: ${REFUND_SHIPPING_INLINE}) {
          nodes { subtotalAmountSet ${MONEY} }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;
const LINES_DOCUMENT = `query ErqOrderLines($id: ID!, $first: Int!, $after: String) {
  order(id: $id) {
    lineItems(first: $first, after: $after) {
      nodes { ${LINE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const moneySet = z.object({
  shopMoney: z.object({ amount: z.string(), currencyCode: z.string() }),
});
const lineNode = z.object({
  id: z.string(),
  title: z.string(),
  quantity: z.number(),
  variant: z.object({ id: z.string() }).nullable(),
  originalUnitPriceSet: moneySet,
  totalDiscountSet: moneySet,
});
export type ShopifyOrderLineNode = z.infer<typeof lineNode>;
const refundNode = z.object({
  id: z.string(),
  createdAt: z.string(),
  totalRefundedSet: moneySet,
  refundLineItems: z.object({
    nodes: z.array(
      z.object({
        quantity: z.number(),
        restockType: z.string().nullable(),
        lineItem: z.object({ id: z.string() }),
        subtotalSet: moneySet,
      }),
    ),
    pageInfo: pageInfoSchema,
  }),
  refundShippingLines: z.object({
    nodes: z.array(z.object({ subtotalAmountSet: moneySet })),
    pageInfo: pageInfoSchema,
  }),
});
const orderNode = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  cancelledAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  test: z.boolean(),
  sourceName: z.string().nullable(),
  totalDiscountsSet: moneySet,
  totalTaxSet: moneySet,
  totalShippingPriceSet: moneySet,
  lineItems: z.object({ nodes: z.array(lineNode), pageInfo: pageInfoSchema }),
  refunds: z.array(refundNode),
});
export type ShopifyOrderNode = z.infer<typeof orderNode>;
const ordersResponse = z.object({
  orders: z.object({ nodes: z.array(orderNode), pageInfo: pageInfoSchema }),
});
const linesResponse = z.object({
  order: z
    .object({ lineItems: z.object({ nodes: z.array(lineNode), pageInfo: pageInfoSchema }) })
    .nullable(),
});

export const ORDERS_OP = {
  name: 'ErqOrders',
  document: ORDERS_DOCUMENT,
  schema: ordersResponse,
} satisfies GraphqlOperation<z.infer<typeof ordersResponse>>;
export const ORDER_LINES_OP = {
  name: 'ErqOrderLines',
  document: LINES_DOCUMENT,
  schema: linesResponse,
} satisfies GraphqlOperation<z.infer<typeof linesResponse>>;

const UNEXPECTED = 'Shopify returned an unexpected response.';

function toDate(value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new PermanentError(UNEXPECTED);
  return d;
}
function positiveInt(n: number): number {
  if (!Number.isInteger(n) || n < 0) throw new PermanentError(UNEXPECTED);
  return n;
}

/** Pure mapping of validated nodes. `lineNodes` is the order's complete line list (inline plus extra pages). */
export function normalizeOrder(
  node: ShopifyOrderNode,
  lineNodes: ShopifyOrderLineNode[],
): NormalizedOrder {
  const currency = node.totalTaxSet.shopMoney.currencyCode;
  const money = (set: z.infer<typeof moneySet>): number => {
    if (set.shopMoney.currencyCode !== currency) {
      throw new PermanentError('Shopify returned mixed currencies for one order.');
    }
    return parseMoneyToMinorUnits(set.shopMoney.amount, currency);
  };
  const nonNegative = (set: z.infer<typeof moneySet>): number => Math.max(0, money(set));

  const seen = new Set<string>();
  const lines: NormalizedOrderLine[] = [];
  let grossCents = 0;
  for (const l of lineNodes) {
    if (seen.has(l.id)) throw new PermanentError(UNEXPECTED);
    seen.add(l.id);
    const quantity = positiveInt(l.quantity);
    // Validate money even for dropped lines so a bad currency is never hidden.
    const unitPriceCents = money(l.originalUnitPriceSet);
    const lineDiscount = money(l.totalDiscountSet);
    if (quantity === 0) continue;
    grossCents += unitPriceCents * quantity;
    lines.push({
      externalLineId: l.id,
      externalVariantId: l.variant?.id ?? null,
      title: l.title,
      quantity,
      unitPriceCents,
      discountCents: Math.max(0, Math.min(lineDiscount, unitPriceCents * quantity)),
    });
  }

  const refunds: NormalizedRefund[] = node.refunds.map((r) => {
    if (r.refundLineItems.pageInfo.hasNextPage || r.refundShippingLines.pageInfo.hasNextPage) {
      throw new PermanentError('An order has too many refund lines to import.');
    }
    const refundLines: NormalizedRefund['lines'] = [];
    let restock = false;
    for (const rl of r.refundLineItems.nodes) {
      const quantity = positiveInt(rl.quantity);
      const amountCents = money(rl.subtotalSet);
      if (quantity === 0) continue;
      // An unrecognised restock type counts as a restock; only an explicit NO_RESTOCK does not.
      if (rl.restockType !== 'NO_RESTOCK') restock = true;
      refundLines.push({ externalLineId: rl.lineItem.id, quantity, amountCents });
    }
    const shippingRefundCents = r.refundShippingLines.nodes.reduce(
      (sum, s) => sum + money(s.subtotalAmountSet),
      0,
    );
    const total = money(r.totalRefundedSet);
    // With no line items the total is all we have; it includes tax (documented limitation).
    const amountCents =
      refundLines.length > 0
        ? refundLines.reduce((sum, rl) => sum + rl.amountCents, 0)
        : Math.max(0, total - shippingRefundCents);
    return {
      externalId: r.id,
      refundedAt: toDate(r.createdAt),
      amountCents,
      shippingRefundCents,
      restock,
      lines: refundLines,
    };
  });

  return {
    externalId: node.id,
    // Unknown source names (web, shopify_draft_order, apps, ...) are online; only POS is separate.
    channel: node.sourceName === 'pos' ? 'shopify_pos' : 'shopify_online',
    status: node.cancelledAt ? 'cancelled' : node.closedAt ? 'closed' : 'open',
    placedAt: toDate(node.createdAt),
    cancelledAt: node.cancelledAt ? toDate(node.cancelledAt) : null,
    currency,
    grossCents,
    discountCents: nonNegative(node.totalDiscountsSet),
    shippingChargedCents: nonNegative(node.totalShippingPriceSet),
    taxCents: nonNegative(node.totalTaxSet),
    customerExternalId: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    landingSite: null,
    isTest: node.test,
    updatedAt: toDate(node.updatedAt),
    lines,
    refunds,
  };
}

export async function fetchOrders(
  gql: ShopifyGraphqlClient,
  ctx: GraphqlContext,
  cursor: string | null,
  options: FetchOptions,
): Promise<Page<NormalizedOrder>> {
  const after = decodeCursor(cursor);
  // Backfill filters and sorts by creation. Incremental filters and sorts by update time.
  // The updated_at filter can miss changes: an order whose update does not bump updated_at (for
  // example a refund or edit recorded late) is not returned, and an order updated between two
  // incrementals is only seen if its updated_at is at or after the stored watermark, so the
  // caller should overlap its window. Shopify's search index may also lag a few seconds.
  const query = options.updatedSince
    ? `updated_at:>='${options.updatedSince.toISOString()}'`
    : options.since
      ? `created_at:>='${options.since.toISOString()}'`
      : null;
  const { data, cost: firstCost } = await gql.query(ctx, ORDERS_OP, {
    first: ORDERS_PAGE_SIZE,
    after,
    query,
    sortKey: options.updatedSince ? 'UPDATED_AT' : 'CREATED_AT',
  });
  let cost = firstCost;
  const items: NormalizedOrder[] = [];
  for (const node of data.orders.nodes) {
    if (node.refunds.length > ORDER_REFUNDS_INLINE) {
      throw new PermanentError('An order has too many refunds to import.');
    }
    const lineNodes = [...node.lineItems.nodes];
    let info = node.lineItems.pageInfo;
    let extra = 0;
    while (info.hasNextPage && extra < MAX_EXTRA_PAGES) {
      if (!info.endCursor) throw new PermanentError(UNEXPECTED);
      const res = await gql.query(ctx, ORDER_LINES_OP, {
        id: node.id,
        first: ORDER_LINES_EXTRA_PAGE_SIZE,
        after: info.endCursor,
      });
      cost += res.cost;
      if (res.data.order === null) throw new PermanentError(UNEXPECTED);
      lineNodes.push(...res.data.order.lineItems.nodes);
      info = res.data.order.lineItems.pageInfo;
      extra += 1;
    }
    if (info.hasNextPage) throw new PermanentError('An order has too many lines to import.');
    items.push(normalizeOrder(node, lineNodes));
  }
  return { items, nextCursor: nextCursorOf(data.orders.pageInfo), cost };
}
