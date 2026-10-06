# Shopify connection (Phase 1b-2)

This document describes what 1b-2 built: connecting a Shopify store to an org, storing the access token encrypted, receiving and storing webhooks, and handling uninstall and the mandatory privacy webhooks. It does not fetch any Shopify data (that is 1b-3). Everything below was built and tested against fakes; nothing has run against real Shopify (see section 8).

## 1. Overview

```
Install
  web  --POST /orgs/:orgId/connections/shopify/install {shop}-->  api
  api  stores oauth_states (SHA-256 of nonce, 10 min), returns { authorizeUrl }
  web  redirects the browser to https://<shop>/admin/oauth/authorize?client_id&scope&redirect_uri&state

Callback (public route)
  Shopify --redirect--> api GET /connections/shopify/callback?code&shop&state&hmac&timestamp...
  api: verify query HMAC + timestamp -> validate shop -> app_consume_oauth_state (single use)
       -> shop must equal the shop bound to the state -> shop_in_use check
       -> exchange code for token (form-urlencoded POST, no db transaction open)
       -> withTenant(orgId): upsert store_connections (active), store encrypted token, audit row
       -> register the app/uninstalled subscription (GraphQL) -> 302 to ${WEB_PUBLIC_URL}/connections?shopify=connected
          (or ?shopify=connected&warning=webhooks, or ?shopify_error=<code>)

Webhook (public route)
  Shopify --POST /webhooks/shopify--> api: HMAC over raw body -> headers -> app_find_store_connection
       -> insert webhook_events (dedupe) -> enqueue { orgId, eventId } (BullMQ, optional) -> 200
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
| Allowed redirection URL `${API_PUBLIC_URL}/connections/shopify/callback` | App configuration (Dev Dashboard or `shopify.app.toml`). It must exactly match, because `redirectUri` is built from `API_PUBLIC_URL` with trailing slashes removed. |
| Compliance webhooks `customers/data_request`, `customers/redact`, `shop/redact` with URI `${API_PUBLIC_URL}/webhooks/shopify` | App configuration (`[[webhooks.subscriptions]]` with `compliance_topics` in `shopify.app.toml`). The same endpoint also receives the per-shop `app/uninstalled` subscription the callback registers. |
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
| `API_PUBLIC_URL` | API | optional | Shopify is disabled (config is null). Public base URL of the API, used for the redirect and webhook URLs. |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | API | optional | Shopify disabled. |
| `SHOPIFY_SCOPES` | API | optional | Defaults to the four read scopes above. |
| `ENCRYPTION_KEY_ID`, `ENCRYPTION_KEY` | API | optional | No key provider: install and callback return `not_configured` or 503. Webhook receiving needs only the Shopify config. |
| `ENCRYPTION_OLD_KEYS` | API | optional | Retired keys are not available for decrypting old ciphertext. |
| `REDIS_URL` | API | optional | Events are stored but not enqueued (a no-op queue); the worker sweep processes them after the stale window. |
| `WEB_PUBLIC_URL` | API | required | Base of the redirect after the callback. |
| `SHOPIFY_API_VERSION` | not an env var | n/a | The version is the constant `SHOPIFY_API_VERSION` in `packages/connectors/src/shopify/config.ts` (currently `2025-07`). Review it when upgrading. |

All keys are listed with empty placeholders in `.env.example`. An empty value is treated as unset. With Shopify unconfigured the app still boots; the install route returns 503 `shopify_not_configured`.

## 4. Endpoints

| Route | Auth | Notes |
|---|---|---|
| `POST /orgs/:orgId/connections/shopify/install` | AuthGuard, OrgGuard, RolesGuard (admin and up) | Body `{ shop }`, normalized (trim, lowercase) and validated. 400 `invalid_shop`, 503 `shopify_not_configured`. Returns `{ authorizeUrl }`. Lazily deletes the org's expired states. |
| `GET /orgs/:orgId/connections` | any member | id, platform, shop, status, `lastSyncedAt`, `lastError`. Never credentials. |
| `POST /orgs/:orgId/connections/:id/disconnect` | admin and up | Status `disconnected`, token wiped, audit row. 404 `connection_not_found`. Never deletes the row. |
| `GET /connections/shopify/callback` | public: query HMAC plus single-use state | Always redirects, never throws. |
| `POST /webhooks/shopify` | public: HMAC over the raw body | 200 for stored, duplicate and unknown shop; 401 `invalid_signature`; 400 `invalid_payload`; 503 `shopify_not_configured`. |

Callback error codes (`?shopify_error=`), all fixed strings:

| Code | Meaning |
|---|---|
| `invalid_request` | Bad or missing query HMAC, stale timestamp, missing code, state or shop, or an invalid shop domain. |
| `state_expired` | State unknown, already used or older than 10 minutes. |
| `shop_mismatch` | The shop in the callback differs from the shop the state was created for. |
| `shop_in_use` | The shop is actively connected (not disconnected) to a different org. |
| `exchange_failed` | Any failure of the token exchange (rejected code, 401 or 403, rate limit, 5xx, network, unreadable response). The user sees one message; internally a 401 or 403 is an `AuthError`, 429 a `RateLimitedError`, 5xx a `TransientError`, other statuses a `PermanentError`. |
| `not_configured` | Shopify or the encryption key is not configured. |
| `server_error` | Anything unexpected (logged with a sanitized message). |

`?shopify=connected&warning=webhooks` means the connection was saved but registering at least one webhook subscription failed; `last_error` is set to "Webhook setup failed. Reconnect to retry." Reconnecting retries.

Token exchange: the request to `https://<shop>/admin/oauth/access_token` is sent as `application/x-www-form-urlencoded` with `client_id`, `client_secret` and `code` (Shopify's documented format), not JSON. Redirects are never followed and the shop is validated before any URL is built.

