// packages/connectors/src/testing/shopify-fixtures.ts
// A complete fake shop in Shopify's GraphQL response shape, plus the hand-written normalized result.
// `expected` is typed out by hand and must never be derived with the code under test.
import {
  INVENTORY_ITEMS_PAGE_SIZE,
  INVENTORY_LEVELS_INLINE,
  LOCATIONS_PAGE_SIZE,
  ORDER_LINES_INLINE,
  ORDER_REFUNDS_INLINE,
  ORDERS_PAGE_SIZE,
  PRODUCTS_PAGE_SIZE,
  REFUND_LINES_INLINE,
  REFUND_SHIPPING_INLINE,
  VARIANTS_PAGE_SIZE,
} from '../shopify/cursor';
import type {
  NormalizedInventoryLevel,
  NormalizedLocation,
  NormalizedOrder,
  NormalizedProduct,
} from '../normalized';
import type { ConnectionContext } from '../types';
import {
  FakeShopifyAdmin,
  gqlOk,
  inventoryQueryCost,
  ordersQueryCost,
  paginate,
  productsQueryCost,
} from './fake-shopify-admin';

const gid = (kind: string, n: number) => `gid://shopify/${kind}/${n}`;
const money = (amount: string) => ({ shopMoney: { amount, currencyCode: 'USD' } });
const connection = <T>(nodes: T[], size: number) => ({
  nodes: nodes.slice(0, size),
  pageInfo: {
    hasNextPage: nodes.length > size,
    endCursor: nodes.length > size ? String(size - 1) : null,
  },
});
const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : fallback;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
/** The `updated_at:>='ISO'` / `created_at:>='ISO'` filter the connector sends, as [field, time]. */
function parseFilter(query: unknown): ['updated_at' | 'created_at', number] | null {
  const m = typeof query === 'string' ? /^(updated_at|created_at):>='(.+)'$/.exec(query) : null;
  return m ? [m[1] as 'updated_at' | 'created_at', new Date(m[2]!).getTime()] : null;
}

const LOCATION_NODES = [
  {
    id: gid('Location', 1),
    name: 'Main warehouse',
    isActive: true,
    isFulfillmentService: false,
    address: { formatted: ['1 Dock St', 'Austin TX 78701', 'United States'] },
  },
  {
    id: gid('Location', 2),
    name: 'ShipBob',
    isActive: true,
    isFulfillmentService: true,
    address: null,
  },
];

const variant = (
  n: number,
  v: {
    sku: string | null;
    barcode?: string | null;
    price: string;
    compareAt?: string | null;
    cost?: string | null;
    updatedAt: string;
  },
) => ({
  id: gid('ProductVariant', n),
  sku: v.sku,
  barcode: v.barcode ?? null,
  price: v.price,
  compareAtPrice: v.compareAt ?? null,
  updatedAt: v.updatedAt,
  inventoryItem: { unitCost: v.cost ? { amount: v.cost, currencyCode: 'USD' } : null },
});

const PRODUCT_ROWS = [
  {
    id: gid('Product', 101),
    title: 'Canvas Tote',
    vendor: 'Acme',
    productType: 'Bags',
    status: 'ACTIVE',
    updatedAt: '2026-02-10T09:00:00Z',
    variants: [
      variant(1001, {
        sku: 'TOTE-NAT',
        barcode: '0001',
        price: '24.00',
        compareAt: '30.00',
        cost: '8.50',
        updatedAt: '2026-02-10T09:00:00Z',
      }),
      variant(1002, {
        sku: 'TOTE-BLK',
        price: '24.00',
        cost: '8.75',
        updatedAt: '2026-02-10T09:00:00Z',
      }),
    ],
  },
  {
    id: gid('Product', 102),
    title: 'Ceramic Mug',
    vendor: 'Acme',
    productType: '',
    status: 'ACTIVE',
    updatedAt: '2026-02-20T09:00:00Z',
    variants: [
      variant(1003, {
        sku: 'MUG-12',
        price: '14.50',
        cost: '4.20',
        updatedAt: '2026-02-20T09:00:00Z',
      }),
      variant(1004, { sku: null, price: '16.00', updatedAt: '2026-02-20T09:00:00Z' }),
    ],
  },
  {
    id: gid('Product', 103),
    title: 'Prototype Candle',
    vendor: '',
    productType: 'Home',
    status: 'DRAFT',
    updatedAt: '2026-03-05T09:00:00Z',
    variants: [variant(1005, { sku: 'CNDL-1', price: '19.99', updatedAt: '2026-03-05T09:00:00Z' })],
  },
];

