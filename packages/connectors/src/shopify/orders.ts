// packages/connectors/src/shopify/orders.ts
// https://shopify.dev/docs/api/admin-graphql/latest/queries/orders  (query filters: created_at, updated_at)
// https://shopify.dev/docs/api/admin-graphql/latest/objects/Order
// https://shopify.dev/docs/api/admin-graphql/latest/objects/Refund
// UNVERIFIED against real Shopify (first-install checklist): the field names below (sourceName,
// totalShippingPriceSet, refundShippingLines.subtotalAmountSet, refundLineItems.restockType,
// Order.refunds(first:)) and the API version they exist in were written from the docs, not run.
// Protected customer data is not requested: customer, UTM and landing_site stay null.
import { z } from 'zod';
import { PermanentError, TransientError } from '../errors';
import type { NormalizedOrder, NormalizedOrderLine, NormalizedRefund } from '../normalized';
import type { FetchOptions, Page } from '../types';
import {
  decodeCursor,
  MAX_EXTRA_PAGES,
  nextCursorOf,
  ORDER_REFUNDS_MAX,
  REFUND_LINES_EXTRA_PAGE_SIZE,
  REFUND_SHIPPING_EXTRA_PAGE_SIZE,
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

const REFUND_LINE_FIELDS = `quantity restockType lineItem { id } subtotalSet ${MONEY}`;
const REFUND_SHIPPING_FIELDS = `subtotalAmountSet ${MONEY}`;
const REFUND_FIELDS = `id createdAt totalRefundedSet ${MONEY}
        refundLineItems(first: ${REFUND_LINES_INLINE}) {
          nodes { ${REFUND_LINE_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
        refundShippingLines(first: ${REFUND_SHIPPING_INLINE}) {
          nodes { ${REFUND_SHIPPING_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }`;

// Refunds are requested one beyond the supported count so that an overflow is detected, not truncated.
const ORDERS_DOCUMENT = `query ErqOrders($first: Int!, $after: String, $query: String, $sortKey: OrderSortKeys!) {
  orders(first: $first, after: $after, query: $query, sortKey: $sortKey) {
    nodes {
      id createdAt updatedAt cancelledAt closedAt test sourceName taxesIncluded
      totalDiscountsSet ${MONEY}
      totalTaxSet ${MONEY}
      totalShippingPriceSet ${MONEY}
      lineItems(first: ${ORDER_LINES_INLINE}) {
        nodes { ${LINE_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
      refunds(first: ${ORDER_REFUNDS_INLINE + 1}) { ${REFUND_FIELDS} }
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

const REFUNDS_DOCUMENT = `query ErqOrderRefunds($id: ID!, $first: Int!) {
  order(id: $id) {
    refunds(first: $first) { ${REFUND_FIELDS} }
  }
}`;
const REFUND_LINES_DOCUMENT = `query ErqRefundLines($id: ID!, $first: Int!, $after: String) {
  node(id: $id) {
    ... on Refund {
      refundLineItems(first: $first, after: $after) {
        nodes { ${REFUND_LINE_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
const REFUND_SHIPPING_DOCUMENT = `query ErqRefundShipping($id: ID!, $first: Int!, $after: String) {
  node(id: $id) {
    ... on Refund {
      refundShippingLines(first: $first, after: $after) {
        nodes { ${REFUND_SHIPPING_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
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
const refundLineNode = z.object({
  quantity: z.number(),
  restockType: z.string().nullable(),
  lineItem: z.object({ id: z.string() }),
  subtotalSet: moneySet,
});
const refundShippingNode = z.object({ subtotalAmountSet: moneySet });
const refundNode = z.object({
  id: z.string(),
  createdAt: z.string(),
  totalRefundedSet: moneySet,
  refundLineItems: z.object({ nodes: z.array(refundLineNode), pageInfo: pageInfoSchema }),
  refundShippingLines: z.object({ nodes: z.array(refundShippingNode), pageInfo: pageInfoSchema }),
});
type ShopifyRefundNode = z.infer<typeof refundNode>;
const orderNode = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  cancelledAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  test: z.boolean(),
  taxesIncluded: z.boolean(),
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

const refundsResponse = z.object({
  order: z.object({ refunds: z.array(refundNode) }).nullable(),
});
const refundLinesResponse = z.object({
  node: z
    .object({
      refundLineItems: z.object({ nodes: z.array(refundLineNode), pageInfo: pageInfoSchema }),
    })
    .nullable(),
});
const refundShippingResponse = z.object({
  node: z
    .object({
      refundShippingLines: z.object({
        nodes: z.array(refundShippingNode),
        pageInfo: pageInfoSchema,
      }),
    })
    .nullable(),
});
export const ORDER_REFUNDS_OP = {
  name: 'ErqOrderRefunds',
  document: REFUNDS_DOCUMENT,
  schema: refundsResponse,
} satisfies GraphqlOperation<z.infer<typeof refundsResponse>>;
export const REFUND_LINES_OP = {
  name: 'ErqRefundLines',
  document: REFUND_LINES_DOCUMENT,
  schema: refundLinesResponse,
} satisfies GraphqlOperation<z.infer<typeof refundLinesResponse>>;
export const REFUND_SHIPPING_OP = {
  name: 'ErqRefundShipping',
  document: REFUND_SHIPPING_DOCUMENT,
  schema: refundShippingResponse,
} satisfies GraphqlOperation<z.infer<typeof refundShippingResponse>>;
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
const RACE = 'Shopify data changed while it was being read. Retrying.';
const TOO_MANY_REFUND_LINES = 'An order has too many refund lines to import.';

function toDate(value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new PermanentError(UNEXPECTED);
  return d;
}
function nonNegativeInt(n: number): number {
  if (!Number.isInteger(n) || n < 0) throw new PermanentError(UNEXPECTED);
  return n;
}

/** Pure mapping of validated nodes. `lineNodes` is the order's complete line list (inline plus extra pages). */
export function normalizeOrder(
  node: ShopifyOrderNode,
  lineNodes: ShopifyOrderLineNode[],
): NormalizedOrder {
  // LIMITATION (documented, not handled): when `taxesIncluded` is true the line prices already
  // contain tax, yet tax is also reported separately, so net sales are overstated for tax-inclusive
  // shops. The US target market is tax-exclusive and non-US tax handling is out of scope for v1.
  // UNVERIFIED against real Shopify: totalShippingPriceSet vs totalDiscountsSet. A free-shipping
  // discount may be included in totalDiscountsSet and also reduce the shipping price, which would
  // subtract it twice. Check on the first real install.
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
    const quantity = nonNegativeInt(l.quantity);
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
      throw new PermanentError(TOO_MANY_REFUND_LINES);
    }
    const refundLines: NormalizedRefund['lines'] = [];
    let restock = false;
    for (const rl of r.refundLineItems.nodes) {
      const quantity = nonNegativeInt(rl.quantity);
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
    // LIMITATIONS: order-level refund adjustments (manual amounts with no line item) are not in the
    // line sums, and a restock-only refund with zero money still reports its line subtotals. Refund
    // lines whose lineItem id is not among the order's lines are passed through for the sink to handle.
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
  const add = (n: number): void => {
    cost += n;
  };
  const items: NormalizedOrder[] = [];
  for (const node of data.orders.nodes) {
    const resolved = { ...node, refunds: await completeRefunds(gql, ctx, node, add) };
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
      // The order can vanish between the two queries; retry the page instead of failing for good.
      if (res.data.order === null) throw new TransientError(RACE);
      // Lines edited between pages shift the cursor and can repeat a line: retry, do not fail.
      for (const l of res.data.order.lineItems.nodes) {
        if (lineNodes.some((x) => x.id === l.id)) throw new TransientError(RACE);
        lineNodes.push(l);
      }
      info = res.data.order.lineItems.pageInfo;
      extra += 1;
    }
    if (info.hasNextPage) throw new PermanentError('An order has too many lines to import.');
    items.push(normalizeOrder(resolved, lineNodes));
  }
  return { items, nextCursor: nextCursorOf(data.orders.pageInfo), cost };
}

type Conn<N> = { nodes: N[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };

/** Pages one refund connection (lines or shipping) until done, bounded by MAX_EXTRA_PAGES. */
async function drain<N>(
  inline: Conn<N>,
  fetchMore: (after: string) => Promise<Conn<N>>,
): Promise<Conn<N>> {
  const nodes = [...inline.nodes];
  let info = inline.pageInfo;
  let extra = 0;
  while (info.hasNextPage && extra < MAX_EXTRA_PAGES) {
    if (!info.endCursor) throw new PermanentError(UNEXPECTED);
    const res = await fetchMore(info.endCursor);
    nodes.push(...res.nodes);
    info = res.pageInfo;
    extra += 1;
  }
  if (info.hasNextPage) throw new PermanentError(TOO_MANY_REFUND_LINES);
  return { nodes, pageInfo: info };
}

/**
 * Order.refunds is a plain list without a cursor (UNVERIFIED, first-install checklist), so the
 * inline query asks for one more than ORDER_REFUNDS_INLINE; if that many came back the order is
 * re-read once with ORDER_REFUNDS_MAX + 1. More than ORDER_REFUNDS_MAX refunds fails loudly.
 * Refund lines and shipping lines beyond the inline sizes are paged through node(id).
 */
async function completeRefunds(
  gql: ShopifyGraphqlClient,
  ctx: GraphqlContext,
  node: ShopifyOrderNode,
  addCost: (n: number) => void,
): Promise<ShopifyRefundNode[]> {
  let refunds = node.refunds;
  if (refunds.length > ORDER_REFUNDS_INLINE) {
    const res = await gql.query(ctx, ORDER_REFUNDS_OP, {
      id: node.id,
      first: ORDER_REFUNDS_MAX + 1,
    });
    addCost(res.cost);
    if (res.data.order === null) throw new TransientError(RACE);
    refunds = res.data.order.refunds;
    if (refunds.length > ORDER_REFUNDS_MAX) {
      throw new PermanentError('An order has too many refunds to import.');
    }
  }
  const out: ShopifyRefundNode[] = [];
  for (const r of refunds) {
    const lines = await drain(r.refundLineItems, async (after) => {
      const res = await gql.query(ctx, REFUND_LINES_OP, {
        id: r.id,
        first: REFUND_LINES_EXTRA_PAGE_SIZE,
        after,
      });
      addCost(res.cost);
      if (res.data.node === null) throw new TransientError(RACE);
      return res.data.node.refundLineItems;
    });
    const shipping = await drain(r.refundShippingLines, async (after) => {
      const res = await gql.query(ctx, REFUND_SHIPPING_OP, {
        id: r.id,
        first: REFUND_SHIPPING_EXTRA_PAGE_SIZE,
        after,
      });
      addCost(res.cost);
      if (res.data.node === null) throw new TransientError(RACE);
      return res.data.node.refundShippingLines;
    });
    out.push({ ...r, refundLineItems: lines, refundShippingLines: shipping });
  }
  return out;
}
