# eRetailQuery Phase 1b-1: Sync Foundations — Design Spec

Date: 2026-10-06
Status: Draft, awaiting owner review
Source of truth for product rules: `CLAUDE.md` §5, §6, §9 (this spec does not override it).
Builds on: Phase 0 (`2026-10-05-phase0-foundations-design.md`) and Phase 1a (`2026-10-06-phase1a-metrics-design.md`).

## 1. Purpose and scope

Phase 1b (Shopify connector, POS, inventory, CSV import, cost entry) is split into four sub-projects: **1b-1 sync foundations (this spec)**, 1b-2 Shopify connection (OAuth, credentials, webhooks, privacy webhooks), 1b-3 Shopify sync (products, costs, locations, inventory, orders including POS, backfill), 1b-4 costs and import (CSV with column mapping, manual cost entry, the Products and pricing screen).

1b-1 builds what all of them write into and run on:
1. The order, inventory and location data model with RLS.
2. The connector contract: normalized types and a page-based `fetchPage`.
3. The sync engine: resumable page-job chain, idempotent sinks, rate limiting, typed errors, cost snapshots on order lines.
4. A fake connector that proves the engine end to end.

In scope: new tables and migrations (section 4), `packages/connectors` contract changes (section 5), a new `packages/sync` package (section 6), BullMQ glue in `apps/worker` (section 7), tests (section 8).

Out of scope: any real platform API (Shopify is 1b-2/1b-3), OAuth, webhooks, API endpoints and UI, schedules, CSV import, customers (no `customers` table; only an opaque external customer id), currency conversion, ad connectors.

Success criteria:
1. Migrations apply cleanly; the existing isolation suite covers every new table (fixtures added) and still fails if a tenant table lacks RLS.
2. A fake connector serving multiple pages for each resource (locations, products, inventory, orders) lands correct rows; replaying any page changes nothing; killing the run after a page commit and resuming continues from the stored cursor with no loss or duplication.
3. An update older than the stored `external_updated_at` never overwrites newer data.
4. Rate-limited, transient, auth and permanent errors each produce the specified behaviour (section 6.4), verified with fakes.
5. Order-line COGS snapshots use the cost effective on the order date, are null when no cost exists, and `repriceOrderLines` fills them in after costs are added.
6. `pnpm lint`, `pnpm typecheck` and the tests of the touched packages pass.

## 2. Decisions made while brainstorming

| Decision | Choice | Why |
|---|---|---|
| Decomposition | 1b-1 foundations first | Everything else writes into it |
| Customer data | Opaque `customer_external_id` only; no names, emails or addresses; customers table in Phase 2 | Smaller privacy surface; works before Shopify protected-data approval; erasure webhook becomes a safe clear of one column |
| Sync engine | Chain of small page jobs; cursor committed in the same transaction as the data; next page enqueued after commit | Resumable, retry-safe, progress is easy to show, no long-lived jobs |
| Connector contract | `fetchPage(ctx, resource, cursor, options)` replaces the async-iterator `backfill` in CLAUDE.md §6 | Page jobs need an explicit cursor; connectors never touch the database |
| Package layout | New `packages/sync` holds engine, sinks and rate-limiter interface; `apps/worker` holds BullMQ/Redis glue | Keeps the engine testable on embedded Postgres without Redis |
| Currency | One currency per org assumed in Phase 1; orders in another currency are stored and flagged | FX table is a later item (CLAUDE.md §6.3) |

## 3. Shared conventions

- Every new table follows the Phase 0 rules: `id uuid`, `org_id`, `created_at`, `updated_at` (append-only `inventory_movements` has no `updated_at`), RLS via `app_secure_tenant_table`, composite `(org_id, id)` foreign keys to tenant parents, a fixture in `packages/db/test/fixtures.ts`.
- Money is `bigint` cents plus `currency char(3)`.
- `store_connections` gains `UNIQUE (org_id, id)` in the first migration of this phase so child tables can use composite foreign keys to it.
- Sync code never uses the unscoped database client; everything runs through `withTenant(orgId, ...)`.

## 4. Data model

New enums: `location_type` (warehouse, store, 3pl, fba, other); `location_source` (shopify, manual); `movement_reason` (sale, return, restock, adjustment, count, sync_correction); `sales_channel` (shopify_online, shopify_pos); `order_status` (open, closed, cancelled); `sync_resource` (products, locations, inventory, orders); `cursor_status` (idle, running, failed, complete).

