import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenantId } from './tenant';
import { timestamps } from './timestamps';

export const productStatus = pgEnum('product_status', ['active', 'draft', 'archived']);
export const skuStatus = pgEnum('sku_status', ['active', 'inactive']);
export const costComponentType = pgEnum('cost_component_type', [
  'product_cost',
  'inbound_freight',
  'duties_tariffs',
  'packaging',
  'labeling_prep',
  'other_landed',
]);

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    title: text('title').notNull(),
    brand: text('brand'),
    category: text('category'),
    status: productStatus('status').notNull().default('active'),
    ...timestamps,
  },
  // (org_id, id) is the target of composite FKs so children can never reference another tenant's parent.
  (t) => [unique('products_org_id_uq').on(t.orgId, t.id)],
);

export const skus = pgTable(
  'skus',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    productId: uuid('product_id').notNull(),
    skuCode: text('sku_code').notNull(),
    barcode: text('barcode'),
    sellingPriceCents: bigint('selling_price_cents', { mode: 'number' }).notNull(),
    compareAtPriceCents: bigint('compare_at_price_cents', { mode: 'number' }),
    currency: char('currency', { length: 3 }).notNull().default('USD'),
    targetMarkupPct: numeric('target_markup_pct', { precision: 6, scale: 2 }),
    status: skuStatus('status').notNull().default('active'),
    ...timestamps,
  },
  (t) => [
    unique('skus_org_id_uq').on(t.orgId, t.id),
    unique('skus_org_code_uq').on(t.orgId, t.skuCode),
    foreignKey({
      columns: [t.orgId, t.productId],
      foreignColumns: [products.orgId, products.id],
    }).onDelete('cascade'),
    index('skus_org_product_idx').on(t.orgId, t.productId),
    check('skus_price_nonneg', sql`${t.sellingPriceCents} >= 0`),
  ],
);

export const skuCostComponents = pgTable(
  'sku_cost_components',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    skuId: uuid('sku_id').notNull(),
    componentType: costComponentType('component_type').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    perUnit: boolean('per_unit').notNull().default(true),
    currency: char('currency', { length: 3 }).notNull().default('USD'),
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    effectiveTo: date('effective_to', { mode: 'string' }),
    ...timestamps,
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.skuId], foreignColumns: [skus.orgId, skus.id] }).onDelete(
      'cascade',
    ),
    index('sku_cost_components_org_sku_idx').on(t.orgId, t.skuId),
    check('cost_amount_nonneg', sql`${t.amountCents} >= 0`),
    check(
      'cost_period_valid',
      sql`${t.effectiveTo} is null or ${t.effectiveTo} > ${t.effectiveFrom}`,
    ),
  ],
);