const level = (
  location: number,
  updatedAt: string,
  q: { onHand: number; committed?: number; reserved?: number; incoming?: number },
) => ({
  updatedAt,
  location: { id: gid('Location', location) },
  quantities: [
    { name: 'on_hand', quantity: q.onHand },
    { name: 'committed', quantity: q.committed ?? 0 },
    { name: 'reserved', quantity: q.reserved ?? 0 },
    { name: 'incoming', quantity: q.incoming ?? 0 },
  ],
});
// `updatedAt` on the row is the hidden timestamp the `updated_at` filter applies to.
const INVENTORY_ROWS = [
  {
    id: gid('InventoryItem', 2001),
    variantId: gid('ProductVariant', 1001),
    updatedAt: '2026-02-10T09:00:00Z',
    levels: [
      level(1, '2026-02-10T09:00:00Z', { onHand: 20, committed: 3, reserved: 2, incoming: 4 }),
      level(2, '2026-02-10T09:00:00Z', { onHand: 5 }),
    ],
  },
  {
    id: gid('InventoryItem', 2002),
    variantId: gid('ProductVariant', 1002),
    updatedAt: '2026-02-10T09:00:00Z',
    levels: [
      level(1, '2026-02-10T09:00:00Z', { onHand: 12 }),
      level(2, '2026-02-10T09:00:00Z', { onHand: 0 }),
    ],
  },
  {
    id: gid('InventoryItem', 2003),
    variantId: gid('ProductVariant', 1003),
    updatedAt: '2026-02-20T09:00:00Z',
    levels: [
      level(1, '2026-02-20T09:00:00Z', { onHand: 40 }),
      level(2, '2026-02-20T09:00:00Z', { onHand: 8 }),
    ],
  },
  {
    id: gid('InventoryItem', 2004),
    variantId: gid('ProductVariant', 1004),
    updatedAt: '2026-02-20T09:00:00Z',
    levels: [
      level(1, '2026-02-20T09:00:00Z', { onHand: 7 }),
      level(2, '2026-02-20T09:00:00Z', { onHand: 1 }),
    ],
  },
  {
    id: gid('InventoryItem', 2005),
    variantId: gid('ProductVariant', 1005),
    updatedAt: '2026-03-05T09:00:00Z',
    levels: [
      level(1, '2026-03-05T09:00:00Z', { onHand: 15 }),
      level(2, '2026-03-05T09:00:00Z', { onHand: 15 }),
    ],
  },
];

const line = (n: number, variant: number, qty: number, unit: string, discount = '0.00') => ({
  id: gid('LineItem', n),
  title: `Item ${n}`,
  quantity: qty,
  variant: { id: gid('ProductVariant', variant) },
  originalUnitPriceSet: money(unit),
  totalDiscountSet: money(discount),
});
interface OrderRow {
  id: string;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  closedAt: string | null;
  test: boolean;
  taxesIncluded: boolean;
  sourceName: string | null;
  totalDiscountsSet: ReturnType<typeof money>;
  totalTaxSet: ReturnType<typeof money>;
  totalShippingPriceSet: ReturnType<typeof money>;
  lines: ReturnType<typeof line>[];
  refunds: unknown[];
}
const order = (
  n: number,
  o: Partial<OrderRow> & { createdAt: string; lines: OrderRow['lines'] },
): OrderRow => ({
  id: gid('Order', n),
  updatedAt: o.createdAt,
  cancelledAt: null,
  closedAt: null,
  test: false,
  taxesIncluded: false,
  sourceName: 'web',
  totalDiscountsSet: money('0.00'),
  totalTaxSet: money('0.00'),
  totalShippingPriceSet: money('0.00'),
  refunds: [],
  ...o,
});

