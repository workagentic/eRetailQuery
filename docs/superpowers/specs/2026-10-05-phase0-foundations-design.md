# eRetailQuery Phase 0: Foundations — Design Spec

Date: 2026-10-05
Status: Draft, awaiting owner review
Source of truth for product rules: `CLAUDE.md` (this spec does not override it).

## 1. Purpose and scope

Phase 0 delivers the platform every later phase builds on: a working monorepo, CI, authentication, multi-tenant organizations with roles, a base schema protected by Row Level Security, and a seed script. It proves tenant isolation with an automated test before any feature exists.

Success criteria:
1. `pnpm dev` runs web, api and worker locally against Docker Postgres and Redis.
2. A user can sign up (email or Google), create an org, invite a member, and call an authenticated API endpoint scoped to that org.
3. The isolation test fails CI if any `org_id` table lacks a working RLS policy.
4. `pnpm db:migrate && pnpm db:seed` produces a demo org with 200 SKUs and cost components.
5. All scripts from CLAUDE.md §10 exist and pass in CI.

Out of scope for Phase 0: real connectors (Shopify, Meta, etc.), Stripe, order/ad/inventory/customer tables, the metrics functions (Phase 1a), the marketing site, Sentry dashboards, and the role-based hiding of cost data (built with the cost endpoints in Phase 1).

Platform developer-app applications (Shopify, Amazon, Meta, Google Ads, TikTok) are submitted during this phase per CLAUDE.md §12. They are an owner task, tracked outside this spec.

## 2. Decisions made while brainstorming

| Decision | Choice | Why |
|---|---|---|
| Decomposition | Phase 0 is its own spec; Phase 1 splits into 1a metrics, 1b Shopify + CSV, 1c Meta/Google, 1d dashboard/P&L/Stripe | CLAUDE.md spans five phases; too large for one spec |
| Auth | Supabase Auth (email + Google) | Least code owned, matches hosting |
| Schema scope | Identity, connections, catalog core | Enough to start Phase 1 without locking in orders/ads design before connectors shape it |
| Tenant isolation | Session variable `app.org_id` set per transaction, non-superuser role | Same mechanism for API and workers; matches CLAUDE.md §5 |
| ORM | Drizzle (CLAUDE.md default) | No blocker found |

## 3. Repo structure

```
eretailquery/
  apps/
    web/        Next.js App Router, Tailwind, shadcn/ui, TanStack Query
    api/        NestJS, REST + OpenAPI, zod validation pipe
    worker/     BullMQ bootstrap + one health-check job
  packages/
    db/         Drizzle schema, SQL migrations, RLS policies, seed, withTenant
    shared/     zod schemas, money utils, crypto helper, constants
    metrics/    empty package with test setup (filled in Phase 1a)
    ui/         shadcn base components, theme tokens
    connectors/ interfaces from CLAUDE.md §6 only
  docs/
  .github/workflows/ci.yml
```

Tooling: pnpm workspaces, Turborepo, TypeScript strict (no `any` without a comment), ESLint + Prettier, Vitest (unit), Testcontainers (integration), Playwright (one smoke e2e).

Scripts (root): `dev`, `db:migrate`, `db:seed`, `test`, `test:e2e`, `lint`, `typecheck`.

CI (GitHub Actions) on every PR: install, lint, typecheck, unit tests, integration tests (Testcontainers), and a check that migrations apply cleanly to an empty database.

Local dev: Docker Compose provides Postgres and Redis. The Supabase CLI is optional. Tests verify JWTs against a stub keypair, so no live Supabase is needed.

## 4. Data model

Conventions: snake_case; every tenant table has `id uuid`, `org_id uuid`, `created_at`, `updated_at` (`orgs` keys on its own `id`). Money is `*_cents bigint` plus an ISO `currency` column. No floats for money.

Tables:
- Identity: `orgs`, `org_members` (role: owner, admin, analyst, viewer), `invites`, `subscriptions` (Stripe ids, plan, status; populated in Phase 1d).
- Audit: `audit_log` (actor, action, entity type/id, before/after JSON). Append-only: no update or delete grant for `app_user`.
- Connections: `store_connections`, `ad_connections` (platform, external_account_id, status, `encrypted_credentials`, scopes, `last_synced_at`, `last_error`), `sync_runs`.
- Catalog: `products`, `skus`, `sku_cost_components` (component_type enum per CLAUDE.md §5; time-versioned via `effective_from`/`effective_to`).

