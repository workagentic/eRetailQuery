# Phase 1b-3b: Shopify Connector (design)

Date: 2026-10-09
Status: draft for review
Builds on: `2026-10-06-phase1b1-sync-foundations-design.md`, `2026-10-06-phase1b2-shopify-connection-design.md`, `2026-10-08-phase1b3a-hardening-design.md` (all merged). Follows CLAUDE.md sections 6, 7 and 16.

## 1. Purpose and scope

Phase 1b-3 (the Shopify sync) is split into three sub-projects: 1b-3a hardening (done), **1b-3b Shopify connector (this spec)**, 1b-3c live updates (scheduler, webhook nudges, link-up pass, token refresh, richer sync status).

1b-3b makes a connected Shopify store actually import: a `ShopifyStoreConnector` that fetches locations, products with costs, inventory and orders (POS as its own channel) through the existing page-job engine, the wiring that starts the first backfill after connect, a "Sync now" action, and a sync summary on the Connections page. Goal from CLAUDE.md: a Shopify merchant connects and sees real data quickly.

Decisions made with the owner on 2026-10-09:
- Fetching uses the paginated GraphQL Admin API through the existing `HttpClient` (one `fetchPage` per GraphQL page; cursor = Shopify's `endCursor`). Bulk operations (JSONL) are a later optimization; REST is legacy for new apps.
- **Customers and marketing fields are left out:** order customer ids (and UTM/landing-site data) are protected customer data that need separate approval, which we have not requested. `customerExternalId`, `utmSource`, `utmMedium`, `utmCampaign` and `landingSite` stay `null`. Repeat-customer features arrive in Phase 2 with the approval and a customers table.
- The first backfill starts **automatically after a successful connect**, and admins also get a **Sync now** action; the Connections page shows plain-English progress.
- Order history: request `read_all_orders` alongside the read scopes; backfill 12 months when it was granted, otherwise 60 days, and say so in the UI. The approval application for `read_all_orders` runs in parallel (owner action).

Out of scope: scheduler and incremental polling (1b-3c), webhook nudges (1b-3c), order-line link-up pass (1b-3c), token refresh and expiring tokens (1b-3c), customers/UTM, bulk operations, other platforms, any live Shopify call in tests.

## 2. The connector (`packages/connectors/src/shopify`)

### 2.1 Structure
- `graphql.ts`: `createShopifyGraphqlClient({ http, apiVersion })` with `query<T>(ctx, query, variables, schema)`: POST `https://<shop>/admin/api/<version>/graphql.json` (shop validated by `isValidShopDomain` from `ctx.externalAccountId`), header `X-Shopify-Access-Token` from `ctx.credentials` (validated `{ accessToken: string }`; anything else is `AuthError('Stored credentials are unusable. Reconnect the store.')`), body `{ query, variables }`. Every response is parsed with zod (`.passthrough()` on objects so unknown fields do not fail, strict on the fields we read).
- `money.ts`: `parseMoneyToMinorUnits(amount: string, currency: string): number`: exact string math on the decimal string (no floats), using the currency's ISO 4217 exponent (0 for JPY/KRW/VND/CLP and similar, 3 for KWD/BHD/OMR/JOD/TND, otherwise 2); a value with more decimal places than the currency allows is rounded half away from zero on the first dropped digit (covered by tests); negatives are supported; non-numeric or absurd input (over 15 integer digits) throws `PermanentError`.
- `queries.ts`: the five query documents and their zod response schemas.
- `normalize.ts`: pure mappers from validated Shopify nodes to `Normalized*` types.
- `connector.ts`: `createShopifyConnector({ http, apiVersion }): StoreConnector` implementing `fetchPage`; `connect` and `handleWebhook` are inert (installation and webhooks live elsewhere; `handleWebhook` is a no-op for now).
- Registered as `shopify` in the worker's `ConnectorRegistry`.

### 2.2 Error mapping (fixed messages, never response bodies, tokens or query text)
HTTP 401 or 403 → `AuthError`; HTTP 429 → `RateLimitedError` using `Retry-After`; a GraphQL error with `extensions.code === 'THROTTLED'` → `RateLimitedError` with the wait computed from the response's `extensions.cost.throttleStatus` (`(requestedQueryCost - currentlyAvailable) / restoreRate`, at least 500 ms, at most 60 s); HTTP 5xx and network failures → `TransientError`; `ACCESS_DENIED` → `PermanentError('Shopify did not allow this request. Check the app's permissions.')`; any other GraphQL error or a malformed body → `PermanentError('Shopify returned an unexpected response.')`. The page's reported cost is returned on `Page.cost`.

### 2.3 Resources
- **locations:** `locations(first: 100, after: $cursor, includeInactive: true)`: `id`, `name`, `isActive`, `isFulfillmentService`, `address { formatted }`. Type: fulfillment service → `3pl`, otherwise `warehouse`.
- **products:** `products(first: 25, after: $cursor, query: $filter)` where the filter is `updated_at:>=<updatedSince>` for incrementals, none for backfill (all products always import). Per product: `id`, `title`, `vendor`, `productType`, `status`, `updatedAt`, and `variants(first: 100)` with `id`, `sku`, `barcode`, `price`, `compareAtPrice`, `updatedAt`, `inventoryItem { unitCost { amount currencyCode } }`. Money fields are in the shop currency (`Money` is a decimal string plus `currencyCode` from `shop { currencyCode }` read on the first page and carried in the cursor). Status `ACTIVE`/`DRAFT`/`ARCHIVED` map to `active`/`draft`/`archived`. A product with more than 100 variants: the remaining variant pages are fetched inside the same `fetchPage` call (`product(id) { variants(first: 100, after) }`), bounded at 20 extra calls, beyond which the page fails with a `PermanentError` that names no data.
- **inventory:** `inventoryItems(first: 50, after: $cursor, query: $filter)` (filter `updated_at:>=` for incrementals) with `id`, `variant { id }` and `inventoryLevels(first: 50)` of `location { id }`, `quantities(names: ["on_hand","committed","reserved","incoming"]) { name quantity }`, `updatedAt`. Mapping: `onHand = on_hand`, `reserved = committed + reserved`, `incoming = incoming`. Items with no variant are skipped; an item with more than 50 levels pages through its remaining levels inside the call (bounded like variants).
- **orders:** `orders(first: 50, after: $cursor, sortKey: CREATED_AT or UPDATED_AT, query: $filter)` with filter `created_at:>=<since>` (backfill) or `updated_at:>=<updatedSince>` (incremental). Per order: `id`, `createdAt`, `updatedAt`, `cancelledAt`, `closedAt`, `test`, `sourceName`, `currencyCode` (shop currency via the `shopMoney` fields), `totalTaxSet`, `shippingLine`/`totalShippingPriceSet`, `totalDiscountsSet`, line items (`id`, `title`, `quantity`, `originalUnitPriceSet`, `totalDiscountSet`, `variant { id }`; `lineItems(first: 100)` with the same bounded extra paging) and `refunds` (`id`, `createdAt`, `totalRefundedSet`, refund line items with `lineItem { id }`, `quantity`, `subtotalSet`, shipping refunds, and whether stock was restocked). Semantics: `grossCents` = sum of `originalUnitPrice × quantity` over lines (before discounts, excluding shipping and tax); `discountCents` = total order discounts; line `discountCents` = that line's allocated discount (never above its total); `shippingChargedCents`, `taxCents` from the shop-money sets; refund `amountCents` EXCLUDES tax and shipping (`shippingRefundCents` separate), as defined in 1b-1. Channel: `sourceName == 'pos'` → `shopify_pos`, else `shopify_online`. Status: `cancelledAt` set → `cancelled`; else `closedAt` set → `closed`; else `open`. `isTest` from `test`. Customer and UTM fields `null`.

### 2.4 Cursors and filters
The connector encodes its cursor as base64url JSON `{ v: 1, after: string | null, shopCurrency?: string }` so the page-job `cursor` string stays opaque and canonical. `FetchOptions.since` (backfill) and `updatedSince` (incremental) feed the filters above (a backfill never passes `updatedSince`: fixed in 1b-3a). An invalid or foreign cursor is a `PermanentError`.

## 3. Wiring

- **Worker:** `apps/worker/src/main.ts` registers `createShopifyConnector({ http: createFetchHttpClient(), apiVersion })` (`SHOPIFY_API_VERSION` from the connectors package, overridable by `SHOPIFY_API_VERSION` env). The rate-limit policy for `shopify` changes from the placeholder to the documented cost bucket (capacity 1000, refill 50 per second on standard plans, a conservative per-page charge); numbers are confirmed against Shopify's current documentation while implementing and recorded in `packages/sync/src/policies.ts` with a doc link. Throttling beyond the policy is handled by the connector's `RateLimitedError`.
- **Scopes:** `DEFAULT_SHOPIFY_SCOPES` and the env default gain `read_all_orders`. The granted scopes returned by Shopify are already stored on the connection.
- **History depth:** a pure function `ordersBackfillSince(scopes: string[], now: Date): Date` (365 days if `read_all_orders` is in the granted scopes, else 60 days) lives in `packages/sync` and is used for the orders run; the other resources run with the same `since` argument but ignore it.
- **API:** `enqueueSync` takes `Pick<SyncDeps, 'db' | 'queue' | 'now'>` (it only uses those). The API module builds a `sync` queue producer (same Redis, same fail-fast options as the webhook producer) when `REDIS_URL` is set, else a no-op producer and the sync summary says syncing is not available on this server. After a successful callback the API enqueues `{ resources: 'all', mode: 'backfill', since }` (a failure to enqueue does not fail the connect; it records `last_error = 'Could not start the first import. Use Sync now.'`).
- **Sync now:** `POST /orgs/:orgId/connections/:id/sync` (`AuthGuard, OrgGuard, RolesGuard`, `@Roles('admin')`): if no resource has a completed backfill run it starts a backfill with `ordersBackfillSince(...)`, otherwise an incremental sync with `updatedSince` = the last successful run start per resource; responds `{ started: boolean }` (`false` when a run is already active). 404 for an unknown connection, 503 `sync_not_available` without a queue; "already running" is a normal `{ started: false }` answer, never an error.
- **Status recovery:** when a sync chain completes successfully, an `error` connection whose error came from a sync returns to `active` with `last_error = null` (the engine already sets `last_synced_at`).

## 4. Connections page

`GET /orgs/:orgId/connections` adds per connection `sync: { state: 'idle' | 'running' | 'failed' | 'never', resource: string | null, recordsProcessed: number, coveredFrom: string | null, error: string | null }` derived from `sync_cursors` and `sync_runs` (never exposing credentials or raw errors beyond the sanitized `last_error`). The web page renders plain-English text from pure helpers: "Importing orders, 1,200 so far", "Last updated 5 minutes ago", "Showing orders from <date>. Older history needs Shopify's approval to read all orders." (when the covered range is the 60-day fallback), and a failure message with the existing reconnect action for auth errors. Admins get a **Sync now** button (disabled while running); loading skeleton, error and empty states stay.

## 5. Testing and verification
- **Connector:** a fixture-driven `FakeShopifyAdmin` (an `HttpClient`) in `@erq/connectors/testing` serves canned GraphQL JSON per query and cursor from fixture files written from Shopify's documented response shapes. Tests: every resource passes the contract suite; pagination and cursor round trips; a product with more than 100 variants and an item with more than 50 levels; orders with discounts, shipping, tax, partial refunds with restock, POS, test and cancelled; zero-, two- and three-decimal currencies and the money parser table; throttling (`THROTTLED` with throttle status and HTTP 429), 401/403, 5xx, malformed and unexpected shapes; error messages contain no token, body or query text; the GraphQL client rejects an invalid shop and unusable credentials before any request.
- **Engine end to end:** with the existing harness and the fake Shopify, a full backfill fills locations, SKUs and listings, inventory levels and movements, and orders with cost snapshots; a replayed page changes nothing; a throttled page retries without losing data; an auth error marks the connection errored and a later good sync recovers it; the orders run uses the 12-month or 60-day `since`.
- **API/web:** callback starts the backfill (Redis present and absent), `sync` summary shape, Sync now roles/started/already-running/503, no credentials in responses; web helpers for the new messages; Playwright path written, CI only.
- Acceptance: lint, typecheck and tests green per package; no leftover postgres processes or temp directories.

## 6. Documentation
`docs/shopify-connection.md` (how a dev store connects, scopes and `read_all_orders`, what imports, what is left out and why, history depth, rate limits, the first-install checklist for field names, cost numbers and API version), `docs/sync.md` (the connector and its cursors), CLAUDE.md section 16 and the Decisions Log.

## 7. Success criteria
1. Against the fake Shopify, a full backfill imports locations, products with costs, inventory and orders into the existing tables, idempotently, with correct integer-cent money in zero-, two- and three-decimal currencies.
2. The contract suite passes for the Shopify connector; errors never leak tokens, bodies or queries.
3. Connect starts the first backfill automatically; Sync now works for admins only; the Connections page shows progress, the covered history range and failures in plain English.
4. All tests, typecheck, lint and builds pass; unverified items (real Shopify field names, cost numbers, API version) are listed in the docs.

## 8. Refinements made during implementation

Where the build differs from the text above (the code and `docs/shopify-connection.md` section 9 are authoritative):

- Per-resource modules instead of one `queries.ts` and `normalize.ts`. The cursor carries only `after`; the shop currency comes from `shop { currencyCode }` in each query, and orders use their own money-set currency (mixed currencies fail the page).
- Page sizes are small constants (products 8 and variants 50; inventory items 10; orders 3 with follow-up queries for lines, refunds, refund lines and refund shipping lines, at most 20 refunds per order) because Shopify rejects queries whose requested cost exceeds 1000 points. The cost model is an estimate to verify on the first install.
- Any GraphQL `errors` entry fails the page, and the HTTP 429 and throttle waits are clamped to 500 to 60000 ms. Rate-limit policy: `{ capacity 1000, refillPerSecond 50, costPerPage 100 }`, charged as a fixed amount per page and unverified.
- The engine, not the connector, records `last_synced_at` and recovers `error` to `active`, only at a real chain end and never for a resumed job. `failRun` never touches disconnected or demo connections. `enqueueSync` fails the run and frees the cursor when the queue throws.
- Sync now answers 404 `connection_not_found`, 409 `connection_not_active` (anything but `active` or `error`) and 503 `sync_not_available`, and returns `started: false` while any resource is running. `coveredFrom` is the oldest imported order date and `historyLimited` comes from the stored scopes.
- Tax-inclusive shops double count tax (documented limitation). Unknown product status maps to `draft`; unknown order source maps to online.
