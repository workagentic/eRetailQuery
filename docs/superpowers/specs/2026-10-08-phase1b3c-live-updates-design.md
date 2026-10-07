# Phase 1b-3c: Live Updates (design)

Date: 2026-10-08
Status: draft for review
Builds on: `2026-10-06-phase1b1-sync-foundations-design.md`, `2026-10-06-phase1b2-shopify-connection-design.md`, `2026-10-08-phase1b3a-hardening-design.md`, `2026-10-09-phase1b3b-shopify-connector-design.md` (all merged locally). Follows CLAUDE.md sections 2 (principles 5 and 6), 6.3, 9 and 16.

## 1. Purpose and scope

Phase 1b-3 split: 1b-3a hardening (done), 1b-3b Shopify connector (done), **1b-3c live updates (this spec)**.

After 1b-3b a connected shop imports once and then goes stale until someone presses Sync now. 1b-3c keeps a connected shop fresh without anyone pressing anything, and makes that honest on screen: the owner sees current orders, products and stock, and a per-resource "last synced" time they can trust (principle 5).

Decisions made with the owner on 2026-10-08:
- **Scheduled polling plus webhook nudges.** Polling is the safety net; a webhook only starts a sync earlier. A missed webhook costs a delay, never wrong data.
- **Tiered cadence:** locations, products and orders incremental every 15 minutes; inventory a full pass every hour; products a full pass daily (catches cost-only edits that do not bump `updated_at`).
- **Webhook topics: non-customer topics only.** Subscribe to `products/update` and `inventory_levels/update` (plus the existing `app/uninstalled`). Order, refund and customer topics are NOT subscribed because Shopify requires protected customer data approval, which we have not requested. Orders therefore stay polling-only (15 minutes) until the approval exists.
- **Scheduler = one ticker plus a due query** (a repeatable worker job every minute, a new SECURITY DEFINER function, the existing `enqueueSync`), not per-connection BullMQ schedules and not a `next_due_at` column.
- **Also in scope:** expiring offline tokens with refresh, the order-line link-up pass, per-resource sync status, and retry plus alert for failed non-privacy webhook events.

Shopify facts checked against the official docs on 2026-10-08 (https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens and `.../implement-token-exchange`): non-expiring offline tokens are no longer available to new public apps for GraphQL Admin API requests, and existing public apps lose them after 1 January 2027. An expiring offline token is requested with `expiring=1` on the code exchange; the access token lives 1 hour (`expires_in` 3600) and the refresh token 90 days (`refresh_token_expires_in` 7776000). Refresh is `POST https://{shop}/admin/oauth/access_token` with `client_id`, `client_secret`, `grant_type=refresh_token`, `refresh_token`; every refresh returns a NEW access token and a NEW refresh token (rotation). A refresh failure of `401 {"error":"invalid_request"}` covers every terminal cause (unknown, already replaced, expired, revoked, uninstalled) and is final; only network errors, timeouts, 5xx and 429 are retried, with the same refresh token. These shapes are unverified against a real shop and join the first-install checklist.

**Consequence:** the 1b-2 install exchange does not request expiring tokens and would likely fail on a real install. Changing it is part of this sub-project.

Out of scope: customers, UTM and landing site; order, refund and customer webhook topics; the CSV import and the manual and CSV cost-entry paths (separate Phase 1b work); Meta and Google (1c); dashboard, P&L and billing (1d); bulk operations; any live Shopify or Redis call in tests; per-org cadence settings.

## 2. Token lifecycle

### 2.1 Credentials
The encrypted credentials blob (AAD `connection:<id>`) changes from `{ accessToken }` to `{ accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt }` (ISO strings). The reader accepts the old shape (no expiry fields) as a non-expiring token so existing demo and test connections keep working; a non-expiring token is never refreshed. Credentials never travel in jobs, logs, DTOs or audit rows.

### 2.2 Install
`exchangeCodeForToken` sends `expiring=1` and returns the access token, refresh token, both lifetimes and the granted scopes. `completeInstall` stores the full set (same upsert, same encryption). Scopes stay the GRANTED scopes from the token response.