### Request body parsing

`configureApp` mounts a 2mb JSON parser on `/webhooks/shopify` and a 100kb parser everywhere else; both capture `req.rawBody`, which the HMAC is computed over. Nest's own body parsers are off (`bodyParser: false`), so urlencoded bodies are no longer parsed; add a urlencoded parser in `configureApp` if a form endpoint appears. The exception filter maps body-parser 4xx errors instead of returning 500: 413 `payload_too_large`, and malformed JSON as 400.

## 5. Webhooks

- **Verification:** base64 HMAC-SHA256 of the raw bytes with the app secret, constant-time compare, malformed or missing header rejected. A verified request additionally needs valid `X-Shopify-Topic`, `X-Shopify-Webhook-Id` and a valid `X-Shopify-Shop-Domain`; otherwise 401.
- **Dedupe key:** `(org_id, store_connection_id, external_event_id)` where `external_event_id` is `X-Shopify-Webhook-Id`. A second delivery returns 200 and stores nothing.
- **Why events for disconnected connections are still stored:** `app_find_store_connection` returns any row for the shop, preferring a non-disconnected one. Shopify sends `app/uninstalled` and `shop/redact` after the connection is already disconnected; they must still be recorded and acted on. Only a shop with no connection row at all is acknowledged and dropped (logged without payload).
- **Statuses:** `received` (stored), `processing` (claimed by a worker), `processed`, `failed` (error text sanitized, job rethrown so BullMQ retries), `ignored` (unknown topic), `deferred` (data topic parked for 1b-3, payload emptied).
- **Per topic (worker):**
  - `app/uninstalled`: connection set to `disconnected`, token wiped, audit `connection.uninstalled`, event `processed`.
  - `customers/data_request`, `customers/redact`: we hold no customer PII, so an audit row `privacy.request_recorded` (topic only, never the payload) is written and the event is `processed`.
  - `shop/redact`: calls `app_purge_store_connection` (section 7). The event row is deleted with the connection, so nothing is marked afterwards.
  - `orders/create`, `orders/updated`, `orders/cancelled`, `refunds/create`, `products/create|update|delete`, `inventory_levels/update`: not subscribed in 1b-2. If one arrives anyway it is marked `deferred` and its stored `payload` is replaced with `{}`, so no customer data is retained.
  - Anything else: `ignored`.
