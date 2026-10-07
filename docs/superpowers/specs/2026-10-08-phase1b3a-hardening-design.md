# Phase 1b-3a: Shopify Connection Hardening (design)

Date: 2026-10-08
Status: draft for review
Builds on: `2026-10-06-phase1b2-shopify-connection-design.md` (merged) and its final review. Follows CLAUDE.md sections 6.3, 9 and 16.

## 1. Purpose and scope

Phase 1b-3 (the Shopify sync) is split into three sub-projects, decided with the owner on 2026-10-08:

- **1b-3a Hardening (this spec):** the hard gates the 1b-2 review left open.
- 1b-3b Shopify connector: locations, products with costs, inventory, orders (POS as its own channel), `read_all_orders` handling with a 60-day fallback, the first real backfill.
- 1b-3c Live updates: scheduler for incremental syncs, webhook nudges, order-line link-up pass, token refresh, sync status and freshness in the UI.

1b-3a closes four items before any real merchant connects or any order is ingested:

1. **OAuth browser binding (gate I4):** the callback must prove the person completing the OAuth flow is the user who started it, and is still an owner or admin of that org.
2. **Cross-org `shop/redact` (gate I6):** the purge must cover every non-active connection of a shop, in every org.
3. **No webhook payloads kept:** the receiver must not persist webhook bodies, so no customer data is retained (the privacy item from the review).
4. **One org per shop, enforced by the database:** replace the check-then-act in the callback with a partial unique index.

Plus three small carry-overs (section 6).

Out of scope: the connector and any data fetching (1b-3b), scheduling, nudges, token refresh, link-up (1b-3c), sweeping webhook events that exhausted their retries, a separate worker database role.

## 2. OAuth browser binding (I4)

### 2.1 Problem
The state row binds org, user and shop but not the browser that completes the callback. An admin of org X can mint an authorize URL for `victim.myshopify.com` and have the victim's shop admin complete it; the public API callback would connect the victim's shop to org X.

### 2.2 Design
- Shopify's redirect URL becomes the **web** app: `${WEB_PUBLIC_URL}/connections/shopify/callback`. `ShopifyConfig.redirectUri` is built from `WEB_PUBLIC_URL`; `API_PUBLIC_URL` is still used for the webhook URL.
- New Next route handler `GET /connections/shopify/callback` (in `apps/web`, under the existing auth middleware, which already redirects signed-out users to `/login?next=<path+query>` so the Shopify query string survives sign-in). With a session it forwards the **raw query string** and the user's access token to the API and redirects the browser to the URL the API returns.
- New authenticated API endpoint `POST /connections/shopify/callback` (`AuthGuard` only, no org header, body `{ query: string }`, the raw encoded query string). It runs the existing completion steps (signature check, state consume, shop match, `shop_in_use`, token exchange, encrypted store, audit, webhook registration), plus two new checks right after the state is consumed:
  - `jwt.sub === state.userId`, else error `wrong_account`;
  - the user is currently an owner or admin of `state.orgId` (read through `withTenant`), else error `not_allowed`.
  The state is burned in both failure cases. It returns `{ redirectTo }`, the web connections URL with the same fixed result codes as today plus `wrong_account` and `not_allowed`.
- The public API route `GET /connections/shopify/callback` is **deleted**. `ShopifyPublicController` keeps only the webhook receiver.
- **Raw-query signature:** `verifyOAuthQuery` gains a variant that takes the raw query string, splits it into encoded `key=value` pairs, removes `hmac`, sorts and joins them, and compares the HMAC (constant time, as now), plus the same timestamp window. Repeated keys are rejected. The old object form is removed so there is only one verification path. The web route forwards the string untouched (`request.nextUrl.search` without the leading `?`).
- The SSRF/redirect rules stay: the API builds the redirect from `WEB_PUBLIC_URL` only; the web route redirects only to the URL returned by its own API call after checking it starts with `WEB_PUBLIC_URL`.
- Error codes shown on the Connections page gain plain English for `wrong_account` ("This connection was started from a different account. Sign in with the account that started it, or start again.") and `not_allowed` ("Only an owner or admin can connect a store."). `SHOPIFY_ERROR_CODES` grows accordingly.
- Setup change: the Shopify app's allowed redirect URL is the web callback. `docs/shopify-connection.md` and `.env.example` say so.

