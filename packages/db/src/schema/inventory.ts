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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { skus } from './catalog';
import { storeConnections } from './connections';
import { tenantId } from './tenant';
import { timestamps } from './timestamps';

export const locationType = pgEnum('location_type', ['warehouse', 'store', '3pl', 'fba', 'other']);
export const locationSource = pgEnum('location_source', ['shopify', 'manual']);
export const movementReason = pgEnum('movement_reason', [
  'sale',
  'return',
  'restock',
  'adjustment',
  'count',
  'sync_correction',
]);

export const locations = pgTable(
  'locations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    storeConnectionId: uuid('store_connection_id'),
    externalId: text('external_id'),
    name: text('name').notNull(),
    type: locationType('type').notNull().default('warehouse'),
    address: text('address'),
    source: locationSource('source').notNull().default('manual'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    unique('locations_org_id_uq').on(t.orgId, t.id),
    foreignKey({
      columns: [t.orgId, t.storeConnectionId],
      foreignColumns: [storeConnections.orgId, storeConnections.id],
    }).onDelete('cascade'),
    uniqueIndex('locations_external_uq')
      .on(t.orgId, t.storeConnectionId, t.externalId)
      .where(sql`${t.externalId} is not null`),
    uniqueIndex('locations_manual_name_uq')
      .on(t.orgId, t.name)
      .where(sql`${t.storeConnectionId} is null`),
    check(
      'locations_shopify_ids',
      sql`${t.source} <> 'shopify' or (${t.storeConnectionId} is not null and ${t.externalId} is not null)`,
    ),
  ],
);

export const inventoryLevels = pgTable(
  'inventory_levels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    skuId: uuid('sku_id').notNull(),
    locationId: uuid('location_id').notNull(),
    /** May be negative: stores can oversell. */
    onHand: integer('on_hand').notNull(),
    reserved: integer('reserved').notNull().default(0),
    incoming: integer('incoming').notNull().default(0),
    reorderPoint: integer('reorder_point'),
    safetyStock: integer('safety_stock'),
    countedAt: timestamp('counted_at', { withTimezone: true }),
    externalUpdatedAt: timestamp('external_updated_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique('inventory_levels_org_sku_loc_uq').on(t.orgId, t.skuId, t.locationId),
    foreignKey({ columns: [t.orgId, t.skuId], foreignColumns: [skus.orgId, skus.id] }).onDelete(
      'cascade',
    ),
    foreignKey({
      columns: [t.orgId, t.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }).onDelete('cascade'),
    check(
      'inventory_levels_nonneg',
      sql`${t.reserved} >= 0 and ${t.incoming} >= 0 and (${t.reorderPoint} is null or ${t.reorderPoint} >= 0) and (${t.safetyStock} is null or ${t.safetyStock} >= 0)`,
    ),
    index('inventory_levels_org_loc_idx').on(t.orgId, t.locationId),
  ],
);

export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    skuId: uuid('sku_id').notNull(),
    locationId: uuid('location_id').notNull(),
    delta: integer('delta').notNull(),
    reason: movementReason('reason').notNull(),
    refType: text('ref_type'),
    refId: text('ref_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The ledger is append-only: no cascade, or deleting a sku or location would erase history (cascades bypass RLS and REVOKE).
    foreignKey({ columns: [t.orgId, t.skuId], foreignColumns: [skus.orgId, skus.id] }).onDelete(
      'no action',
    ),
    foreignKey({
      columns: [t.orgId, t.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }).onDelete('no action'),
    check('inventory_movements_delta_nonzero', sql`${t.delta} <> 0`),
    uniqueIndex('inventory_movements_ref_uq')
      .on(t.orgId, t.refType, t.refId, t.skuId, t.locationId, t.reason)
      .where(sql`${t.refId} is not null and ${t.refType} is not null`),
    index('inventory_movements_org_sku_time_idx').on(t.orgId, t.skuId, t.occurredAt),
  ],
);

export const skuChannelListings = pgTable(
  'sku_channel_listings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    skuId: uuid('sku_id').notNull(),
    storeConnectionId: uuid('store_connection_id').notNull(),
    externalProductId: text('external_product_id').notNull(),
    externalVariantId: text('external_variant_id').notNull(),
    channelPriceCents: bigint('channel_price_cents', { mode: 'number' }),
    currency: char('currency', { length: 3 }).notNull().default('USD'),
    externalUpdatedAt: timestamp('external_updated_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique('sku_channel_listings_variant_uq').on(t.orgId, t.storeConnectionId, t.externalVariantId),
    foreignKey({ columns: [t.orgId, t.skuId], foreignColumns: [skus.orgId, skus.id] }).onDelete(
      'cascade',
    ),
    foreignKey({
      columns: [t.orgId, t.storeConnectionId],
      foreignColumns: [storeConnections.orgId, storeConnections.id],
    }).onDelete('cascade'),
    check(
      'sku_channel_listings_price_nonneg',
      sql`${t.channelPriceCents} is null or ${t.channelPriceCents} >= 0`,
    ),
    index('sku_channel_listings_org_sku_idx').on(t.orgId, t.skuId),
  ],
);
