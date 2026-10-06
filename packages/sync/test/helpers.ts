import { createTenantDb, type TenantDb } from '@erq/db';
import { startTestDatabase, type TestDatabase } from '@erq/db/testing';
import { Pool } from 'pg';

export const ORG_A = '11111111-1111-4111-8111-111111111111';
export const ORG_B = '22222222-2222-4222-8222-222222222222';
export const CONN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const CONN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export interface TestEnv {
  tdb: TestDatabase;
  owner: Pool;
  db: TenantDb;
  stop(): Promise<void>;
}

/** Fresh database with two orgs (A in New York time, B in UTC), one store connection each. */
export async function startEnv(): Promise<TestEnv> {
  const tdb = await startTestDatabase();
  const owner = new Pool({ connectionString: tdb.ownerUrl });
  await owner.query(
    `insert into orgs (id, name, slug, timezone) values ($1, 'Org A', 'org-a', 'America/New_York'), ($2, 'Org B', 'org-b', 'UTC')`,
    [ORG_A, ORG_B],
  );
  await owner.query(
    `insert into store_connections (id, org_id, platform, external_account_id, status)
     values ($1, $3, 'shopify', 'shop-a', 'active'), ($2, $4, 'shopify', 'shop-b', 'active')`,
    [CONN_A, CONN_B, ORG_A, ORG_B],
  );
  const db = createTenantDb(tdb.appUrl);
  return {
    tdb,
    owner,
    db,
    stop: async () => {
      await db.close();
      await owner.end();
      await tdb.stop();
    },
  };
}

export async function seedSku(
  owner: Pool,
  orgId: string,
  code: string,
  price = 2500,
): Promise<string> {
  const p = await owner.query(`insert into products (org_id, title) values ($1, $2) returning id`, [
    orgId,
    `Product ${code}`,
  ]);
  const s = await owner.query(
    `insert into skus (org_id, product_id, sku_code, selling_price_cents) values ($1, $2, $3, $4) returning id`,
    [orgId, p.rows[0].id, code, price],
  );
  return s.rows[0].id as string;
}

export async function seedCost(
  owner: Pool,
  orgId: string,
  skuId: string,
  cents: number,
  opts: {
    from?: string;
    to?: string | null;
    type?: string;
    perUnit?: boolean;
    currency?: string;
  } = {},
): Promise<void> {
  await owner.query(
    `insert into sku_cost_components (org_id, sku_id, component_type, amount_cents, per_unit, currency, effective_from, effective_to)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      orgId,
      skuId,
      opts.type ?? 'product_cost',
      cents,
      opts.perUnit ?? true,
      opts.currency ?? 'USD',
      opts.from ?? '2026-01-01',
      opts.to ?? null,
    ],
  );
}

export async function seedListing(
  owner: Pool,
  orgId: string,
  connectionId: string,
  skuId: string,
  variantId: string,
): Promise<void> {
  await owner.query(
    `insert into sku_channel_listings (org_id, sku_id, store_connection_id, external_product_id, external_variant_id)
     values ($1, $2, $3, $4, $5)`,
    [orgId, skuId, connectionId, `p-${variantId}`, variantId],
  );
}

export async function seedOrder(
  owner: Pool,
  o: {
    orgId: string;
    connectionId: string;
    externalId: string;
    placedAt: string;
    currency?: string;
    lines: { skuId: string | null; qty: number; price?: number; externalLineId?: string }[];
  },
): Promise<string> {
  const { rows } = await owner.query(
    `insert into orders (org_id, store_connection_id, external_order_id, channel, status, placed_at, currency, gross_cents, discount_cents,
       shipping_charged_cents, tax_cents, refund_cents, net_cents, external_updated_at)
     values ($1, $2, $3, 'shopify_online', 'closed', $4, $5, 0, 0, 0, 0, 0, 0, $4) returning id`,
    [o.orgId, o.connectionId, o.externalId, o.placedAt, o.currency ?? 'USD'],
  );
  const orderId = rows[0].id as string;
  for (const [i, l] of o.lines.entries()) {
    await owner.query(
      `insert into order_lines (org_id, order_id, sku_id, external_line_id, title, quantity, unit_price_cents)
       values ($1, $2, $3, $4, 'Line', $5, $6)`,
      [o.orgId, orderId, l.skuId, l.externalLineId ?? `l-${i + 1}`, l.qty, l.price ?? 1000],
    );
  }
  return orderId;
}
