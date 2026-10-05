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
      `insert into store_connections (org_id, platform, external_account_id, status)
       values ($1, 'shopify', 'shop-' || ($1::uuid)::text, 'demo')`,
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
};
