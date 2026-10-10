# Shopify connection (Phase 1b-2, hardened in 1b-3a, data import in 1b-3b)

This document describes how a Shopify store is connected to an org (1b-2, hardened in 1b-3a): the access token is stored encrypted, webhooks are received and stored, and uninstall and the mandatory privacy webhooks are handled. Section 9 describes what 1b-3b added: the connector that imports locations, products with unit costs, inventory and orders, and Sync now. Section 10 is the first-install checklist. Everything was built and tested against fakes; nothing has run against real Shopify (see sections 8 and 10).

## 1. Overview

```
Install
  web  --POST /orgs/:orgId/connections/shopify/install {shop}-->  api
  api  stores oauth_states (SHA-256 of nonce, 10 min), returns { authorizeUrl }
  web  redirects the browser to https://<shop>/admin/oauth/authorize?client_id&scope&redirect_uri&state

Callback (authenticated, through the web app)
  Shopify --redirect--> web GET ${WEB_PUBLIC_URL}/connections/shopify/callback?code&shop&state&hmac&timestamp...
  web route: forwards the raw query and the user's session -> api POST /connections/shopify/callback { query } (AuthGuard only)
       (no session: 401 -> web redirects to /login?next=<the callback URL>, so the user signs in and the callback resumes)
  api (ConnectionsService.completeInstall), in this order:
       1. Shopify and the encryption key configured            -> else not_configured
       2. verifyOAuthRawQuery (HMAC over the raw query, timestamp) -> else invalid_request
       3. code, shop, state present and the shop domain valid  -> else invalid_request
       4. app_consume_oauth_state (single use, the state is burned from here on) -> else state_expired
       5. consumed.userId must equal the signed-in user        -> else wrong_account
       6. the user must CURRENTLY be owner or admin of the state's org (the org comes from the state, never the session) -> else not_allowed
       7. shop must equal the shop bound to the state          -> else shop_mismatch
       8. shop_in_use pre-check (any non-disconnected, non-demo connection in another org, so error and pending count) -> else shop_in_use
       9. exchange code for token (form-urlencoded POST, no db transaction open) -> else exchange_failed
      10. withTenant(orgId): upsert store_connections (active), store encrypted token, audit row;
          a unique violation on store_connections_active_shop_uq -> shop_in_use
      11. register the app/uninstalled subscription (GraphQL)
  api returns { redirectTo }; web maps it to /connections?shopify=connected (or &warning=webhooks, or ?shopify_error=<code>)

Webhook (the only public Shopify route)
  Shopify --POST /webhooks/shopify--> api: HMAC over raw body -> headers -> app_find_store_connection
       -> insert webhook_events (dedupe, payload always {}) -> enqueue { orgId, eventId } (BullMQ, optional) -> 200
  worker: claim event -> act by topic -> processed | deferred | ignored | failed
  worker sweep (every 5 min): re-enqueue stale events
```

Platform logic is in `packages/connectors/src/shopify`; the API owns routing, auth and persistence (`apps/api/src/connections`); the worker owns event processing (`apps/worker/src/webhooks`).

## 2. Setting up a Shopify app

Create an app in the Shopify Partner organisation (Dev Dashboard) and put these values in place:

| Value | Where it goes |
|---|---|
| App client id | `SHOPIFY_API_KEY` |
| App client secret | `SHOPIFY_API_SECRET` |
| Allowed redirection URL `${WEB_PUBLIC_URL}/connections/shopify/callback` (the WEB app, not the API) | App configuration (Dev Dashboard or `shopify.app.toml`). It must exactly match, because `redirectUri` is built from `WEB_PUBLIC_URL` with trailing slashes removed. The user must be signed in to eRetailQuery to complete a connection. |
| Compliance webhooks `customers/data_request`, `customers/redact`, `shop/redact` with URI `${API_PUBLIC_URL}/webhooks/shopify` (`API_PUBLIC_URL` is still needed for the webhook URL) | App configuration (`[[webhooks.subscriptions]]` with `compliance_topics` in `shopify.app.toml`). The same endpoint also receives the per-shop `app/uninstalled` subscription the callback registers. |
| Scopes | App configuration must include the scopes in `SHOPIFY_SCOPES` (default `read_products,read_inventory,read_locations,read_orders,read_all_orders`, comma separated). `read_all_orders` may need Shopify's approval; without it the order history is limited to 60 days (section 9.2). |

Protected customer data access is a separate approval in the Partner dashboard and is **not** requested (1b-2 and 1b-3b): no customer scopes are asked for and no customer PII is stored. For the same reason each shop is subscribed only to `app/uninstalled`, `products/update` and `inventory_levels/update` (`SHOPIFY_WEBHOOK_TOPICS`; the last two carry no customer data and only nudge a sync). The order and refund topics carry customer data, need that approval, and stay unsubscribed (orders are polled).

The endpoint must use HTTPS with a valid certificate and answer 401 on a bad HMAC (it does).