### 2.3 Edge cases
A signed-out user is sent through login and lands back on the callback with the query intact (the state's 10-minute life still applies). A user who belongs to several orgs is not confused: org comes from the state, never from the session's active org. A reinstall by the same admin works unchanged.

## 3. Cross-org `shop/redact` (I6)

- New migration with `app_purge_shop(p_platform store_platform, p_external_account_id text)` (SECURITY DEFINER, `search_path = pg_catalog, public, pg_temp`, PUBLIC/anon/authenticated revoked, `app_user` only, worker-only). It loops over every `store_connections` row for that platform and account whose status is `disconnected` or `error` (never `active`, `pending` or `demo`), and calls `app_purge_store_connection` for each, which already writes one audit row per org. An active connection (a reinstall inside Shopify's 48-hour window) is never touched.
- The worker's `shop/redact` handler resolves the shop from the event's connection and calls `app_purge_shop`. The event row may be removed by the cascade, as today.
- `app_purge_store_connection` now filters its `oauth_states` delete by platform as well as shop.
- A partial index on `webhook_events (status, updated_at)` for the stale-processing branch of the sweep.

## 4. No webhook payloads kept

- `receiveWebhook` verifies the signature and parses the headers as today, but stores `payload = '{}'` for every topic. The body is parsed only to reject non-JSON; it is not retained. Dedupe, queueing and statuses are unchanged. (The `payload` column stays `NOT NULL jsonb` for future needs.)
- A one-off migration sets `payload = '{}'` on every existing row.
- The worker's `deferred` scrub stays as a harmless second layer. `docs/shopify-connection.md` section 7 ("no customer PII is stored") becomes true and says why.

## 5. One org per shop in the database

- Migration: `CREATE UNIQUE INDEX store_connections_active_shop_uq ON store_connections (platform, external_account_id) WHERE status NOT IN ('disconnected', 'demo')`. The migration first aborts with a clear message if duplicate active rows already exist.
- The callback's upsert maps a unique violation on that index to the existing `shop_in_use` result. The pre-check stays as the fast path.
- The index is cross-org by design, so the migration owner role creates it (RLS does not apply to index enforcement).

## 6. Carry-overs
- Test helper pid guard (`packages/db/src/testing.ts`): compare the postmaster's exact creation time, not only "created after start".
- The webhook route's malformed-JSON 400 returns a fixed message instead of body-parser's parse text.
- Docs: a note that other packages load `@erq/db/testing` from `dist`, so rebuild `@erq/db` (`pnpm turbo run build --filter=@erq/db`) before running their tests directly.

## 7. Errors and security notes
- Every failure on the new callback ends on the Connections page with a fixed message; no query text is echoed.
- The API endpoint never logs the query string; the access token is sent only server-to-server by the web route handler.
- The definer functions follow the existing rules; `app_purge_shop` must never be reachable from an authenticated route.
- Anything stored as an error passes through `sanitizeMessage`.

## 8. Testing
- API: full authenticated callback against FakeShopify; wrong user, user no longer admin, viewer/analyst, signed-out (401), tampered/stale/replayed state, repeated query keys, encoded-value signature case (`host` with `=` padding), `shop_in_use` incl. a concurrent double connect (unique index), and that the old public route is gone (404).
- Web: pure helper unit tests for query forwarding and the redirect validation; Playwright path written, CI only.
- DB: the same shop connected in two orgs with different statuses; `app_purge_shop` removes only non-active ones, one audit row per org, leaves an active reinstall alone; index behaviour; payload scrub migration; grants and hygiene query; isolation suite unchanged.
- Worker: `shop/redact` uses the new function; receiver stores `{}`.
- Acceptance: lint, typecheck and tests green per package, no leftover postgres processes or temp directories.

## 9. Documentation
`docs/shopify-connection.md` (setup, flow diagram, the removed gates), `docs/architecture/tenancy.md` (new definer function, removed public route), CLAUDE.md section 16 (remove the three gates, update "Known open items") and the Decisions Log.

## 10. Success criteria
1. A connect attempt completed by a different account than the one that started it is rejected and connects nothing.
2. `shop/redact` removes the data of every non-active connection of the shop across orgs and leaves an active reinstall alone.
3. No webhook body is persisted; existing stored payloads are emptied.
4. Two orgs cannot both hold an active connection to one shop, even concurrently.
5. All tests, typecheck, lint and builds pass; the three gates are gone from the docs.