### 4.1 `locations`
`store_connection_id` (nullable, composite FK), `external_id` (nullable), `name`, `type`, `address` (text, nullable), `source`, `is_active` (default true). A CHECK requires `store_connection_id` and `external_id` when `source = 'shopify'`. Unique `(org_id, store_connection_id, external_id)` where `external_id` is not null; unique `(org_id, name)` where `store_connection_id` is null (manual locations); unique `(org_id, id)`.

### 4.2 `inventory_levels`
`sku_id`, `location_id` (composite FKs), `on_hand` (integer, may be negative because stores can oversell), `reserved` (>= 0, default 0), `incoming` (>= 0, default 0), `reorder_point`, `safety_stock` (>= 0, nullable), `counted_at` (nullable, set by manual counts), `external_updated_at` (nullable). Unique `(org_id, sku_id, location_id)`.

### 4.3 `inventory_movements`
Append-only ledger: `sku_id`, `location_id`, `delta` (integer, nonzero), `reason`, `ref_type`, `ref_id` (nullable), `occurred_at`, `created_at`. `app_user` has no UPDATE or DELETE grant. Partial unique index on `(org_id, ref_type, ref_id, sku_id, location_id, reason)` where `ref_id` is not null, so writes are idempotent. Index `(org_id, sku_id, occurred_at)`.

### 4.4 `sku_channel_listings`
`sku_id`, `store_connection_id` (composite FKs), `external_product_id`, `external_variant_id`, `channel_price_cents` (nullable, >= 0), `currency`, `external_updated_at`. Unique `(org_id, store_connection_id, external_variant_id)`; index `(org_id, sku_id)`.

### 4.5 `orders`
`store_connection_id` (composite FK), `external_order_id`, `channel`, `status`, `placed_at`, `cancelled_at` (nullable), `currency`, `gross_cents`, `discount_cents`, `shipping_charged_cents`, `tax_cents`, `refund_cents` (all >= 0), `net_cents` (gross − discount − refund; may be negative), `customer_external_id` (nullable, opaque), `utm_source`, `utm_medium`, `utm_campaign`, `landing_site` (all nullable), `is_test` (default false), `external_updated_at` (not null). Unique `(org_id, store_connection_id, external_order_id)` and `(org_id, id)`. Indexes `(org_id, placed_at)` and `(org_id, channel, placed_at)`.

### 4.6 `order_lines`
`order_id` (composite FK, cascade), `sku_id` (nullable composite FK; null when the external variant is unmapped), `external_line_id`, `external_variant_id` (nullable), `title`, `quantity` (> 0), `unit_price_cents` (>= 0), `discount_cents` (>= 0), `refunded_quantity` (>= 0 and <= quantity, default 0), `unit_cogs_cents_snapshot` (nullable, >= 0). Unique `(org_id, order_id, external_line_id)` and `(org_id, id)`; index `(org_id, sku_id)`.

### 4.7 `refunds` and `refund_lines`
`refunds`: `order_id` (composite FK), `external_refund_id`, `refunded_at`, `amount_cents` (>= 0), `shipping_refund_cents` (>= 0, default 0), `restock` (boolean). Unique `(org_id, order_id, external_refund_id)` and `(org_id, id)`. `refund_lines`: `refund_id`, `order_line_id` (composite FKs), `quantity` (> 0), `amount_cents` (>= 0); unique `(org_id, refund_id, order_line_id)`. The sink recomputes `orders.refund_cents`, `orders.net_cents` and `order_lines.refunded_quantity` from refunds in the same transaction.

### 4.8 `sync_cursors`
`store_connection_id` (composite FK), `resource`, `cursor` (nullable text), `status`, `backfill_since` (nullable), `updated_since` (nullable watermark for incremental runs), `current_sync_run_id` (nullable), `records_processed` (bigint, default 0), `last_synced_at`, `last_error`. Unique `(org_id, store_connection_id, resource)`. The existing `sync_runs` table records each run (`type` is `backfill` or `incremental`, `connection_kind` is `store`).

## 5. Connector contract (`packages/connectors`)

Replaces the types in `src/types.ts`; no platform-specific field may leave this package.