Documentation checked on 2026-10-07:
- Authorization code grant (redirect URL must match exactly, form-urlencoded token exchange, HMAC rule, scope validation): https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
- Mandatory compliance webhooks (configured in `shopify.app.toml`, topics, 401 on invalid HMAC): https://shopify.dev/docs/apps/build/privacy-law-compliance
- Webhook delivery and HMAC header: https://shopify.dev/docs/apps/build/webhooks/subscribe/https (cited in code; not re-fetched here)

Could not confirm: where exactly in the current Dev Dashboard UI the redirect URL and scopes are entered (the page describes the Dev Dashboard and the TOML file, not click paths); whether scopes are declared in the app configuration or only requested in the authorize URL for a given app type; the GraphQL details in section 8. The fetched summary was produced by a small model, so re-read the pages when creating the real app.

## 3. Environment variables

| Name | Read by | Required | Effect when missing |
|---|---|---|---|
| `API_PUBLIC_URL` | API, worker | optional | API: Shopify is disabled (config is null). Public base URL of the API, used for the webhook URL. Worker: the webhook callback for the daily re-registration; without it nothing is re-registered. |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | API, worker | optional | API: Shopify disabled. Worker (token refresh): an expiring token that needs refreshing fails the run with "Token refresh is not configured on this server." |
| `SHOPIFY_SCOPES` | API | optional | Defaults to the five read scopes above. |
| `ENCRYPTION_KEY_ID`, `ENCRYPTION_KEY` | API | optional | No key provider: install and callback return `not_configured` or 503. Webhook receiving needs only the Shopify config. |
| `ENCRYPTION_OLD_KEYS` | API | optional | Retired keys are not available for decrypting old ciphertext. |
| `REDIS_URL` | API, worker | optional | API without it: webhook events are stored but not enqueued (the worker sweep processes them after the stale window), and no sync can start (Sync now answers 503 `sync_not_available`; the connect callback records "Could not start the first import. Use Sync now."). The worker needs it for the sync and webhook queues. |
| `WEB_PUBLIC_URL` | API | required | Host of the OAuth redirect URI (`${WEB_PUBLIC_URL}/connections/shopify/callback`) and base of the redirect after the callback. |
| `SHOPIFY_API_VERSION` | worker | optional | Admin API version for the sync queries, format `YYYY-MM` (checked with `/^\d{4}-\d{2}$/`). Empty or blank means the built-in default, the constant `SHOPIFY_API_VERSION` in `packages/connectors/src/shopify/config.ts` (currently `2025-07`). Any other value stops the worker at startup with "SHOPIFY_API_VERSION must look like 2025-07 (YYYY-MM) or be empty." (the value is never echoed). Only the worker reads the variable: the API has no setting for it and always uses the built-in default (for the webhook subscription call), so a worker override makes the two use different versions. Review the default when upgrading. |

All keys are listed with empty placeholders in `.env.example`. An empty value is treated as unset. With Shopify unconfigured the app still boots; the install route returns 503 `shopify_not_configured`.

## 4. Endpoints