const ORDER_ROWS: OrderRow[] = [
  order(3001, {
    createdAt: '2026-03-01T12:00:00Z',
    lines: [line(4001, 1001, 2, '24.00', '4.00'), line(4002, 1003, 1, '14.50', '1.00')],
    totalDiscountsSet: money('5.00'),
    totalShippingPriceSet: money('5.99'),
    totalTaxSet: money('4.12'),
  }),
  order(3002, {
    createdAt: '2026-03-02T15:30:00Z',
    closedAt: '2026-03-02T15:30:00Z',
    sourceName: 'pos',
    lines: [line(4003, 1004, 1, '16.00')],
    totalTaxSet: money('1.32'),
  }),
  order(3003, {
    createdAt: '2026-03-03T07:00:00Z',
    updatedAt: '2026-03-03T08:00:00Z',
    cancelledAt: '2026-03-03T08:00:00Z',
    closedAt: '2026-03-03T08:00:00Z',
    lines: [line(4004, 1002, 1, '24.00')],
    totalShippingPriceSet: money('5.99'),
  }),
  order(3004, {
    createdAt: '2026-03-04T10:00:00Z',
    test: true,
    lines: [line(4005, 1005, 3, '19.99')],
  }),
  order(3005, {
    createdAt: '2026-03-05T09:00:00Z',
    updatedAt: '2026-03-08T11:00:00Z',
    lines: [line(4006, 1001, 3, '24.00'), line(4007, 1003, 2, '14.50')],
    totalShippingPriceSet: money('5.99'),
    totalTaxSet: money('8.40'),
    refunds: [
      {
        id: gid('Refund', 9001),
        createdAt: '2026-03-08T11:00:00Z',
        totalRefundedSet: money('47.69'),
        refundLineItems: connection(
          [
            {
              quantity: 1,
              restockType: 'RETURN',
              lineItem: { id: gid('LineItem', 4006) },
              subtotalSet: money('24.00'),
            },
            {
              quantity: 1,
              restockType: 'RETURN',
              lineItem: { id: gid('LineItem', 4007) },
              subtotalSet: money('14.50'),
            },
          ],
          REFUND_LINES_INLINE,
        ),
        refundShippingLines: connection(
          [{ subtotalAmountSet: money('5.99') }],
          REFUND_SHIPPING_INLINE,
        ),
      },
    ],
  }),
];

const D = (iso: string) => new Date(iso);
const EXPECTED_LOCATIONS: NormalizedLocation[] = [
  {
    externalId: 'gid://shopify/Location/1',
    name: 'Main warehouse',
    type: 'warehouse',
    address: '1 Dock St, Austin TX 78701, United States',
    isActive: true,
  },
  {
    externalId: 'gid://shopify/Location/2',
    name: 'ShipBob',
    type: '3pl',
    address: null,
    isActive: true,
  },
];

const EXPECTED_PRODUCTS: NormalizedProduct[] = [
  {
    externalId: 'gid://shopify/Product/101',
    title: 'Canvas Tote',
    brand: 'Acme',
    category: 'Bags',
    status: 'active',
    updatedAt: D('2026-02-10T09:00:00Z'),
    variants: [
      {
        externalId: 'gid://shopify/ProductVariant/1001',
        skuCode: 'TOTE-NAT',
        barcode: '0001',
        priceCents: 2400,
        compareAtPriceCents: 3000,
        currency: 'USD',
        unitCostCents: 850,
        updatedAt: D('2026-02-10T09:00:00Z'),
      },
      {
        externalId: 'gid://shopify/ProductVariant/1002',
        skuCode: 'TOTE-BLK',
        barcode: null,
        priceCents: 2400,
        compareAtPriceCents: null,
        currency: 'USD',
        unitCostCents: 875,
        updatedAt: D('2026-02-10T09:00:00Z'),
      },
    ],
  },
  {
    externalId: 'gid://shopify/Product/102',
    title: 'Ceramic Mug',
    brand: 'Acme',
    category: null,
    status: 'active',
    updatedAt: D('2026-02-20T09:00:00Z'),
    variants: [
      {
        externalId: 'gid://shopify/ProductVariant/1003',
        skuCode: 'MUG-12',
        barcode: null,
        priceCents: 1450,
        compareAtPriceCents: null,
        currency: 'USD',
        unitCostCents: 420,
        updatedAt: D('2026-02-20T09:00:00Z'),
      },
      {
        externalId: 'gid://shopify/ProductVariant/1004',
        skuCode: null,
        barcode: null,
        priceCents: 1600,
        compareAtPriceCents: null,
        currency: 'USD',
        unitCostCents: null,
        updatedAt: D('2026-02-20T09:00:00Z'),
      },
    ],
  },
  {
    externalId: 'gid://shopify/Product/103',
    title: 'Prototype Candle',
    brand: null,
    category: 'Home',
    status: 'draft',
    updatedAt: D('2026-03-05T09:00:00Z'),
    variants: [
      {
        externalId: 'gid://shopify/ProductVariant/1005',
        skuCode: 'CNDL-1',
        barcode: null,
        priceCents: 1999,
        compareAtPriceCents: null,
        currency: 'USD',
        unitCostCents: null,
        updatedAt: D('2026-03-05T09:00:00Z'),
      },
    ],
  },
];