### 2.3 Refresh
- `refreshAccessToken(http, { shop, apiKey, apiSecret, refreshToken })` in `packages/connectors/src/shopify/token.ts`, same error mapping style as the exchange (final `401` becomes `AuthError('Shopify no longer accepts this connection. Reconnect the store.')`; 5xx/network/timeout `TransientError`; 429 `RateLimitedError`; unreadable body `PermanentError`).
- The connector never touches the database, so refresh is driven from the engine side: before each page job the sync engine (`packages/sync`) asks a `TokenService` port to ensure a fresh token. If the access token expires within 5 minutes (injected `now`), the service refreshes under a per-connection row lock (`SELECT ... FOR UPDATE` on the `store_connections` row inside `withTenant`), re-reading the credentials after taking the lock so two jobs never refresh the same refresh token (a rotated token cannot be reused). The new pair is encrypted and written in the same transaction; only then is the lock released.
- A final refresh failure marks the connection `error` with the fixed text "Shopify no longer accepts this connection. Reconnect the store." (through `sanitizeMessage`), fails the run with `AuthError`, and sends no further jobs until the merchant reconnects. Transient failures retry through the normal job retry path with the same refresh token.
- The connector and the GraphQL client keep receiving a plain `{ accessToken }` for the request; refresh logic lives in one place.
- **Idle shops:** the scheduler (section 3) also selects connections whose refresh token expires within 14 days and whose access token is expired or about to be, and runs a refresh-only job for them so a shop with no activity does not lose its refresh token to the 90-day limit.

## 3. Scheduler

### 3.1 Cadence constants (`@erq/sync`)
`SYNC_CADENCE_MS`: locations 15 min, products 15 min, orders 15 min (incremental); inventory 60 min (full pass); `PRODUCTS_FULL_PASS_MS` 24 h. Constants, not settings. `MAX_CONNECTIONS_PER_TICK` 50.

### 3.2 Due query
New migration with `app_list_due_sync_resources(p_now timestamptz)`, SECURITY DEFINER, `search_path = pg_catalog, public, pg_temp`, REVOKE from PUBLIC/anon/authenticated, GRANT to `app_user` only (same hardening as `app_list_stalled_sync_cursors`; worker-only, never exposed through an API route). It returns, per `active` Shopify connection with credentials, the org id, connection id and each resource that is due: its cursor's last completed time (`last_synced_at` on the cursor) is older than the cadence or null after a completed first backfill, and NO cursor of that connection is `running`. Connections that have never completed their first backfill are skipped (the first backfill is started by connect or Sync now). Disconnected, pending, demo and `error` connections are skipped. The cadence arithmetic is also a pure function in `@erq/sync` (`dueResources(cursors, now)`), and the SQL function only does the cheap pre-filter so the logic is unit-testable without a database; the SQL result is re-checked by the pure function.

### 3.3 Ticker
A repeatable BullMQ job (every 60 s, `jobId` fixed so restarts do not multiply it) in the worker. Each tick: call the function, take at most `MAX_CONNECTIONS_PER_TICK` connections oldest-due first, and `enqueueSync(deps, { orgId, connectionId, resources, mode: 'incremental', since })` per connection in order locations, products, inventory, orders (`mode: 'full'` for the inventory hourly pass and the daily products pass). The cursor lock makes a duplicate tick harmless. An enqueue failure for one connection is logged (sanitized) and does not stop the tick; `enqueueSync` already frees the cursor if the queue throws.

## 4. Webhook nudges

- Subscribe on connect and reconnect to `app/uninstalled`, `products/update` and `inventory_levels/update` (extending `SHOPIFY_WEBHOOK_TOPICS`; existing connections get the new topics through a re-register helper run by the ticker for connections missing them, bounded per tick). Order, refund and customer topics are not subscribed.
- The receiver is unchanged: verify the HMAC over the raw body, dedupe, store with payload `{}`. The worker maps `products/update` to the products resource and `inventory_levels/update` to inventory, then enqueues an incremental (inventory: full) sync for that connection and resource. Debounce through a job id bucketed per connection, resource and minute so a burst becomes one sync. If any cursor of the connection is running the nudge is dropped (polling covers it).
- A nudge never carries data; the sync always re-reads from Shopify. Event status after a nudge is `processed`.
- If Shopify rejects a subscription (for example a topic gated behind approval), the registration records the failure in the existing webhook-failure `last_error` path and the connection keeps polling.

## 5. Order-line link-up pass

Order lines whose variant was not yet imported are stored with no SKU link (and no unit cost snapshot). After a products sync completes, a link-up step for the connection finds lines with a null SKU whose `external_variant_id` now matches a channel listing, sets the SKU and fills the unit cost snapshot using the cost effective on the order date (the existing snapshot rule, org timezone). It is idempotent, set-based (bounded batch per run, repeats until none), tenant-scoped through `withTenant`, never overwrites an existing link or snapshot, and runs as part of the products chain end. Lines still unmatched stay unlinked and are counted for the status page.