| Route | Auth | Notes |
|---|---|---|
| `POST /orgs/:orgId/connections/shopify/install` | AuthGuard, OrgGuard, RolesGuard (admin and up) | Body `{ shop }`, normalized (trim, lowercase) and validated (one DNS label under `myshopify.com`). 400 `invalid_shop` (400 `validation_failed` for an empty body value), 503 `shopify_not_configured` when the Shopify config or the encryption key is missing, so the merchant is never sent to consent first. Returns `{ authorizeUrl }`. Lazily deletes the org's expired states. |
| `GET /orgs/:orgId/connections` | any member | id, platform, shop, status, `lastSyncedAt`, `lastError`. Never credentials. |
| `POST /orgs/:orgId/connections/:id/disconnect` | admin and up | Status `disconnected`, token wiped, audit row. 404 `connection_not_found`. Never deletes the row. |
| `POST /connections/shopify/callback` | AuthGuard only (no org in the path) | Body `{ query }`: the raw, still-encoded query string Shopify sent (1 to 4096 chars). Returns `{ redirectTo }`, never throws a Shopify error. Called by the web route, never by Shopify. The old public `GET /connections/shopify/callback` no longer exists. |
| `POST /webhooks/shopify` | public: HMAC over the raw body (the only public Shopify route, `ShopifyPublicController`) | 200 for stored, duplicate and unknown shop; 401 `invalid_signature`; 400 `bad_request` for malformed JSON (body-parser rejects it before the HMAC check, so the receiver's own `invalid_payload` code is unreachable); 503 `shopify_not_configured`. Answers within about 2 s even when Redis is down (the enqueue is capped; the row stays `received` for the sweep). |

Callback result codes (`?shopify_error=`), the nine `SHOPIFY_ERROR_CODES` in `packages/shared`, all fixed strings. The web route whitelists them and builds the `/connections?...` path itself, never trusting the API's URL:

| Code | Meaning |
|---|---|
| `invalid_request` | Bad or missing query HMAC (see Signature below), stale timestamp, missing code, state or shop, or an invalid shop domain. |
| `state_expired` | State unknown, already used or older than 10 minutes. |
| `wrong_account` | The signed-in user is not the user who started the install. The state is burned. |
| `not_allowed` | The user who started the install is no longer an owner or admin of the state's org (the role is checked as it is now). The state is burned. |
| `shop_mismatch` | The shop in the callback differs from the shop the state was created for. The state is burned. |
| `shop_in_use` | The shop has any non-disconnected, non-demo connection (`active`, `pending` or `error`) in a different org, found by the pre-check or by the unique index when two orgs race (see section 8). |
| `exchange_failed` | Any failure of the token exchange (rejected code, 401 or 403, rate limit, 5xx, network, unreadable response). The user sees one message; internally a 401 or 403 is an `AuthError`, 429 a `RateLimitedError`, 5xx a `TransientError`, other statuses a `PermanentError`. |
| `not_configured` | Shopify or the encryption key is not configured. |
| `server_error` | Anything unexpected (logged with a sanitized message). |

`?shopify=connected&warning=webhooks` means the connection was saved but registering at least one webhook subscription failed; `last_error` is set to "Webhook setup failed. Reconnect to retry." Reconnecting retries.

Token exchange: the request to `https://<shop>/admin/oauth/access_token` is sent as `application/x-www-form-urlencoded` with `client_id`, `client_secret` and `code` (Shopify's documented format), not JSON. Redirects are never followed and the shop is validated before any URL is built.

### Signature of the OAuth redirect

`verifyOAuthRawQuery` (`packages/connectors/src/shopify/hmac.ts`) verifies the hex HMAC over the raw query string, sorted by key without `hmac`. Shopify's docs do not say whether the signed message uses the encoded or the decoded values, so BOTH are accepted until the first real install shows which one Shopify uses; then drop the other. The decoded form is accepted only when no decoded key or value contains `&` and no key contains `=` (otherwise `a=1&b=2` and `a=1%26b%3D2` would sign identically, a parameter-smuggling ambiguity), so only the encoded form can match then. Rejected outright: repeated keys, malformed percent escapes, a pair without a key, an empty query, a query over 4096 characters, a missing or non-hex `hmac`. The timestamp must be an integer at most 600 seconds in the past and at most 60 seconds in the future.

### Request body parsing

`configureApp` mounts a 2mb JSON parser on `/webhooks/shopify` and a 100kb parser everywhere else; both capture `req.rawBody`, which the HMAC is computed over. Nest's own body parsers are off (`bodyParser: false`), so urlencoded bodies are no longer parsed; add a urlencoded parser in `configureApp` if a form endpoint appears. An Express error middleware in `configureApp` (`apps/api/src/app.config.ts`) answers malformed JSON on EVERY JSON route with 400 `bad_request` and the fixed message `Invalid request body` (Nest would otherwise quote a fragment of the caller's body); the exception filter still maps 413 to `payload_too_large`.

## 5. Webhooks

- **Verification:** base64 HMAC-SHA256 of the raw bytes with the app secret, constant-time compare, malformed or missing header rejected. A verified request additionally needs valid `X-Shopify-Topic`, `X-Shopify-Webhook-Id` and a valid `X-Shopify-Shop-Domain`; otherwise 401.
- **Dedupe key:** `(org_id, store_connection_id, external_event_id)` where `external_event_id` is `X-Shopify-Webhook-Id`. A second delivery returns 200 and stores nothing.
- **Why events for disconnected connections are still stored:** `app_find_store_connection` returns any row for the shop, preferring a non-disconnected one. Shopify sends `app/uninstalled` and `shop/redact` after the connection is already disconnected; they must still be recorded and acted on. Only a shop with no connection row at all is acknowledged and dropped (logged without payload).
- **Statuses:** `received` (stored), `processing` (claimed by a worker), `processed`, `failed` (error text sanitized, job rethrown so BullMQ retries; after the 5th attempt it stays `failed`, which is terminal except for the privacy topics, see the sweep below), `ignored` (unknown topic), `deferred` (data topic parked for 1b-3).
- **Per topic (worker):**
  - `app/uninstalled`: connection set to `disconnected`, token wiped, audit `connection.uninstalled`, event `processed`.
  - `customers/data_request`, `customers/redact`: we hold no customer PII, so an audit row `privacy.request_recorded` (topic only, never the payload) is written and the event is `processed`.
  - `shop/redact`: looks up the event's connection and calls `app_purge_shop(platform, shop)` (section 7), which purges every disconnected or errored connection of the shop in every org. The event row normally goes with the cascade; if an active reinstall owns the shop, the event is closed as `processed`.
  - `products/update`, `inventory_levels/update` (subscribed since 1b-3c): only nudge a sync (`apps/worker/src/webhooks/nudge.ts`, debounced in the database, see docs/sync.md "Live updates"); the payload is `{}`, the event becomes `processed`.
  - `orders/create`, `orders/updated`, `orders/cancelled`, `refunds/create`, `products/create|delete`: not subscribed. If one arrives anyway it is marked `deferred`. The stored payload is `{}` already, because the receiver never stores a body.
  - Anything else: `ignored`.
- **Claim and reclaim:** the claim (`received` or `failed` to `processing`) commits before the work, so a `shop/redact` purge, whose cascade deletes the event row, never waits on our own row lock. A `processing` event whose `updated_at` is older than `STALE_EVENT_MS` (10 minutes) can be claimed again by another worker.
- **Stale-event sweep:** every 5 minutes (`scheduleWebhookSweep`) the worker calls `app_list_stale_webhook_events`, which returns `received` events older than the cutoff, `processing` events whose `updated_at` is older than the cutoff (migration 0016), and `failed` events of the privacy topics `customers/data_request`, `customers/redact` and `shop/redact` whose last attempt (`updated_at`) is older than the cutoff (migration 0021), and re-enqueues them. A failed privacy event is therefore retried with a fresh set of 5 attempts every 10 to 15 minutes until it succeeds; a failed event of any other topic is never retried. Each sweep window uses a time-bucketed job id suffix (`_r<bucket>`) so a retained finished job never swallows the retry; double processing is safe because the claim is atomic.
- **Payloads:** the receiver verifies the HMAC, checks the body is valid JSON and discards it; `webhook_events.payload` is `{}` for every topic. Migration 0019 scrubbed rows stored before this. The worker never needs a body (it fetches data from Shopify when 1b-3 needs it). The sweep is supported by index `webhook_events_status_updated_idx` on `(status, updated_at)`.
- **Queue:** job data is only `{ orgId, eventId }`; job id `<orgId>_<eventId>`, 5 attempts, exponential backoff from 5 s.

## 6. Credentials

The tokens are stored in `store_connections.encrypted_credentials` as AES-256-GCM encrypted JSON with AAD `connection:<id>`, written by `encryptConnectionCredentials`. For expiring tokens (1b-3c) the blob is `{ accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt }`; the old `{ accessToken }` shape is read as non-expiring and never refreshed. The two expiry times are mirrored in `store_connections.access_token_expires_at` and `refresh_token_expires_at` (so the scheduler can find idle connections without decrypting). The install sends `expiring=1`. A refresh rotates both tokens and is serialised by the connection row lock (`createTokenService`, docs/sync.md "Token service"); a final `401` marks the connection `error` with "Shopify no longer accepts this connection. Reconnect the store." The connector only ever receives `{ accessToken }`. The sync reads the blob with `decryptConnectionCredentials`. Disconnect and uninstall set the column to null. The token, secrets, state nonce and payloads are never logged or put in job data, `last_error` or audit metadata; stored error text goes through `sanitizeMessage`.

## 7. Privacy and data removal

Held: connection metadata (shop domain, scopes, status, errors), encrypted token, hashed OAuth states, and webhook event rows (topic, ids, status; the payload is always `{}`). No customer PII is stored: no data topics are subscribed, no webhook body is ever persisted, and the 1b-3b import never queries customer fields (section 9.1). Imported orders, products and inventory are business data and are purged with the connection by `shop/redact`.

`shop/redact` runs `app_purge_shop(platform, shop)` (migrations 0017 and 0018; SECURITY DEFINER, worker only). It selects every connection of that platform and shop in every org whose status is `disconnected` or `error`, locking the rows `FOR UPDATE` (a concurrent reinstall cannot be purged; the status is re-checked per row), and calls `app_purge_store_connection` for each. It never touches an `active`, `pending` or `demo` connection, and returns the number purged. For each connection that deletes the inventory movements (the one intended path that removes ledger rows), sync runs, the shop's oauth states (filtered by org, platform and shop), and the connection row, which cascades to locations, levels, listings, orders, lines, refunds, cursors and webhook events. It does not delete the org's catalog (products, SKUs) or cost data. It writes one audit row `store_connection.purged` (reason `shop_redact`) per org purged. Uninstall and privacy requests also write audit rows (`connection.uninstalled`, `privacy.request_recorded`, topic only).

## 8. Known gaps

### Resolved in 1b-3a

- The OAuth callback is bound to the user who started the install and their current role (authenticated callback through the web session).
- `shop/redact` purges every non-active connection of the shop across orgs (`app_purge_shop`).
- Webhook payloads are never retained (section 5).
- One non-disconnected connection per shop across all orgs is a database invariant: unique index `store_connections_active_shop_uq` on `(platform, external_account_id) WHERE status NOT IN ('disconnected', 'demo')` (migration 0020; the preflight migration 0019 aborts if existing rows already break it). It is cross-org by design. A violation in the callback upsert maps to `shop_in_use`, so a race ends with exactly one winner. An errored connection in another org therefore blocks a reconnect until it is disconnected or purged. Any org may reconnect a shop once its previous connection is `disconnected`; until `shop/redact` purges it, a disconnected row can coexist with the new one (webhook lookup prefers the non-disconnected one).

### Open items

- **OAuth signature form.** Both the encoded and decoded signed forms are accepted (section 4); verify on the first real install and drop one.
- **Failed events.** Since migration 0021 the sweep re-lists `failed` events of `customers/data_request`, `customers/redact` and `shop/redact` once their last attempt is older than 10 minutes, so a mandatory erasure is retried until it succeeds (tested against Postgres; the BullMQ path is unverified without Redis). Since 1b-3c failed `app/uninstalled`, `products/update` and `inventory_levels/update` events are retried 5 times (`sweep_retries`) and then raise an `alerts` row shown on the Connections page (docs/sync.md "Failed webhook events"). Not covered: a privacy event that keeps failing is retried forever with no alert (its sanitized `error` column is the only trace); a final retry that never executes leaves no alert; failed events of other topics stay terminal; an event the API never stored (for example a database outage during receipt) relies on Shopify's own redelivery.
- **A lost `app/uninstalled` leaves the connection active.** If `app/uninstalled` exhausts its retries, the connection stays `active`, so a later `shop/redact` purges nothing (`app_purge_shop` never touches an active connection). The worker then still closes the event as `processed` but writes the audit row `privacy.shop_redact_skipped` (topic and purged count only) on the event's connection; treat that row as a mandatory erasure request that needs manual follow-up. The same row is written when the event's own connection survives the purge (an active reinstall owns the shop). When another org's disconnected row is the one purged, the `shop/redact` event itself lands in the active org's `webhook_events` (topic and ids only, no payload).
- **Shared database role.** The API and the worker share the `app_user` role, which can execute `app_purge_store_connection` and `app_purge_shop`. Consider a separate worker role later.

- **Nothing has run against real Shopify.** All behaviour is verified against `fake-shopify` and `signing` test helpers only.
- **Webhook subscription GraphQL not verified.** The `webhookSubscriptionCreate` mutation (`URL!` variable type, `format: JSON`, topic enum names derived as `ORDERS_CREATE` and so on) was not independently verified against the live docs. Check it against a real shop (section 10).
- **Callback edges.** A 401 from the API for a user whose web session still looks valid (for example an expired access token) bounces the user to the dashboard and loses the callback; the user restarts the connection. The web callback route sets `Referrer-Policy: no-referrer` on its redirects, because the query carries the code, state and signature.
- No reconnect reminder emails.
- The Redis queue, worker and sweep tests are skipped without Docker and are unverified until CI. The web page's pure helpers are unit-tested; the Playwright test only covers the guided empty page and error-text safety, not a real connect, and phone-width layout is unchecked.
- The default API version is the constant `SHOPIFY_API_VERSION` in `packages/connectors/src/shopify/config.ts`; the worker can override it with the env var of the same name.
- Embedded Postgres test cleanup: `startTestDatabase()` in embedded mode stops the server and removes the directory on stop, process exit and SIGINT/SIGTERM. The orphan `io_worker` processes seen on Windows came from `taskkill /T` killing children while the postmaster was alive: it entered crash recovery and respawned auxiliary processes outside taskkill's snapshot. The helper now kills the postmaster alone first, waits for it, then kills its `postgres.exe` children by parent pid (created after the server's start, so a reused pid is never hit), with a data-directory sweep as a fallback; every external command has a 20 s timeout, and the cleanup test re-queries descendants after the stop. In embedded mode the helper now captures the postmaster's exact creation time after start and only kills a pid whose current creation time equals it (the pid-reuse guard on Windows); the kill order is postmaster first, then its children. Verified on Windows with repeated `@erq/db` runs, zero leftover processes. The POSIX paths (SIGQUIT, which makes the postmaster kill its own children) remain unverified until CI.

