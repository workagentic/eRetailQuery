import { Pool } from 'pg';
import { createTenantDb, type TenantDb } from '../src';
import { startTestDatabase, type TestDatabase } from '../src/testing';

export const ORG = '11111111-1111-4111-8111-111111111111';
export const EMPTY_ORG = '22222222-2222-4222-8222-222222222222';
export const SHOPIFY = '11111111-1111-4111-8111-0000000000a1';
export const AMAZON = '11111111-1111-4111-8111-0000000000a2';
export const META_CONN = '11111111-1111-4111-8111-0000000000b1';
export const AMZ_ADS_CONN = '11111111-1111-4111-8111-0000000000b2';
export const SKU = '11111111-1111-4111-8111-0000000000c1';

export interface ReportDb {
  tdb: TestDatabase;
  owner: Pool;
  db: TenantDb;
  stop(): Promise<void>;
}

/** Two orgs (one with a Shopify and an Amazon connection, a Meta and an Amazon Ads connection and one SKU; one empty). */
export async function startReportDb(): Promise<ReportDb> {
  const tdb = await startTestDatabase();
  const owner = new Pool({ connectionString: tdb.ownerUrl });
  for (const org of [ORG, EMPTY_ORG]) {
    await owner.query(`insert into orgs (id, name, slug) values ($1, 'Org', 'org-' || ($1::uuid)::text)`, [
      org,
    ]);
  }
  await owner.query(
    `insert into store_connections (id, org_id, platform, external_account_id, status) values
       ($1, $3, 'shopify', 'shop', 'demo'), ($2, $3, 'amazon', 'amz', 'demo')`,
    [SHOPIFY, AMAZON, ORG],
  );
  await owner.query(
    `insert into ad_connections (id, org_id, platform, external_account_id, status) values
       ($1, $3, 'meta', 'act', 'demo'), ($2, $3, 'amazon_ads', 'amzads', 'demo')`,
    [META_CONN, AMZ_ADS_CONN, ORG],
  );
  await owner.query(`insert into products (id, org_id, title) values ($1, $2, 'Widget')`, [
    SKU,
    ORG,
  ]);
  await owner.query(
    `insert into skus (id, org_id, product_id, sku_code, selling_price_cents) values ($1, $2, $1, 'W-1', 5000)`,
    [SKU, ORG],
  );
  const db = createTenantDb(tdb.appUrl);
  return {
    tdb,
    owner,
    db,
    async stop() {
      await db.close();
      await owner.end();
      await tdb.stop();
    },
  };
}

export interface OrderSpec {
  channel?: 'shopify_online' | 'amazon';
  /** ISO timestamp. */
  placedAt: string;
  gross?: number;
  discount?: number;
  refund?: number;
  status?: 'closed' | 'cancelled';
  isTest?: boolean;
  paymentFee?: number;
  marketplaceFee?: number;
  fulfillment?: number;
  /** unit cogs snapshot per line; null leaves the snapshot unknown. */
  lines?: { quantity: number; price: number; cogs: number | null; skuId?: string }[];
}

let seq = 0;
export async function addOrder(owner: Pool, spec: OrderSpec, org = ORG): Promise<string> {
  seq++;
  const channel = spec.channel ?? 'shopify_online';
  const conn = channel === 'amazon' ? AMAZON : SHOPIFY;
  const gross = spec.gross ?? 10000;
  const discount = spec.discount ?? 0;
  const refund = spec.refund ?? 0;
  const { rows } = await owner.query<{ id: string }>(
    `insert into orders (org_id, store_connection_id, external_order_id, channel, status, placed_at, currency,
        gross_cents, discount_cents, shipping_charged_cents, tax_cents, refund_cents, net_cents, is_test,
        payment_fee_cents, marketplace_fee_cents, fulfillment_cost_cents, external_updated_at)
     values ($1, $2, $3, $4, $5, $6, 'USD', $7, $8, 0, 0, $9, $10, $11, $12, $13, $14, $6) returning id`,
    [
      org,
      conn,
      `T-${seq}`,
      channel,
      spec.status ?? 'closed',
      spec.placedAt,
      gross,
      discount,
      refund,
      gross - discount - refund,
      spec.isTest ?? false,
      spec.paymentFee ?? 0,
      spec.marketplaceFee ?? 0,
      spec.fulfillment ?? 0,
    ],
  );
  const orderId = rows[0]!.id;
  const lines = spec.lines ?? [{ quantity: 1, price: gross, cogs: Math.round(gross * 0.4) }];
  let n = 0;
  for (const l of lines) {
    n++;
    await owner.query(
      `insert into order_lines (org_id, order_id, sku_id, external_line_id, title, quantity, unit_price_cents, unit_cogs_cents_snapshot)
       values ($1, $2, $3, $4, 'Widget', $5, $6, $7)`,
      [org, orderId, l.skuId ?? SKU, `L${n}`, l.quantity, l.price, l.cogs],
    );
  }
  return orderId;
}

let campaignSeq = 0;
export async function addAdDay(
  owner: Pool,
  spec: {
    platform?: 'meta' | 'amazon_ads';
    date: string;
    spend: number;
    revenue?: number;
    impressions?: number;
    clicks?: number;
    conversions?: number;
    campaign?: string;
  },
): Promise<void> {
  const conn = (spec.platform ?? 'meta') === 'meta' ? META_CONN : AMZ_ADS_CONN;
  const ext = spec.campaign ?? `${spec.platform ?? 'meta'}-default`;
  const { rows } = await owner.query<{ id: string }>(
    `insert into ad_campaigns (org_id, ad_connection_id, external_id, name) values ($1, $2, $3, $3)
     on conflict (org_id, ad_connection_id, external_id) do update set name = excluded.name returning id`,
    [ORG, conn, ext],
  );
  campaignSeq++;
  await owner.query(
    `insert into ad_insights_daily (org_id, campaign_id, date, spend_cents, impressions, clicks, conversions, revenue_cents)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      ORG,
      rows[0]!.id,
      spec.date,
      spec.spend,
      spec.impressions ?? spec.spend * 10,
      spec.clicks ?? 10,
      spec.conversions ?? 1,
      spec.revenue ?? 0,
    ],
  );
}