- `type SyncResource = 'products' | 'locations' | 'inventory' | 'orders'`.
- `Page<T> = { items: T[]; nextCursor: string | null; cost?: number }` (`cost` is the rate-limit cost the call consumed, when the platform reports one).
- `NormalizedLocation { externalId; name; type; address: string | null; isActive }`.
- `NormalizedProduct { externalId; title; brand; category; status; updatedAt; variants: NormalizedVariant[] }`, `NormalizedVariant { externalId; skuCode; barcode; priceCents; compareAtPriceCents; currency; unitCostCents | null; updatedAt }`.
- `NormalizedInventoryLevel { externalVariantId; locationExternalId; onHand; reserved; incoming; updatedAt }`.
- `NormalizedOrder { externalId; channel; status; placedAt; cancelledAt | null; currency; grossCents; discountCents; shippingChargedCents; taxCents; customerExternalId | null; utm...; landingSite; isTest; updatedAt; lines: NormalizedOrderLine[]; refunds: NormalizedRefund[] }` with `NormalizedOrderLine { externalLineId; externalVariantId | null; title; quantity; unitPriceCents; discountCents }` and `NormalizedRefund { externalId; refundedAt; amountCents (excludes tax); shippingRefundCents; restock; lines: { externalLineId; quantity; amountCents }[] }`.
- `FetchOptions = { since?: Date; updatedSince?: Date }` and `ConnectionContext = { connectionId; externalAccountId; credentials: unknown (decrypted, never logged) }`.
- `StoreConnector.fetchPage(ctx, resource, cursor, options): Promise<Page<...>>` typed per resource through an overload map. `connect`, `handleWebhook`, `pushPrice` and `pushInventory` stay as in CLAUDE.md §6 (implemented in later sub-projects).
- Typed errors, exported from this package: `RateLimitedError(retryAfterMs)`, `TransientError`, `AuthError`, `PermanentError`.
- `decryptConnectionCredentials(encrypted, keyProvider, connectionId)` uses the Phase 0 AES-256-GCM helper with additional authenticated data `connection:<connectionId>`; 1b-2 must encrypt with the same AAD.
- `ConnectorRegistry` maps a store platform to its connector. 1b-1 provides only the fake connector.

## 6. Sync engine (`packages/sync`)