## 9. Data import (1b-3b)

The connector (`packages/connectors/src/shopify`) fetches one page per call through the Admin GraphQL API with paginated queries (no bulk operations yet). The sync engine writes the pages (see `docs/sync.md`). The connector never touches the database.

### 9.1 What is imported and what is left out

| Resource | Imported |
|---|---|
| Locations | Name, address (joined `address.formatted`), active flag. A fulfillment-service location maps to `3pl`, any other to `warehouse`. Inactive locations are included. |
| Products | Title, vendor, product type, status (`ACTIVE`, `DRAFT`, `ARCHIVED`; any unknown status maps to `draft`), and per variant: SKU, barcode, price, compare-at price and the inventory item's unit cost. A unit cost pre-fills the `product_cost` component only when the SKU has none (never overwrites). A cost in another currency than the shop's is ignored. A zero unit cost (`"0.00"`) is treated as no cost (null): Shopify shows 0 when no cost was entered, and a stored 0 would block the real cost later (the import never overwrites) and hide the "add your costs" prompt. |
| Inventory | Per inventory item and location the quantity names `on_hand`, `available` and `incoming`. `reserved` is stored as `max(0, on_hand - available)`, so it covers everything on hand that Shopify will not sell (committed, reserved, damaged, safety stock, quality control) and our available equals Shopify's. A level without `available` is stored with reserved 0. |
| Orders | Money (discounts, tax, shipping, lines, refunds), lines, refunds with their lines and shipping refunds, cancelled and closed state. Point-of-sale orders (`sourceName` `pos`) get the channel `shopify_pos`; every other source (including unknown ones) is `shopify_online`. Test orders are imported and flagged `isTest`. |

