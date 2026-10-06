import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { skus } from './catalog';
import { storeConnections } from './connections';
import { tenantId } from './tenant';
import { timestamps } from './timestamps';

export const salesChannel = pgEnum('sales_channel', ['shopify_online', 'shopify_pos']);
export const orderStatus = pgEnum('order_status', ['open', 'closed', 'cancelled']);
export const syncResource = pgEnum('sync_resource', [
  'products',
  'locations',
  'inventory',
  'orders',
]);
export const cursorStatus = pgEnum('cursor_status', ['idle', 'running', 'failed', 'complete']);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    storeConnectionId: uuid('store_connection_id').notNull(),
    externalOrderId: text('external_order_id').notNull(),
    channel: salesChannel('channel').notNull(),
    status: orderStatus('status').notNull(),
    placedAt: timestamp('placed_at', { withTimezone: true }).notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    currency: char('currency', { length: 3 }).notNull(),
    grossCents: bigint('gross_cents', { mode: 'number' }).notNull(),
    discountCents: bigint('discount_cents', { mode: 'number' }).notNull(),
    shippingChargedCents: bigint('shipping_charged_cents', { mode: 'number' }).notNull(),
    taxCents: bigint('tax_cents', { mode: 'number' }).notNull(),
    refundCents: bigint('refund_cents', { mode: 'number' }).notNull(),
    /** gross - discount - refund; negative when refunds exceed sales. */
    netCents: bigint('net_cents', { mode: 'number' }).notNull(),
    /** Opaque platform customer id. No names, emails or addresses are stored (customers table is Phase 2). */
    customerExternalId: text('customer_external_id'),
    utmSource: text('utm_source'),
    utmMedium: text('utm_medium'),
    utmCampaign: text('utm_campaign'),
    landingSite: text('landing_site'),
    isTest: boolean('is_test').notNull().default(false),
    externalUpdatedAt: timestamp('external_updated_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    unique('orders_org_id_uq').on(t.orgId, t.id),
    unique('orders_external_uq').on(t.orgId, t.storeConnectionId, t.externalOrderId),
    foreignKey({
      columns: [t.orgId, t.storeConnectionId],
      foreignColumns: [storeConnections.orgId, storeConnections.id],
    }).onDelete('cascade'),
    check(
      'orders_money_nonneg',
      sql`${t.grossCents} >= 0 and ${t.discountCents} >= 0 and ${t.shippingChargedCents} >= 0 and ${t.taxCents} >= 0 and ${t.refundCents} >= 0`,
    ),
    index('orders_org_placed_idx').on(t.orgId, t.placedAt),
    index('orders_org_channel_placed_idx').on(t.orgId, t.channel, t.placedAt),
  ],
);

export const orderLines = pgTable(
  'order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    orderId: uuid('order_id').notNull(),
    /** Null when the external variant is not mapped to a SKU yet. */
    skuId: uuid('sku_id'),
    externalLineId: text('external_line_id').notNull(),
    externalVariantId: text('external_variant_id'),
    title: text('title').notNull(),
    quantity: integer('quantity').notNull(),
    unitPriceCents: bigint('unit_price_cents', { mode: 'number' }).notNull(),
    discountCents: bigint('discount_cents', { mode: 'number' }).notNull().default(0),
    refundedQuantity: integer('refunded_quantity').notNull().default(0),
    /** Landed cost per unit in effect on the order date; null when unknown (never zero by default). */
    unitCogsCentsSnapshot: bigint('unit_cogs_cents_snapshot', { mode: 'number' }),
    ...timestamps,
  },
  (t) => [
    unique('order_lines_org_id_uq').on(t.orgId, t.id),
    unique('order_lines_external_uq').on(t.orgId, t.orderId, t.externalLineId),
    foreignKey({
      columns: [t.orgId, t.orderId],
      foreignColumns: [orders.orgId, orders.id],
    }).onDelete('cascade'),
    foreignKey({ columns: [t.orgId, t.skuId], foreignColumns: [skus.orgId, skus.id] }),
    check('order_lines_quantity_positive', sql`${t.quantity} > 0`),
    check(
      'order_lines_refunded_within_quantity',
      sql`${t.refundedQuantity} >= 0 and ${t.refundedQuantity} <= ${t.quantity}`,
    ),
    check(
      'order_lines_money_nonneg',
      sql`${t.unitPriceCents} >= 0 and ${t.discountCents} >= 0 and (${t.unitCogsCentsSnapshot} is null or ${t.unitCogsCentsSnapshot} >= 0)`,
    ),
    index('order_lines_org_sku_idx').on(t.orgId, t.skuId),
  ],
);

export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    orderId: uuid('order_id').notNull(),
    externalRefundId: text('external_refund_id').notNull(),
    refundedAt: timestamp('refunded_at', { withTimezone: true }).notNull(),
    /** Refunded amount excluding tax. */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    shippingRefundCents: bigint('shipping_refund_cents', { mode: 'number' }).notNull().default(0),
    restock: boolean('restock').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    unique('refunds_org_id_uq').on(t.orgId, t.id),
    unique('refunds_external_uq').on(t.orgId, t.orderId, t.externalRefundId),
    foreignKey({
      columns: [t.orgId, t.orderId],
      foreignColumns: [orders.orgId, orders.id],
    }).onDelete('cascade'),
    check('refunds_money_nonneg', sql`${t.amountCents} >= 0 and ${t.shippingRefundCents} >= 0`),
  ],
);

export const refundLines = pgTable(
  'refund_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    refundId: uuid('refund_id').notNull(),
    orderLineId: uuid('order_line_id').notNull(),
    quantity: integer('quantity').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    ...timestamps,
  },
  (t) => [
    unique('refund_lines_uq').on(t.orgId, t.refundId, t.orderLineId),
    foreignKey({
      columns: [t.orgId, t.refundId],
      foreignColumns: [refunds.orgId, refunds.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.orderLineId],
      foreignColumns: [orderLines.orgId, orderLines.id],
    }).onDelete('cascade'),
    check('refund_lines_quantity_positive', sql`${t.quantity} > 0`),
    check('refund_lines_amount_nonneg', sql`${t.amountCents} >= 0`),
  ],
);

export const syncCursors = pgTable(
  'sync_cursors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    storeConnectionId: uuid('store_connection_id').notNull(),
    resource: syncResource('resource').notNull(),
    cursor: text('cursor'),
    status: cursorStatus('status').notNull().default('idle'),
    /** Set for backfill runs; null for incremental runs. */
    backfillSince: timestamp('backfill_since', { withTimezone: true }),
    /** Watermark for incremental runs: the start time of the last completed run. */
    updatedSince: timestamp('updated_since', { withTimezone: true }),
    currentSyncRunId: uuid('current_sync_run_id'),
    recordsProcessed: bigint('records_processed', { mode: 'number' }).notNull().default(0),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),
    ...timestamps,
  },
  (t) => [
    unique('sync_cursors_uq').on(t.orgId, t.storeConnectionId, t.resource),
    foreignKey({
      columns: [t.orgId, t.storeConnectionId],
      foreignColumns: [storeConnections.orgId, storeConnections.id],
    }).onDelete('cascade'),
  ],
);
