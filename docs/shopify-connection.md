# Shopify connection (Phase 1b-2, hardened in 1b-3a)

This document describes what 1b-2 built and 1b-3a hardened: connecting a Shopify store to an org, storing the access token encrypted, receiving and storing webhooks, and handling uninstall and the mandatory privacy webhooks. It does not fetch any Shopify data (that is 1b-3). Everything below was built and tested against fakes; nothing has run against real Shopify (see section 8).

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
| Scopes | App configuration must include the scopes in `SHOPIFY_SCOPES` (default `read_products,read_inventory,read_locations,read_orders`, comma separated). |

Protected customer data access is a separate approval in the Partner dashboard and is **not** requested in 1b-2: no customer scopes are asked for and no customer PII is stored. For the same reason 1b-2 subscribes each shop to `app/uninstalled` only (`SHOPIFY_WEBHOOK_TOPICS`); the order, refund, product and stock topics (`SHOPIFY_FUTURE_DATA_WEBHOOK_TOPICS`) carry customer data, likely need that approval, and are subscribed in 1b-3 together with their consumption.

The endpoint must use HTTPS with a valid certificate and answer 401 on a bad HMAC (it does).

Documentation checked on 2026-10-07:
- Authorization code grant (redirect URL must match exactly, form-urlencoded token exchange, HMAC rule, scope validation): https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
- Mandatory compliance webhooks (configured in `shopify.app.toml`, topics, 401 on invalid HMAC): https://shopify.dev/docs/apps/build/privacy-law-compliance
- Webhook delivery and HMAC header: https://shopify.dev/docs/apps/build/webhooks/subscribe/https (cited in code; not re-fetched here)

Could not confirm: where exactly in the current Dev Dashboard UI the redirect URL and scopes are entered (the page describes the Dev Dashboard and the TOML file, not click paths); whether scopes are declared in the app configuration or only requested in the authorize URL for a given app type; the GraphQL details in section 8. The fetched summary was produced by a small model, so re-read the pages when creating the real app.

## 3. Environment variables

| Name | Read by | Required | Effect when missing |
|---|---|---|---|
| `API_PUBLIC_URL` | API | optional | Shopify is disabled (config is null). Public base URL of the API, used for the webhook URL. |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | API | optional | Shopify disabled. |
| `SHOPIFY_SCOPES` | API | optional | Defaults to the four read scopes above. |
| `ENCRYPTION_KEY_ID`, `ENCRYPTION_KEY` | API | optional | No key provider: install and callback return `not_configured` or 503. Webhook receiving needs only the Shopify config. |
| `ENCRYPTION_OLD_KEYS` | API | optional | Retired keys are not available for decrypting old ciphertext. |
| `REDIS_URL` | API | optional | Events are stored but not enqueued (a no-op queue); the worker sweep processes them after the stale window. |
| `WEB_PUBLIC_URL` | API | required | Host of the OAuth redirect URI (`${WEB_PUBLIC_URL}/connections/shopify/callback`) and base of the redirect after the callback. |
| `SHOPIFY_API_VERSION` | not an env var | n/a | The version is the constant `SHOPIFY_API_VERSION` in `packages/connectors/src/shopify/config.ts` (currently `2025-07`). Review it when upgrading. |

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
- **Statuses:** `received` (stored), `processing` (claimed by a worker), `processed`, `failed` (error text sanitized, job rethrown so BullMQ retries), `ignored` (unknown topic), `deferred` (data topic parked for 1b-3).
- **Per topic (worker):**
  - `app/uninstalled`: connection set to `disconnected`, token wiped, audit `connection.uninstalled`, event `processed`.
  - `customers/data_request`, `customers/redact`: we hold no customer PII, so an audit row `privacy.request_recorded` (topic only, never the payload) is written and the event is `processed`.
  - `shop/redact`: looks up the event's connection and calls `app_purge_shop(platform, shop)` (section 7), which purges every disconnected or errored connection of the shop in every org. The event row normally goes with the cascade; if an active reinstall owns the shop, the event is closed as `processed`.
  - `orders/create`, `orders/updated`, `orders/cancelled`, `refunds/create`, `products/create|update|delete`, `inventory_levels/update`: not subscribed in 1b-2. If one arrives anyway it is marked `deferred`. The stored payload is `{}` already, because the receiver never stores a body.
  - Anything else: `ignored`.
- **Claim and reclaim:** the claim (`received` or `failed` to `processing`) commits before the work, so a `shop/redact` purge, whose cascade deletes the event row, never waits on our own row lock. A `processing` event whose `updated_at` is older than `STALE_EVENT_MS` (10 minutes) can be claimed again by another worker.
- **Stale-event sweep:** every 5 minutes (`scheduleWebhookSweep`) the worker calls `app_list_stale_webhook_events`, which returns `received` events older than the cutoff and `processing` events whose `updated_at` is older than the cutoff (migration 0016), and re-enqueues them. Each sweep window uses a time-bucketed job id suffix (`_r<bucket>`) so a retained finished job never swallows the retry; double processing is safe because the claim is atomic.
- **Payloads:** the receiver verifies the HMAC, checks the body is valid JSON and discards it; `webhook_events.payload` is `{}` for every topic. Migration 0019 scrubbed rows stored before this. The worker never needs a body (it fetches data from Shopify when 1b-3 needs it). The sweep is supported by index `webhook_events_status_updated_idx` on `(status, updated_at)`.
- **Queue:** job data is only `{ orgId, eventId }`; job id `<orgId>_<eventId>`, 5 attempts, exponential backoff from 5 s.

## 6. Credentials