### 6.1 Units
- `RateLimiter` interface `{ take(key: string, cost: number, policy: RateLimitPolicy): Promise<{ allowed: true } | { allowed: false; retryAfterMs: number }> }`, plus `MemoryRateLimiter` and `RATE_LIMIT_POLICIES` per platform (capacity and refill per second).
- `JobQueue` interface `{ enqueue(job: SyncPageJob, opts?: { delayMs?: number }): Promise<void> }`, plus an in-memory implementation for tests.
- `SyncPageJob = { orgId; connectionId; resource; syncRunId; then? }`, where `then` is the rest of an `all` sync (`{ resources; mode; since }`) so resources run in dependency order. The chain is not persisted (see `docs/sync.md`).
- `sinks/` one per resource: `upsertLocations`, `upsertProducts` (creates or updates products, SKUs and channel listings, writes a `product_cost` component from `unitCostCents` only when the SKU has no `product_cost` component yet, effective from the run's `backfill_since` date (or the sync date for incremental runs), so history is costed with the current Shopify cost until the owner records real cost history; later changes of the Shopify cost are not applied automatically and existing costs are never overwritten), `upsertInventory` (levels plus derived movements from level changes), `upsertOrders` (orders, lines, refunds, cost snapshots). Every sink takes a transaction and a page of normalized items and is idempotent.
- `snapshotUnitCogs(rows, placedOn, currency)` returns the landed cost in effect on the order date (`placedOn` is the order date in the org timezone, not UTC) using the same time-versioning rule as `@erq/metrics` `landedCost`, or `null` when the SKU has no cost components in effect.
- `repriceOrderLines(tx, orgId, skuId, from)` recomputes null or outdated snapshots for a SKU from a date onward.

### 6.2 Entry points
- `enqueueSync(deps, { orgId, connectionId, resource | 'all', mode })`: in one transaction, finds or creates the `sync_cursors` row; if a run is already `running` for that resource it returns the existing run id (one active run per connection and resource); otherwise creates a `sync_runs` row, sets the cursor row to `running` (backfill resets the cursor and sets `backfill_since`; incremental starts from `updated_since`), and enqueues the first page job.
- `processSyncPage(deps, job): Promise<PageResult>` where `PageResult = { kind: 'next'; job } | { kind: 'done'; followUp? } | { kind: 'delayed'; delayMs } | { kind: 'failed'; reason }` (`next` carries the job to enqueue; `followUp` is the first job of the next resource in an `all` chain).
- `resumeStalledRuns(deps, olderThan)`: finds cursors in `running` whose `updated_at` is older than the threshold, through the SECURITY DEFINER function `app_list_stalled_sync_cursors` (the only intentional cross-tenant read, because the resumer has no org context), and re-enqueues their page job from the stored cursor. This covers a crash between commit and enqueue. Scheduling it is 1b-3.

### 6.3 `processSyncPage` steps
1. Load the connection (via `withTenant`), build the `ConnectionContext` (decrypt credentials), read the cursor row. If the run is no longer the current run, return `done` (stale job).
2. Ask the rate limiter for tokens. When not allowed, return `delayed` with `retryAfterMs`.
3. Call `connector.fetchPage`.
4. In one `withTenant` transaction: lock the cursor row and compare-and-set (the cursor must still be `running` for this run and hold the cursor value the page was fetched with, otherwise the job is stale and returns `done` without writing), call the resource sink, advance `sync_cursors` (new cursor, `records_processed`), and update the `sync_runs` row.
5. If `nextCursor` is null, mark the cursor `complete` (set `last_synced_at`, `updated_since` to the run's start time) and the run `succeeded`, return `done`; otherwise return `next`. The worker glue enqueues the next job after the transaction has committed.

### 6.4 Error handling
- `RateLimitedError`: return `delayed` with its `retryAfterMs`; no attempt is consumed.
- `TransientError` and unknown errors: rethrown so the queue retries with exponential backoff (5 attempts); after the last attempt the glue calls `failSyncRun`.
- `AuthError`: mark the connection `error` with a message, mark cursor and run failed, return `failed`. No retry.
- `PermanentError`: mark cursor and run failed with the message, return `failed`. No retry.
- Error messages stored in `last_error` never contain credentials.

### 6.5 Idempotency and ordering
All writes upsert on the external-id unique keys. An update to an existing row is applied only when its `external_updated_at` is greater than or equal to the stored value, so replays and out-of-order pages cannot regress data. Inventory movements are derived only when a level changes and carry a reference built from the run and resource so replay inserts nothing new.

## 7. Worker glue (`apps/worker`)

- `BullMqJobQueue` implements `JobQueue` (queue `sync`, job options: 5 attempts, exponential backoff, `removeOnComplete` with a retention limit).
- `RedisRateLimiter` implements `RateLimiter` with an atomic token-bucket Lua script keyed by connection id.
- `createSyncWorker(...)` processes jobs through `tenantJob`-style validation of `orgId`, calls `processSyncPage`, and enqueues the next job (with `delayMs` when delayed) after the result is known. Worker concurrency and the queue name are configuration.
- Credentials never appear in job data; only ids.

## 8. Testing

- **Database (embedded Postgres in dev, Testcontainers in CI):** migrations; isolation suite fixtures for every new table; constraint tests (composite foreign keys across tenants, CHECKs, partial unique indexes, append-only movements, `app_user` privileges).
- **Sinks:** idempotent replay, out-of-order older updates ignored, unmapped variant leaves `sku_id` null, refund recomputation, movement derivation, cost snapshot correctness with time-versioned costs and `repriceOrderLines`.
- **Engine:** with the fake connector, in-memory queue and `MemoryRateLimiter`: multi-page backfill per resource, resume after a simulated crash (job lost after commit, then `resumeStalledRuns`), one active run per connection and resource, each error class, stale job ignored, incremental runs advancing `updated_since`.
- **Contract:** a shared contract test suite every connector must pass (fake now, Shopify in 1b-3): pages are finite, cursors advance, items are normalized, no unknown fields leak.
- **Glue:** `RedisRateLimiter` and the BullMQ queue are tested only where Docker exists (skipped here, as with the Phase 0 worker test); `processSyncPage` carries the logic and is fully tested without Redis.

## 9. Risks and open items

- The Redis token bucket and BullMQ glue cannot be executed in the current dev environment (no Docker); they stay unverified until CI.
- Shopify's GraphQL cost-based limits are modelled generically (`cost` on a page, capacity and refill per platform); real numbers are set in 1b-2/1b-3 after reading the current Shopify docs.
- Currency: orders in a currency other than the org's reporting currency are stored with their original currency and excluded from metrics until an FX table exists.
- `sync_cursors.updated_since` uses the run start time, not the last item time, so a long-running page cannot miss updates made during the run; the next incremental run re-reads a small overlap that idempotent sinks absorb.
- Unmapped order lines (a variant sold that sync has not seen) are stored with `sku_id` null and linked later when the listing appears; the link-up pass is part of 1b-3.
