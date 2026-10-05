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
};