## 6. Per-resource sync status

`ConnectionSyncDto` gains `resources: { resource, state, lastCompletedAt, error }[]` (locations, products, inventory, orders; `state` one of `never | running | failed | idle`), computed from the cursors in the same bounded set of queries as today. The existing aggregate `state`, `resource`, `canStart`, `coveredFrom` and `historyLimited` stay for compatibility. `store_connections.last_synced_at` becomes the oldest `lastCompletedAt` among the four resources, only when all four have completed, so single-resource nudges and runs no longer claim the whole connection is fresh. The web `describeSync` shows each resource's own line ("Orders: last import 6 minutes ago", "Stock: failed, <reason>") and the headline never claims more than the oldest resource. Wording stays plain English with tooltips; a failed or stale resource is named.

## 7. Failed webhook events

Failed events of non-privacy topics (`app/uninstalled`, `products/update`, `inventory_levels/update`) are re-listed by the sweep after their last attempt is older than 10 minutes, at most 5 sweep retries per event (a counter column on `webhook_events`, new migration). After the retries are exhausted the event stays `failed` and an `alerts` row is written (the CLAUDE.md `alerts` table: type `webhook_failed`, severity by topic: `app/uninstalled` high, others medium; entity ref the connection; sanitized message). The Connections page shows an open alert on the affected connection with what to do ("Shopify could not tell us the shop uninstalled. Reconnect if you removed the app."). Privacy topics keep their existing unlimited retry (migration 0021). `app/uninstalled` is also reconciled by the token refresh: a final refresh `401` already marks the connection `error`.

## 8. Testing

Everything runs against fakes and the embedded Postgres; Redis/BullMQ stay skipped without Docker and are reported unverified, as are real Shopify and Playwright.
- Token: `FakeShopify` gains `expiring=1` exchange and refresh with rotation; tests for refresh just before expiry, no refresh when far from expiry, concurrent callers serialised by the row lock (the second sees the rotated pair), atomic write of the new pair, transient failure retried with the SAME refresh token, final 401 sets `error` and the fixed reconnect text, old-shape credentials treated as non-expiring, no token or refresh token in any log, job payload, DTO, audit row or stored error text.
- Scheduler: `dueResources` boundaries for every cadence with injected `now`, a running cursor blocks, never-backfilled and non-active connections are skipped, the per-tick cap; Postgres tests for the new function and its hardening (search_path, grants) and tenant isolation of the follow-up queries.
- Nudges: topic-to-resource mapping, debounce bucket, dropped while running, subscription registration with the new topics against the fake, a rejected subscription degrades to polling.
- Link-up: links lines and fills the cost snapshot with the cost effective on the order date, idempotent, does not overwrite, tenant-isolated.
- Status DTO and web: per-resource states, the oldest-resource timestamp, the exact wording for each state.
- Webhook failures: retry count, alert row written once at exhaustion, privacy topics unchanged.

## 9. Documentation and rules to record

`docs/sync.md` (scheduler, cadences, nudges, link-up, per-resource status, new migrations), `docs/shopify-connection.md` (expiring tokens, refresh, new first-install checklist items: exchange and refresh shapes, `expiring=1`, the two new webhook subscriptions, real query cost under polling), CLAUDE.md section 16 and the Decisions Log (access tokens are short-lived and refreshed under a row lock; `last_synced_at` is the oldest resource; order webhooks wait for protected-data approval). Known unverified items stay listed.

## 10. Build order (about ten tasks, each reviewed)

1. Expiring-token exchange and the new credentials shape (connectors, API install).
2. Token refresh and the `TokenService` with the row lock (connectors, sync, worker wiring).
3. Due query migration and `dueResources`.
4. Ticker handler, cadences and idle refresh.
5. Webhook subscriptions, nudge handling and debounce.
6. Order-line link-up pass.
7. Per-resource status in the shared DTO and API.
8. Per-resource status in the web UI.
9. Failed-webhook retry counter, alert rows and the Connections alert display.
10. Documentation and final verification.

## 11. Risks

- Rotation: losing a rotated refresh token forces a reconnect. Mitigation: write the new pair in the same transaction as the lock, never refresh outside it, test the concurrent case.
- Polling load: 50 connections per tick times four resources against the 1000-point bucket. Mitigation: the existing per-connection rate limiter, the per-tick cap and the cadences; real cost is a first-install checklist item.
- The 15-minute order latency until the protected-data approval exists is a product limit, stated in the UI wording and the docs.
- Everything Shopify-shaped here (exchange, refresh, subscriptions) is unverified against a real shop.