const lvl = (
  variant: number,
  location: number,
  updatedAt: string,
  onHand: number,
  reserved = 0,
  incoming = 0,
): NormalizedInventoryLevel => ({
  externalVariantId: `gid://shopify/ProductVariant/${variant}`,
  locationExternalId: `gid://shopify/Location/${location}`,
  onHand,
  reserved,
  incoming,
  updatedAt: D(updatedAt),
});
const EXPECTED_INVENTORY: NormalizedInventoryLevel[] = [
  lvl(1001, 1, '2026-02-10T09:00:00Z', 20, 5, 4),
  lvl(1001, 2, '2026-02-10T09:00:00Z', 5),
  lvl(1002, 1, '2026-02-10T09:00:00Z', 12),
  lvl(1002, 2, '2026-02-10T09:00:00Z', 0),
  lvl(1003, 1, '2026-02-20T09:00:00Z', 40),
  lvl(1003, 2, '2026-02-20T09:00:00Z', 8),
  lvl(1004, 1, '2026-02-20T09:00:00Z', 7),
  lvl(1004, 2, '2026-02-20T09:00:00Z', 1),
  lvl(1005, 1, '2026-03-05T09:00:00Z', 15),
  lvl(1005, 2, '2026-03-05T09:00:00Z', 15),
];

const base: Pick<
  NormalizedOrder,
  | 'currency'
  | 'customerExternalId'
  | 'utmSource'
  | 'utmMedium'
  | 'utmCampaign'
  | 'landingSite'
  | 'cancelledAt'
  | 'refunds'