- **Claim and reclaim:** the claim (`received` or `failed` to `processing`) commits before the work, so a `shop/redact` purge, whose cascade deletes the event row, never waits on our own row lock. A `processing` event whose `updated_at` is older than `STALE_EVENT_MS` (10 minutes) can be claimed again by another worker.
- **Stale-event sweep:** every 5 minutes (`scheduleWebhookSweep`) the worker calls `app_list_stale_webhook_events`, which returns `received` events older than the cutoff and `processing` events whose `updated_at` is older than the cutoff (migration 0016), and re-enqueues them. Each sweep window uses a time-bucketed job id suffix (`_r<bucket>`) so a retained finished job never swallows the retry; double processing is safe because the claim is atomic.
- **Queue:** job data is only `{ orgId, eventId }`; job id `<orgId>_<eventId>`, 5 attempts, exponential backoff from 5 s.

## 6. Credentials

The token is stored in `store_connections.encrypted_credentials` as AES-256-GCM encrypted JSON `{ "accessToken": string }` with AAD `connection:<id>`, written by `encryptConnectionCredentials`. 1b-3 reads it with `decryptConnectionCredentials`. Disconnect and uninstall set the column to null. The token, secrets, state nonce and payloads are never logged or put in job data, `last_error` or audit metadata; stored error text goes through `sanitizeMessage`.

## 7. Privacy and data removal

Held: connection metadata (shop domain, scopes, status, errors), encrypted token, hashed OAuth states, and webhook payloads (tenant data under RLS, never logged). No customer PII is stored in 1b-2: no data topics are subscribed, and a data-topic event that arrives anyway keeps only `{}` once the worker defers it.

`shop/redact` runs `app_purge_store_connection(org_id, connection_id)` (SECURITY DEFINER, worker only). It deletes the connection's inventory movements (the one intended path that removes ledger rows), sync runs, the shop's oauth states, and the connection row, which cascades to locations, levels, listings, orders, lines, refunds, cursors and webhook events. It does not delete the org's catalog (products, SKUs) or cost data. It writes an audit row `store_connection.purged` (reason `shop_redact`). Uninstall and privacy requests also write audit rows (`connection.uninstalled`, `privacy.request_recorded`).

## 8. Known gaps

- **Nothing has run against real Shopify.** All behaviour is verified against `fake-shopify` and `signing` test helpers only.
- **Expiring offline tokens (refresh deferred to 1b-3).** Shopify can issue expiring offline access tokens plus a refresh token to new public apps (the `expiring=1` flow). 1b-2 stores only `{ accessToken }`, does not request expiring tokens and has no refresh. If Shopify issues an expiring token anyway, syncs will fail with an auth error after expiry until refresh exists.
- **Webhook subscription GraphQL not verified.** The `webhookSubscriptionCreate` mutation (`URL!` variable type, `format: JSON`, topic enum names derived as `ORDERS_CREATE` and so on) was not independently verified against the live docs. Check it against a real shop in 1b-3.
- **`shop_in_use` is check-then-act.** A shop can be actively connected to only one org, enforced by a lookup in the callback; there is no unique index, so two orgs completing OAuth for the same shop at the same moment could both succeed. Webhooks resolve to one of them.
- Reconnecting: the upsert targets `(org, platform, shop)`, so the same org reuses its row. Another org is refused with `shop_in_use` only while the existing row is not `disconnected`; a disconnected row of another org does not block a new connection, and until it is purged two rows can exist for the shop (webhook lookup prefers the non-disconnected one).
- No reconnect reminder emails.
- The Redis queue, worker and sweep tests are skipped without Docker and are unverified until CI. The web page's pure helpers are unit-tested; the Playwright test only covers the guided empty page and error-text safety, not a real connect, and phone-width layout is unchecked.
- API version is pinned in `SHOPIFY_API_VERSION` (`packages/connectors/src/shopify/config.ts`).
- Embedded Postgres test cleanup: `startTestDatabase()` in embedded mode kills the process tree and removes the directory on stop, process exit and SIGINT/SIGTERM. POSIX paths are unverified on the Windows dev machine (CI is their first run), and an orphan `io_worker` was observed once after a single-file run on Windows.