Deliberately left out: customers, UTM fields and the landing site. They are protected customer data, which needs Shopify's approval and is not requested, so `customerExternalId`, `utm*` and `landingSite` are always null. The connector never queries a customer field.

Subscribed webhooks (1b-3c): `app/uninstalled`, `products/update` and `inventory_levels/update` (the last two only nudge a sync). The connector has `updated_at` incremental filters for products and orders; inventory always takes a full pass (section 9.7). Since 1b-3c a one-minute scheduler runs incremental syncs on a tiered cadence (docs/sync.md "Live updates"); Sync now still starts a run on demand.

### 9.2 Scopes and order history

Requested scopes: `read_products`, `read_inventory`, `read_locations`, `read_orders`, `read_all_orders`. The scopes stored on the connection are the ones Shopify granted (from the token response). Shopify serves only the last 60 days of orders without `read_all_orders`, so the first backfill reaches back 365 days when the granted scopes include it and 60 days otherwise (`ordersBackfillSince` in `packages/sync/src/history.ts`; the scope must match exactly). Products, inventory and locations are always imported in full. The Connections page shows the oldest imported order date ("Showing orders from ...") and, when `read_all_orders` was not granted, that older history is not available.

### 9.3 Starting a sync

- **First backfill:** starts automatically at the end of the OAuth callback (all four resources, in order). The callback waits at most 5 seconds for the first job to be queued. If that fails (no Redis, queue error, timeout) the connection is still saved and connected, `last_error` is set to "Could not start the first import. Use Sync now." (`IMPORT_NOT_STARTED_MESSAGE` from `@erq/sync`) and the merchant uses Sync now. When the webhook setup failed as well, the webhook warning is stored instead, because a reconnect fixes both. The real end of a later import chain clears the import warning (docs/sync.md); other warnings stay. Reconnecting a shop re-runs a full backfill (accepted: the sinks are idempotent).
- **Sync now:** `POST /orgs/:orgId/connections/:id/sync`, owner or admin only. 404 `connection_not_found`; 409 `connection_not_active` unless the connection is `active` or `error` (disconnected, pending and demo are refused); 503 `sync_not_available` when there is no Redis queue or the first job cannot be queued. Returns `{ started: boolean }`; `started: false` while any resource of the connection is still running. It runs a full backfill when any resource has never completed, otherwise an incremental run. A start writes the audit action `connection.sync_requested`.
- **Sync summary** on each item of `GET /orgs/:orgId/connections` (`sync`): `state` (`never`, `running`, `idle`, `failed`), `resource` (the first running or failed resource in the order locations, products, inventory, orders), `recordsProcessed`, `coveredFrom` (oldest imported order date, test orders excluded), `historyLimited`, `error` (the failed resource's stored error), `canStart`. `never` also covers a partly finished first import.
- **Web wording** (`describeSync` in `apps/web/src/lib/connections.ts`): a disconnected store reads "Not connected"; a running import shows the resource and the record count; a failed one reads "Import stopped" with the stored reason; a connection in `error` is never shown as up to date; a finished one reads "Last import finished <relative time>" and gets a warning when older than `STALE_AFTER_MS` (2 days). The reason for a disabled Sync now button is shown as text beside it.

### 9.4 Query size and rate limits

Shopify rejects a query whose requested cost exceeds 1000 points, so the page sizes are small constants in `packages/connectors/src/shopify/cursor.ts`:

| Resource | Sizes |
|---|---|
| Locations | 100 per page |
| Products | 8 products per page, 50 variants inline; more variants through follow-up pages |
| Inventory | 10 items per page, 10 levels inline, 50 per follow-up page |
| Orders | 3 orders per page, 10 lines inline (100 per follow-up page), 5 refunds inline, 5 refund lines and 2 refund shipping lines per refund inline. Follow-up queries `ErqOrderRefunds` (an order with more than 5 refunds), `ErqRefundLines` and `ErqRefundShipping` (100 per page). Hard cap: 20 refunds per order (more fails the page). |

Extra pages for one parent are bounded by `MAX_EXTRA_PAGES` (20). The cost model in the code comments (1 point per object, 2 per variant with its inventory item, a money set counts 2, one per inventory quantity name) is an estimate: **verify it on the first install** with `extensions.cost.requestedQueryCost`. The page sizes may be raised once the real costs are known.

Throughput estimate (unmeasured): at 3 orders per page and about 0.5 pages per second (the limiter's 50 points per second at 100 per page), a 365-day backfill of 100k orders takes about 18 hours, far from the under-10-minutes goal for the first insight. Page sizes may be raised once the real query costs are known (and bulk operations are an option for 1b-3c).

Rate limiting: the engine charges a fixed `costPerPage` of 100 before each fetch against the policy `{ capacity 1000, refillPerSecond 50, costPerPage 100 }` (`packages/sync/src/policies.ts`); the limiter never sees the actual cost, so the numbers are an estimate and are unverified. On top of that the connector reacts to Shopify:

- A GraphQL `THROTTLED` error is waited out **in place**: the client sleeps the wait computed from the reported cost and restore rate (clamped 500 to 60000 ms, default 2000 ms when the cost data is missing) and resends the same query, at most 5 times and 60 s of waiting in total for one query. Only then does it throw `RateLimitedError`, and the engine re-queues the page after that delay without using an attempt. Retrying the one query matters: a page with many follow-up queries (for example 8 products with about 250 variants each, about 32 `ErqProductVariants` calls) can drain the 1000-point bucket mid-page, and re-running the whole page from its first query against an empty bucket could repeat forever. The sleep is injectable (`sleep` option) so tests never wait. No pacing from `throttleStatus.currentlyAvailable` is done before a query.
- An HTTP 429 becomes a `RateLimitedError` at once (no in-place retry), with the wait from `Retry-After` clamped to 500 to 60000 ms (default 2000 ms).

### 9.5 Error mapping

Any GraphQL `errors` entry fails the whole page, even when `data` is present (a tolerated field-level access error could silently null unit costs and corrupt profit numbers). Stored messages are fixed strings; the response body and the token are never included.

| Situation | Error | Stored message |
|---|---|---|
| Invalid shop domain | permanent | Invalid shop domain |
| Unusable stored credentials | auth | Stored credentials are unusable. Reconnect the store. |
| HTTP 401 or 403 | auth | Shopify rejected the access token. |
| HTTP 429 | rate limited | (retried later) |
| HTTP 5xx | transient | Shopify is temporarily unavailable |
| Network failure or timeout | transient | network error |
| GraphQL error code `THROTTLED` | waited out in place (up to 5 times, 60 s in total), then rate limited | (retried later) |
| GraphQL error code `ACCESS_DENIED` | permanent | Shopify did not allow this request. Check the app's permissions. |
| Any other non-200 status, unparseable body, unexpected shape, any other GraphQL error | permanent | Shopify returned an unexpected response. |
| Unreadable amount or currency | permanent | Shopify returned an unreadable amount. / Shopify returned an unreadable currency. |
| Mixed currencies in one order | permanent | Shopify returned mixed currencies for one order. |
| An order with more than 20 refunds | permanent | An order has too many refunds to import. |
| A product, inventory item, order or refund removed between two queries of one page, or a line or level repeated across follow-up pages | transient (BullMQ retries the page) | Shopify data changed while it was being read. Retrying. |
| Tampered or invalid cursor | permanent | Invalid sync cursor. |

### 9.6 Money

Shopify money is a decimal string. The connector converts it with exact string math (no floating point) to integer minor units using the currency's exponent: 0 for JPY, KRW and the other zero-decimal currencies, 3 for BHD, KWD and the other three-decimal ones, otherwise 2. Extra digits are rounded, never rejected: half away from zero on the first dropped digit only (so `0.014999` USD is 1 cent), and a result of zero is 0, never -0. The four-decimal units CLF and UYW are not in the exponent table (they are not shop currencies). An amount with more than 15 integer digits or above the safe integer range fails the page. The shop currency comes from `shop { currencyCode }` in each query; an order uses its own money-set currency. There is one currency per org and no FX conversion.

### 9.7 Limitations of the import

- **Tax-inclusive shops** (`taxesIncluded` true) double count tax: line prices already contain tax and tax is also reported separately, so net sales are overstated. Not handled (the US target market is tax-exclusive; non-US tax is out of scope for v1).
- **Incremental filters can miss changes.** Incremental runs filter products and orders on `updated_at`, which misses cost-only changes (inventory item cost does not bump the product). A periodic full sync is needed (1b-3c). Cost import never overwrites an existing cost anyway.
- **Inventory is always read in full.** The inventory item's `updated_at` does not move when only a quantity changes, so an `updated_at` filter would leave stock stale after Sync now while the page says the import just finished. Until 1b-3c, `fetchInventory` ignores `updatedSince` and every run (backfill or incremental) reads every item and level. This is safe because inventory has no history window and the sink is idempotent; the cost is one full inventory read per run.
- **Zero unit costs** are imported as no cost (section 9.1), so a product that truly costs nothing shows the add-costs prompt until a cost is entered in the app.
- **Money assumptions (unverified, first-install checklist):**
  - `refundLineItems.subtotalSet` is assumed to be after line discounts and before tax.
  - A line's discount is its `totalDiscountSet`, not the sum of `discountAllocations`.
  - Line quantity is `LineItem.quantity`, not `currentQuantity`, so an order edited without a refund (an item removed) overstates gross sales.
  - Gift-card lines count as gross sales (no special handling).
  - A refund with no lines uses its `totalRefundedSet` minus shipping, which includes tax.
  - When a refund has lines, its amount is the sum of the line subtotals, so an order-level manual refund adjustment in the same refund is dropped.
  - Several refund lines for the same order line in one refund (for example restocks at two locations) are summed into one row per line.
  - A cancelled order without a refund keeps its net sales; whether cancelled orders count toward revenue is a decision for 1d (P&L).
- **Late-linked order lines:** since 1b-3c a link-up pass after each products run links them and fills the cost snapshot; a line whose SKU has no cost yet keeps a null snapshot until `repriceOrderLines` runs (docs/sync.md).
- **Unknown values:** an unknown product status maps to `draft`; an unknown order source maps to `shopify_online`.
- **Shipping versus discounts:** whether a free-shipping discount is subtracted twice (`totalDiscountsSet` and `totalShippingPriceSet`) is unverified.

## 10. First-install checklist (everything below is unverified)

Nothing in 1b-3b has run against a real Shopify shop. On the first install check each item and fix the code or this document:

1. **GraphQL names and shapes per query:** `locations(includeInactive:)`, `isFulfillmentService`, `address.formatted`; `inventoryItems` (no filter is sent); `quantities(names: ["on_hand","available","incoming"])` and that `available` excludes committed, reserved, damaged, safety_stock and quality_control; the money assumptions in section 9.7 (`refundLineItems.subtotalSet` after line discounts and before tax, `totalDiscountSet` versus `discountAllocations`, `quantity` versus `currentQuantity`, gift-card lines, tax in refunds without lines, dropped order-level refund adjustments, cancelled orders without a refund); a zero `unitCost` for a variant with no cost entered; the `refunds` list on `Order` (a plain list, no cursor), `refundLineItems`, `refundShippingLines`, `restockType`; `sourceName` (`pos`), `test`, `taxesIncluded`, `totalShippingPriceSet` and `totalDiscountsSet`; the `node(id)` follow-up queries for refund lines and shipping lines.
2. **API version** `2025-07`: still supported, and the queries valid on it.
3. **Query costs:** read `extensions.cost.requestedQueryCost` and `actualQueryCost` for each query. Check the cost model behind the page sizes (section 9.4) and raise the page sizes if there is room. Check the 1000-point cap and the rate-limit policy `{1000, 50, 100}`; plans above standard have larger buckets.
4. **Throttle signals:** the `THROTTLED` error code is not stated on Shopify's rate-limit page (only HTTP 429 is); confirm what a throttled request looks like.
5. **`Money` is a decimal string** in every money field used.
6. **OAuth redirect signature:** whether Shopify signs the encoded or the decoded query (section 4); drop the other form.
7. **`unitCost`:** whether reading `inventoryItem.unitCost` needs `read_inventory` or `read_products`, and what a shop without that permission returns (any GraphQL error fails the page).
8. **`read_all_orders`:** whether the app is granted it, and that the stored granted scopes drive the 365-day versus 60-day window.
9. **Tax-inclusive shop and free-shipping discount** behavior (section 9.7).
10. **Webhook subscription GraphQL** (`webhookSubscriptionCreate`, `URL!` variable, `format: JSON`), now used three times per connect (`app/uninstalled`, `products/update`, `inventory_levels/update`) and again by the daily re-registration.
11. **Reconnect** re-running a full backfill, and the 5-second wait for the first job in the callback.
12. **Expiring token exchange:** the `expiring=1` answer (`expires_in`, `refresh_token`, `refresh_token_expires_in`).
13. **Token refresh:** the refresh request and its rotation, and that a replayed refresh token gives `401 {"error":"invalid_request"}`.
14. **Product and stock subscriptions:** that `products/update` and `inventory_levels/update` are accepted without protected customer data approval and that their delivery nudges a sync within seconds.
15. **Polling cost:** the real query cost of the 15-minute polling against the 1000-point bucket with several shops (`extensions.cost.actualQueryCost`).
16. **Scheduler:** that the BullMQ job scheduler `sync-tick` runs exactly one tick per minute across worker restarts and several worker instances.
17. **Nudge and sweep through real BullMQ** (Redis was not available in development).
18. **Pool pressure:** that the connection row lock held across the Shopify refresh call does not exhaust the Postgres pool under load (it is `FOR NO KEY UPDATE` with a 5 s lock timeout and 30 s statement timeout).
19. **Inventory event volume:** the real volume of `inventory_levels/update` events on a busy shop against the 10-minute inventory nudge debounce (does the hourly poll plus nudges stay within the 1000-point bucket).
20. **Other unverified 1b-3c items:** the Connections page (per-resource lines, alerts, Reconnect) in a browser, and the Playwright e2e (not run: no Docker or Redis).

Connecting a development store end to end:

1. Create an app in the Shopify Partner organisation and a development store.
2. Set the allowed redirection URL to `${WEB_PUBLIC_URL}/connections/shopify/callback` (the web origin) and the compliance webhooks to `${API_PUBLIC_URL}/webhooks/shopify`.
3. Set `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_SCOPES` (or leave it empty for the default five), `API_PUBLIC_URL`, `WEB_PUBLIC_URL`, `REDIS_URL`, `ENCRYPTION_KEY_ID` and `ENCRYPTION_KEY` (`openssl rand -base64 32`) for the API, and `REDIS_URL` plus the same database and encryption settings for the worker. Optionally set `SHOPIFY_API_VERSION` for the worker.
4. Run the API, the worker and the web app, sign in, open Connections and connect the shop. The first import starts after the redirect; watch the sync summary, then use Sync now for later runs.
5. Work through the checklist above and record the real costs.