> = {
  currency: 'USD',
  customerExternalId: null,
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  landingSite: null,
  cancelledAt: null,
  refunds: [],
};
const EXPECTED_ORDERS: NormalizedOrder[] = [
  {
    ...base,
    externalId: 'gid://shopify/Order/3001',
    channel: 'shopify_online',
    status: 'open',
    placedAt: D('2026-03-01T12:00:00Z'),
    grossCents: 6250,
    discountCents: 500,
    shippingChargedCents: 599,
    taxCents: 412,
    isTest: false,
    updatedAt: D('2026-03-01T12:00:00Z'),
    lines: [
      {
        externalLineId: 'gid://shopify/LineItem/4001',
        externalVariantId: 'gid://shopify/ProductVariant/1001',
        title: 'Item 4001',
        quantity: 2,
        unitPriceCents: 2400,
        discountCents: 400,
      },
      {
        externalLineId: 'gid://shopify/LineItem/4002',
        externalVariantId: 'gid://shopify/ProductVariant/1003',
        title: 'Item 4002',
        quantity: 1,
        unitPriceCents: 1450,
        discountCents: 100,
      },
    ],
  },
  {
    ...base,
    externalId: 'gid://shopify/Order/3002',
    channel: 'shopify_pos',
    status: 'closed',
    placedAt: D('2026-03-02T15:30:00Z'),
    grossCents: 1600,
    discountCents: 0,
    shippingChargedCents: 0,
    taxCents: 132,
    isTest: false,
    updatedAt: D('2026-03-02T15:30:00Z'),
    lines: [
      {
        externalLineId: 'gid://shopify/LineItem/4003',
        externalVariantId: 'gid://shopify/ProductVariant/1004',
        title: 'Item 4003',
        quantity: 1,
        unitPriceCents: 1600,
        discountCents: 0,
      },
    ],
  },
  {
    ...base,
    externalId: 'gid://shopify/Order/3003',
    channel: 'shopify_online',
    status: 'cancelled',
    placedAt: D('2026-03-03T07:00:00Z'),
    cancelledAt: D('2026-03-03T08:00:00Z'),
    grossCents: 2400,
    discountCents: 0,
    shippingChargedCents: 599,
    taxCents: 0,
    isTest: false,
    updatedAt: D('2026-03-03T08:00:00Z'),
    lines: [
      {
        externalLineId: 'gid://shopify/LineItem/4004',
        externalVariantId: 'gid://shopify/ProductVariant/1002',
        title: 'Item 4004',
        quantity: 1,
        unitPriceCents: 2400,
        discountCents: 0,
      },
    ],
  },
  {
    ...base,
    externalId: 'gid://shopify/Order/3004',
    channel: 'shopify_online',
    status: 'open',
    placedAt: D('2026-03-04T10:00:00Z'),
    grossCents: 5997,
    discountCents: 0,
    shippingChargedCents: 0,
    taxCents: 0,
    isTest: true,
    updatedAt: D('2026-03-04T10:00:00Z'),
    lines: [
      {
        externalLineId: 'gid://shopify/LineItem/4005',
        externalVariantId: 'gid://shopify/ProductVariant/1005',
        title: 'Item 4005',
        quantity: 3,
        unitPriceCents: 1999,
        discountCents: 0,
      },
    ],
  },
  {
    ...base,
    externalId: 'gid://shopify/Order/3005',
    channel: 'shopify_online',
    status: 'open',
    placedAt: D('2026-03-05T09:00:00Z'),
    grossCents: 10100,
    discountCents: 0,
    shippingChargedCents: 599,
    taxCents: 840,
    isTest: false,
    updatedAt: D('2026-03-08T11:00:00Z'),
    lines: [
      {
        externalLineId: 'gid://shopify/LineItem/4006',
        externalVariantId: 'gid://shopify/ProductVariant/1001',
        title: 'Item 4006',
        quantity: 3,
        unitPriceCents: 2400,
        discountCents: 0,
      },
      {
        externalLineId: 'gid://shopify/LineItem/4007',
        externalVariantId: 'gid://shopify/ProductVariant/1003',
        title: 'Item 4007',
        quantity: 2,
        unitPriceCents: 1450,
        discountCents: 0,
      },
    ],
    refunds: [
      {
        externalId: 'gid://shopify/Refund/9001',
        refundedAt: D('2026-03-08T11:00:00Z'),
        amountCents: 3850,
        shippingRefundCents: 599,
        restock: true,
        lines: [
          { externalLineId: 'gid://shopify/LineItem/4006', quantity: 1, amountCents: 2400 },
          { externalLineId: 'gid://shopify/LineItem/4007', quantity: 1, amountCents: 1450 },
        ],
      },
    ],
  },
];

/** A generated plain order: one tote at $24.00, a minute after the previous one, from April 2026. */
function extraOrderRow(i: number): OrderRow {
  const at = new Date(Date.UTC(2026, 3, 1) + i * 60_000).toISOString();
  return order(5000 + i, { createdAt: at, lines: [line(6000 + i, 1001, 1, '24.00')] });
}
function extraOrderExpected(i: number): NormalizedOrder {
  const at = new Date(Date.UTC(2026, 3, 1) + i * 60_000);
  return {
    ...base,
    externalId: `gid://shopify/Order/${5000 + i}`,
    channel: 'shopify_online',
    status: 'open',
    placedAt: at,
    grossCents: 2400,
    discountCents: 0,
    shippingChargedCents: 0,
    taxCents: 0,
    isTest: false,
    updatedAt: at,
    lines: [
      {
        externalLineId: `gid://shopify/LineItem/${6000 + i}`,
        externalVariantId: 'gid://shopify/ProductVariant/1001',
        title: `Item ${6000 + i}`,
        quantity: 1,
        unitPriceCents: 2400,
        discountCents: 0,
      },
    ],
  };
}

const orderNode = (o: OrderRow) => {
  const { lines, ...rest } = o;
  return { ...rest, lineItems: connection(lines, ORDER_LINES_INLINE) };
};

export interface ShopifyFixture {
  admin: FakeShopifyAdmin;
  ctx: ConnectionContext;
  expected: {
    locations: NormalizedLocation[];
    products: NormalizedProduct[];
    inventory: NormalizedInventoryLevel[];
    orders: NormalizedOrder[];
  };
}