Indexes: `(org_id, sku_id)` on cost components, `(org_id, created_at)` on audit_log and sync_runs, unique `(org_id, sku_code)` on skus.

Migrations are SQL files generated and applied through Drizzle. The schema is never edited by hand.

## 5. Tenant isolation (RLS)

- A migration creates role `app_user` without `BYPASSRLS` that owns none of the tables. The API and worker connect as `app_user`. Migrations and seed use a separate owner role.
- Every tenant table: `ENABLE` and `FORCE ROW LEVEL SECURITY`, with a policy `USING / WITH CHECK (org_id = current_setting('app.org_id', true)::uuid)`. If the setting is unset, no rows are visible. On `orgs` the policy compares `id` instead of `org_id`.
- `packages/db` exports `withTenant(orgId, fn)`: opens a transaction, runs `set_config('app.org_id', orgId, true)`, and runs `fn` with the transaction handle. The unscoped client is exported only from a `migrations/seed` entry point and is lint-restricted in app code.
- Pre-org lookups ("which orgs is this user in", invite acceptance) use narrow `SECURITY DEFINER` functions that return only the caller's own memberships.

Isolation test (integration, Testcontainers): introspects every public table with an `org_id` column. For each, inserts a row as tenant A, then asserts tenant B cannot select, update or delete it and cannot insert with A's `org_id`. A new tenant table without a working policy fails this test. A second test asserts a query with no `app.org_id` set returns zero rows.

## 6. Authentication and authorization

- Supabase Auth issues JWTs for email and Google sign-in.
- NestJS guard: verify the JWT, resolve the user, read the active org from the `X-Org-Id` header, confirm membership, attach role, then run the request inside `withTenant`.
- Roles are enforced with a `@Roles(...)` decorator and guard. Owners and admins manage members; analysts and viewers are read-oriented. Finer permissions arrive with the features that need them.
- Endpoints in Phase 0: `POST /orgs`, `GET /me` (user and orgs), `GET/POST /orgs/:id/invites`, `POST /invites/:token/accept`, `GET /orgs/:id/members`, `GET /health`. Responses use the error shape `{ error: { code, message, details } }`. Inputs are validated with zod schemas from `packages/shared`.
- Web: sign-in/up pages, org creation, org switcher, an empty app shell with a placeholder dashboard, and an invite accept page. Loading skeletons and empty states from CLAUDE.md §8 apply even to these screens.

## 7. Security utilities

- `packages/shared/crypto`: AES-256-GCM encrypt/decrypt behind a `KeyProvider` interface. Dev provider reads a key from env; the KMS provider is added before production. Ciphertext format includes key id and version for rotation.
- pino logger with a redaction list (tokens, credentials, authorization headers).
- `.env.example` lists every variable. No secrets in the repo.
- Audit log writes for org creation, member and invite changes.

## 8. Seed script

`pnpm db:seed` is idempotent and creates: one demo org, three members (one per role tier), three store connections in `demo` status (no credentials), and 200 SKUs across products with time-versioned landed cost components. The seed grows with later phases (orders, ad insights, 12 months of history) and is reused for public demo mode.

## 9. Testing

- Unit: money utils, crypto helper, guards, zod schemas.
- Integration: isolation test, `withTenant`, auth guard with stub keypair, invite flow, seed idempotency.
- E2E (Playwright): sign up, create org, see dashboard shell.
- Definition of done per CLAUDE.md §10 applies, including docs in `docs/`.

## 10. Risks and open items

- Supabase JWT verification details (JWKS vs shared secret) must be checked against current Supabase docs when implementing; note the link in a code comment.
- Org-creation bootstrapping runs before `app.org_id` exists. It is handled by a `SECURITY DEFINER` function that creates the org and the owner membership atomically.
- Hosting region and budget are still unconfirmed (CLAUDE.md §14.6). They do not block Phase 0.
- This directory is not yet a git repository. `git init` is needed before the first commit; the spec is not committed yet.