The token is stored in `store_connections.encrypted_credentials` as AES-256-GCM encrypted JSON `{ "accessToken": string }` with AAD `connection:<id>`, written by `encryptConnectionCredentials`. 1b-3 reads it with `decryptConnectionCredentials`. Disconnect and uninstall set the column to null. The token, secrets, state nonce and payloads are never logged or put in job data, `last_error` or audit metadata; stored error text goes through `sanitizeMessage`.

## 7. Privacy and data removal

Held: connection metadata (shop domain, scopes, status, errors), encrypted token, hashed OAuth states, and webhook event rows (topic, ids, status; the payload is always `{}`). No customer PII is stored in 1b-2: no data topics are subscribed and no webhook body is ever persisted.

`shop/redact` runs `app_purge_shop(platform, shop)` (migrations 0017 and 0018; SECURITY DEFINER, worker only). It selects every connection of that platform and shop in every org whose status is `disconnected` or `error`, locking the rows `FOR UPDATE` (a concurrent reinstall cannot be purged; the status is re-checked per row), and calls `app_purge_store_connection` for each. It never touches an `active`, `pending` or `demo` connection, and returns the number purged. For each connection that deletes the inventory movements (the one intended path that removes ledger rows), sync runs, the shop's oauth states (filtered by org, platform and shop), and the connection row, which cascades to locations, levels, listings, orders, lines, refunds, cursors and webhook events. It does not delete the org's catalog (products, SKUs) or cost data. It writes one audit row `store_connection.purged` (reason `shop_redact`) per org purged. Uninstall and privacy requests also write audit rows (`connection.uninstalled`, `privacy.request_recorded`, topic only).

## 8. Known gaps

### Resolved in 1b-3a

- The OAuth callback is bound to the user who started the install and their current role (authenticated callback through the web session).
- `shop/redact` purges every non-active connection of the shop across orgs (`app_purge_shop`).
- Webhook payloads are never retained (section 5).
- One non-disconnected connection per shop across all orgs is a database invariant: unique index `store_connections_active_shop_uq` on `(platform, external_account_id) WHERE status NOT IN ('disconnected', 'demo')` (migration 0020; the preflight migration 0019 aborts if existing rows already break it). It is cross-org by design. A violation in the callback upsert maps to `shop_in_use`, so a race ends with exactly one winner. An errored connection in another org therefore blocks a reconnect until it is disconnected or purged. Any org may reconnect a shop once its previous connection is `disconnected`; until `shop/redact` purges it, a disconnected row can coexist with the new one (webhook lookup prefers the non-disconnected one).

### Open items

- **OAuth signature form.** Both the encoded and decoded signed forms are accepted (section 4); verify on the first real install and drop one.
- **Failed events are never swept.** Events that end `failed` after 5 BullMQ attempts are not picked up by the sweep, including privacy topics. Sweep or alert on them before 1b-3b ingests data.
- **A lost `app/uninstalled` leaves the connection active.** If `app/uninstalled` exhausts its retries, the connection stays `active`, so a later `shop/redact` purges nothing (`app_purge_shop` never touches an active connection). The worker then still closes the event as `processed` but writes the audit row `privacy.shop_redact_skipped` (topic and purged count only) on the event's connection; treat that row as a mandatory erasure request that needs manual follow-up. The same row is written when the event's own connection survives the purge (an active reinstall owns the shop). When another org's disconnected row is the one purged, the `shop/redact` event itself lands in the active org's `webhook_events` (topic and ids only, no payload).
- **Shared database role.** The API and the worker share the `app_user` role, which can execute `app_purge_store_connection` and `app_purge_shop`. Consider a separate worker role later.

- **Nothing has run against real Shopify.** All behaviour is verified against `fake-shopify` and `signing` test helpers only.
- **Expiring offline tokens (refresh deferred to 1b-3c).** Shopify can issue expiring offline access tokens plus a refresh token to new public apps (the `expiring=1` flow). 1b-2 stores only `{ accessToken }`, does not request expiring tokens and has no refresh. If Shopify issues an expiring token anyway, syncs will fail with an auth error after expiry until refresh exists.
- **Webhook subscription GraphQL not verified.** The `webhookSubscriptionCreate` mutation (`URL!` variable type, `format: JSON`, topic enum names derived as `ORDERS_CREATE` and so on) was not independently verified against the live docs. Check it against a real shop in 1b-3.
- **Callback edges.** A 401 from the API for a user whose web session still looks valid (for example an expired access token) bounces the user to the dashboard and loses the callback; the user restarts the connection. The web callback route sets `Referrer-Policy: no-referrer` on its redirects, because the query carries the code, state and signature.
- No reconnect reminder emails.
- The Redis queue, worker and sweep tests are skipped without Docker and are unverified until CI. The web page's pure helpers are unit-tested; the Playwright test only covers the guided empty page and error-text safety, not a real connect, and phone-width layout is unchecked.
- API version is pinned in `SHOPIFY_API_VERSION` (`packages/connectors/src/shopify/config.ts`).
- Embedded Postgres test cleanup: `startTestDatabase()` in embedded mode stops the server and removes the directory on stop, process exit and SIGINT/SIGTERM. The orphan `io_worker` processes seen on Windows came from `taskkill /T` killing children while the postmaster was alive: it entered crash recovery and respawned auxiliary processes outside taskkill's snapshot. The helper now kills the postmaster alone first, waits for it, then kills its `postgres.exe` children by parent pid (created after the server's start, so a reused pid is never hit), with a data-directory sweep as a fallback; every external command has a 20 s timeout, and the cleanup test re-queries descendants after the stop. In embedded mode the helper now captures the postmaster's exact creation time after start and only kills a pid whose current creation time equals it (the pid-reuse guard on Windows); the kill order is postmaster first, then its children. Verified on Windows with repeated `@erq/db` runs, zero leftover processes. The POSIX paths (SIGQUIT, which makes the postmaster kill its own children) remain unverified until CI.
