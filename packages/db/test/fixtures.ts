export interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}
export type Fixture = (q: Queryable, orgId: string) => Promise<unknown>;

/**
 * One entry per tenant table, parents before children. Each inserts a minimal valid row for orgId.
 * Child fixtures reuse orgId as the parent row's id. The isolation suite fails if a table has no entry.
 */
export const fixtures: Record<string, Fixture> = {
  orgs: (q, id) =>
    q.query(`insert into orgs (id, name, slug) values ($1, $2, $3)`, [
      id,
      `Org ${id}`,
      `org-${id}`,
    ]),
  org_members: (q, org) =>
    q.query(
      `insert into org_members (org_id, user_id, role) values ($1, gen_random_uuid(), 'owner')`,
      [org],
    ),
  invites: (q, org) =>
    q.query(
      `insert into invites (org_id, email, role, token_hash, expires_at)
       values ($1, 'a@b.co', 'viewer', gen_random_uuid()::text, now() + interval '1 day')`,
      [org],
    ),
  subscriptions: (q, org) => q.query(`insert into subscriptions (org_id) values ($1)`, [org]),
  audit_log: (q, org) =>
    q.query(`insert into audit_log (org_id, action, entity_type) values ($1, 'test', 'org')`, [
      org,
    ]),
  store_connections: (q, org) =>
    q.query(
      `insert into store_connections (id, org_id, platform, external_account_id, status)
       values ($1, $1, 'shopify', 'shop-' || ($1::uuid)::text, 'demo')`,
      [org],
    ),
  ad_connections: (q, org) =>
    q.query(
      `insert into ad_connections (org_id, platform, external_account_id, status)
       values ($1, 'meta', 'act-' || ($1::uuid)::text, 'demo')`,
      [org],
    ),
  sync_runs: (q, org) =>
    q.query(
      `insert into sync_runs (org_id, connection_kind, connection_id, type, status)
       values ($1, 'store', gen_random_uuid(), 'backfill', 'running')`,
      [org],
    ),
  products: (q, org) =>
    q.query(`insert into products (id, org_id, title) values ($1, $1, 'Widget')`, [org]),
  skus: (q, org) =>
    q.query(
      `insert into skus (id, org_id, product_id, sku_code, selling_price_cents)
       values ($1, $1, $1, 'SKU-1', 2999)`,
      [org],
    ),
  sku_cost_components: (q, org) =>
    q.query(
      `insert into sku_cost_components (org_id, sku_id, component_type, amount_cents, effective_from)
       values ($1, $1, 'product_cost', 1000, '2025-01-01')`,
      [org],
    ),
  locations: (q, org) =>
    q.query(
      `insert into locations (id, org_id, store_connection_id, external_id, name, type, source)
       values ($1, $1, $1, 'loc-' || ($1::uuid)::text, 'Main warehouse', 'warehouse', 'shopify')`,
      [org],
    ),
  inventory_levels: (q, org) =>
    q.query(
      `insert into inventory_levels (org_id, sku_id, location_id, on_hand) values ($1, $1, $1, 5)`,
      [org],
    ),
  inventory_movements: (q, org) =>
    q.query(
      `insert into inventory_movements (org_id, sku_id, location_id, delta, reason) values ($1, $1, $1, 5, 'adjustment')`,
      [org],
    ),
  sku_channel_listings: (q, org) =>
    q.query(
      `insert into sku_channel_listings (org_id, sku_id, store_connection_id, external_product_id, external_variant_id)
       values ($1, $1, $1, 'p-1', 'v-1')`,
      [org],
    ),
  orders: (q, org) =>
    q.query(
      `insert into orders (id, org_id, store_connection_id, external_order_id, channel, status, placed_at, currency,
                           gross_cents, discount_cents, shipping_charged_cents, tax_cents, refund_cents, net_cents, external_updated_at)
       values ($1, $1, $1, 'o-' || ($1::uuid)::text, 'shopify_online', 'open', now(), 'USD', 1000, 0, 0, 0, 0, 1000, now())`,
      [org],
    ),
  order_lines: (q, org) =>
    q.query(
      `insert into order_lines (id, org_id, order_id, sku_id, external_line_id, title, quantity, unit_price_cents)
       values ($1, $1, $1, $1, 'line-1', 'Widget', 1, 1000)`,
      [org],
    ),
  refunds: (q, org) =>
    q.query(
      `insert into refunds (id, org_id, order_id, external_refund_id, refunded_at, amount_cents) values ($1, $1, $1, 'r-1', now(), 100)`,
      [org],
    ),
  refund_lines: (q, org) =>
    q.query(
      `insert into refund_lines (org_id, refund_id, order_line_id, quantity, amount_cents) values ($1, $1, $1, 1, 100)`,
      [org],
    ),
  sync_cursors: (q, org) =>
    q.query(
      `insert into sync_cursors (org_id, store_connection_id, resource, status) values ($1, $1, 'orders', 'idle')`,
      [org],
    ),
  oauth_states: (q, org) =>
    q.query(
      `insert into oauth_states (org_id, user_id, platform, shop, nonce_hash, expires_at)
       values ($1, gen_random_uuid(), 'shopify', 'fixture.myshopify.com', 'hash-' || ($1::uuid)::text, now() + interval '10 minutes')`,
      [org],
    ),
  webhook_events: (q, org) =>
    q.query(
      `insert into webhook_events (org_id, store_connection_id, topic, external_event_id, payload)
       values ($1, $1, 'orders/updated', 'evt-' || ($1::uuid)::text, '{}')`,
      [org],
    ),
};