export function createShopifyFixture(opts: { extraOrders?: number } = {}): ShopifyFixture {
  const extra = Array.from({ length: opts.extraOrders ?? 0 }, (_, i) => i);
  const orders = [...ORDER_ROWS, ...extra.map(extraOrderRow)];
  const admin = new FakeShopifyAdmin();

  admin.on('ErqLocations', (v) => {
    const first = num(v.first, LOCATIONS_PAGE_SIZE);
    const page = paginate(LOCATION_NODES, first, str(v.after));
    return gqlOk({ locations: page }, { requested: 3 + first * 6 });
  });

  admin.on('ErqProducts', (v) => {
    const first = num(v.first, PRODUCTS_PAGE_SIZE);
    const filter = parseFilter(v.query);
    const rows = PRODUCT_ROWS.filter(
      (p) => !filter || new Date(p.updatedAt).getTime() >= filter[1],
    );
    const page = paginate(rows, first, str(v.after));
    const nodes = page.nodes.map((p) => ({
      ...p,
      variants: connection(p.variants, VARIANTS_PAGE_SIZE),
    }));
    return gqlOk(
      { shop: { currencyCode: 'USD' }, products: { ...page, nodes } },
      { requested: productsQueryCost(first, VARIANTS_PAGE_SIZE) },
    );
  });
  admin.on('ErqProductVariants', (v) => {
    const first = num(v.first, VARIANTS_PAGE_SIZE);
    const product = PRODUCT_ROWS.find((p) => p.id === v.id);
    return gqlOk(
      { product: product ? { variants: paginate(product.variants, first, str(v.after)) } : null },
      { requested: 4 + first * 3 },
    );
  });

  admin.on('ErqInventory', (v) => {
    const first = num(v.first, INVENTORY_ITEMS_PAGE_SIZE);
    const filter = parseFilter(v.query);
    const rows = INVENTORY_ROWS.filter(
      (r) => !filter || new Date(r.updatedAt).getTime() >= filter[1],
    );
    const page = paginate(rows, first, str(v.after));
    const nodes = page.nodes.map((r) => ({
      id: r.id,
      variant: { id: r.variantId },
      inventoryLevels: connection(r.levels, INVENTORY_LEVELS_INLINE),
    }));
    return gqlOk(
      { inventoryItems: { ...page, nodes } },
      { requested: inventoryQueryCost(first, INVENTORY_LEVELS_INLINE) },
    );
  });
  admin.on('ErqInventoryLevels', (v) => {
    const first = num(v.first, INVENTORY_LEVELS_INLINE);
    const row = INVENTORY_ROWS.find((r) => r.id === v.id);
    return gqlOk(
      {
        inventoryItem: row ? { inventoryLevels: paginate(row.levels, first, str(v.after)) } : null,
      },
      { requested: 3 + first * 6 },
    );
  });

  admin.on('ErqOrders', (v) => {
    const first = num(v.first, ORDERS_PAGE_SIZE);
    const filter = parseFilter(v.query);
    const sortField = v.sortKey === 'UPDATED_AT' ? 'updatedAt' : 'createdAt';
    const rows = orders
      .filter(
        (o) =>
          !filter ||
          new Date(o[filter[0] === 'updated_at' ? 'updatedAt' : 'createdAt']).getTime() >=
            filter[1],
      )
      .sort((a, b) => new Date(a[sortField]).getTime() - new Date(b[sortField]).getTime());
    const page = paginate(rows, first, str(v.after));
    return gqlOk(
      { orders: { ...page, nodes: page.nodes.map(orderNode) } },
      {
        requested: ordersQueryCost(
          first,
          ORDER_LINES_INLINE,
          ORDER_REFUNDS_INLINE + 1,
          REFUND_LINES_INLINE,
          REFUND_SHIPPING_INLINE,
        ),
      },
    );
  });
  admin.on('ErqOrderLines', (v) => {
    const first = num(v.first, ORDER_LINES_INLINE);
    const row = orders.find((o) => o.id === v.id);
    return gqlOk(
      { order: row ? { lineItems: paginate(row.lines, first, str(v.after)) } : null },
      { requested: 4 + first * 6 },
    );
  });

  return {
    admin,
    ctx: {
      connectionId: 'c1',
      externalAccountId: 'fixture-shop.myshopify.com',
      credentials: { accessToken: 'shpat_fixture' },
    },
    expected: {
      locations: EXPECTED_LOCATIONS,
      products: EXPECTED_PRODUCTS,
      inventory: EXPECTED_INVENTORY,
      orders: [...EXPECTED_ORDERS, ...extra.map(extraOrderExpected)],
    },
  };
}
