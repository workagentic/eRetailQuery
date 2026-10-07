# Tenancy and isolation

Every tenant-owned table carries `org_id` and is protected by Postgres Row Level Security. API-level org checks are a second layer, not the first.

## Roles

- `erq_owner` owns all objects and runs migrations and the seed.
- `app_user` (NOSUPERUSER, NOBYPASSRLS) serves API and worker traffic. It gets only SELECT/INSERT/UPDATE/DELETE through default privileges.
- Tenant tables use `FORCE ROW LEVEL SECURITY`, so policies apply even to the table owner.

## `withTenant`

`withTenant(orgId, fn)` (`packages/db/src/tenant-db.ts`) opens a transaction and runs `select set_config('app.org_id', $1, true)`. The `true` makes the setting transaction-local, so a pooled connection never carries one tenant's id into another request. The org id must be a UUID or the call throws before touching the database.

Policies compare `org_id` against `nullif(current_setting('app.org_id', true), '')::uuid`. After a transaction ends the setting reverts to the empty string, not NULL, and casting `''` to uuid would raise an error; `nullif` turns it into NULL so the policy simply matches no rows.

## Composite foreign keys

Child tables reference parents with `(org_id, id)` foreign keys (for example `skus` to `products`, `sku_cost_components` to `skus`). A row can therefore never point at another tenant's parent, even if application code passes a wrong id. Each parent has a unique `(org_id, id)` constraint to support this.

## SECURITY DEFINER functions

Some operations happen before an org context exists. Migration `0005_account_functions.sql` defines three functions that run with the owner's rights, have `search_path` pinned to `pg_catalog, public, pg_temp` (migration `0006_security_hardening.sql`), and have EXECUTE revoked from PUBLIC and granted to `app_user`:

- `app_list_user_orgs(user_id)`: the orgs a user belongs to.
- `app_create_org(user_id, name, slug)`: creates the org, owner membership, subscription and an audit row.
- `app_accept_invite(user_id, email, token_hash)`: validates and consumes an invite.

Trust model: the functions trust their arguments. `app_create_org` and `app_list_user_orgs` accept any user id, so the API must pass only the `sub` of a verified JWT, never a client-supplied id. `app_accept_invite` receives the email from the JWT `email` claim and compares it case-insensitively to the invite email. That makes **Supabase email confirmation mandatory in production**: with confirmation off, anyone could sign up with someone else's address and accept their invite. Local e2e disables confirmation in `supabase/config.toml` for convenience only.

`pg_temp` must be last in the pinned `search_path`: when it is implicit or first, a session can create a temp table such as `invites` that shadows the real table inside a SECURITY DEFINER function. Migration 0006 also revokes EXECUTE on the two helper functions (`app_secure_tenant_table`, `app_set_updated_at`) from PUBLIC, and revokes all table and function privileges in `public` from the Supabase roles `anon` and `authenticated` (including their default privileges), since `REVOKE ... FROM PUBLIC` does not remove explicit grants.

Migration `0011_sync_orders_rls.sql` adds a fourth, `app_list_stalled_sync_cursors(older_than)`. It is the only intentional cross-tenant read: it lists `running` sync cursors across all orgs that have not moved since the threshold, so the worker's stalled-run resumer (which has no org context) can re-enqueue them. It returns only ids. It must never be exposed through an API route.

Phase 1b-2 adds four more (migrations 0014 to 0016), and 1b-3a adds `app_purge_shop` (0017, locking in 0018), all with the pinned `search_path`, EXECUTE revoked from PUBLIC, `anon` and `authenticated`, and granted only to `app_user`:

- `app_consume_oauth_state(nonce_hash)`: single-use consume of an OAuth state. Caller: the authenticated OAuth callback endpoint only (`POST /connections/shopify/callback`); no public callback route remains.
- `app_find_store_connection(platform, external_account_id)`: returns org id, connection id and status. Callers: the authenticated OAuth callback endpoint and the Shopify webhook receiver only.
- `app_list_stale_webhook_events(older_than, limit)`: cross-tenant read of ids of stale `received` and `processing` webhook events. Caller: the worker sweep only.
- `app_purge_store_connection(org_id, connection_id)`: deletes one connection's data including ledger rows. Caller: `app_purge_shop` only.
- `app_purge_shop(platform, external_account_id)`: purges every `disconnected` or `error` connection of that platform and shop across all orgs (rows locked `FOR UPDATE`, one audit row per org), by calling `app_purge_store_connection` for each. Never touches `active`, `pending` or `demo` connections. Caller: the worker's `shop/redact` handler only. `app_purge_store_connection` filters `oauth_states` by platform as well as shop.

None of these five may be exposed through a generic authenticated API route. The OAuth callback endpoint is authorized by the signed-in user plus Shopify's HMAC and the single-use state (the caller must be the user who started the install and a current owner or admin of the state's org); the webhook receiver is authorized by Shopify's HMAC. Neither trusts user input for the org.

The unique index `store_connections_active_shop_uq` (migration 0020) is cross-org by design: a shop can be non-disconnected in only one org at a time, whatever RLS lets each org see. Callers that hit it (the callback upsert) map the violation to `shop_in_use`.

The migration role must be a superuser or have BYPASSRLS, because these functions write across RLS-protected tables. Supabase's `postgres` role qualifies.

## Audit log

`audit_log` is append-only for `app_user`: UPDATE and DELETE are revoked, and tests assert it. Caveat: its `org_id` foreign key is `ON DELETE CASCADE`, so deleting an org (as the seed does, as `erq_owner`) also deletes that org's audit rows. `app_user` can no longer INSERT or DELETE `orgs` either (migration 0006): orgs are created only through the SECURITY DEFINER `app_create_org`, and deleted only by the owner role, so the audit log cannot be wiped through the cascade. Org deletion is therefore an owner-role operation outside normal traffic; if audit retention beyond org lifetime is required, change the FK before enabling org deletion in the product.

`inventory_movements` (migration 0009) is append-only for `app_user` too: UPDATE and DELETE are revoked, the table has no `updated_at`, and a partial unique index on its reference columns makes sync writes idempotent. Its foreign keys to `skus` and `locations` are `ON DELETE NO ACTION` (restrict), because referential cascades bypass RLS and the revoked grants and would otherwise let a SKU or location delete wipe the history. Since `locations` cascade from `store_connections`, a store connection that has movements cannot be deleted either: disconnecting a store must be a status change, not a row delete (movements and, later, orders reference it).

## Invite tokens

Only the SHA-256 hash of an invite token is stored (`invites.token_hash`). The raw token is shown once at creation and sent in the link. Acceptance is single use (`accepted_at`) and expiring (`expires_at`).

## Web redirect safety

`safeNextPath` (`apps/web/src/lib/safe-next.ts`) sanitises post-login `next` targets. It returns the fallback unless the value starts with a single `/`, does not start with `//`, and contains no backslash. It then resolves the value with the URL parser against a dummy origin and rejects anything whose origin changes (this catches tab/newline tricks such as `/\t/evil.com`). Finally it checks the normalised result: dot-segment collapsing can turn `/..//evil.com` into `//evil.com`, so the result must still start with a single slash followed by a non-slash, non-backslash character (or be exactly `/`).

## Adding a tenant table

1. Add the Drizzle schema with `org_id` (FK to `orgs`, cascade), `id` and timestamps. Use composite `(org_id, id)` FKs to parents, and a unique `(org_id, id)` if the table will itself be a parent.
2. `pnpm --filter @erq/db generate` to produce the migration.
3. Add a custom migration that calls `SELECT app_secure_tenant_table('<table>');` (enables and forces RLS, creates the policy, attaches the `updated_at` trigger; pass `'org_id', false` for tables without `updated_at`).
4. Add a fixture for the table in `packages/db/test/fixtures.ts`. The isolation suite (`isolation.test.ts`) fails for any tenant table without one, which is the safety net.
5. Run `pnpm test` and confirm tenant A cannot read or write tenant B's rows.
