# Sync engine

Phase 1b-1 builds the machinery that moves data from a sales channel into our tables. No real platform is connected yet; the fake connector proves the engine end to end. Code lives in `packages/connectors` (contract, typed errors, credentials, registry, fake connector, contract suite), `packages/sync` (engine and sinks) and `apps/worker/src/sync` (BullMQ and Redis glue).

## 1. Overview

A sync is a chain of small page jobs. Each job fetches one page of one resource, writes it, and moves the cursor. Only ids travel through the queue; credentials never do (`parseSyncPageJob` is strict and rejects unknown keys).

```
enqueueSync (tx: create sync_runs row, set cursor to running)
   |  enqueue first page job after commit
   v
page job -> limiter.take -> connector.fetchPage(cursor)
   |
   v
one transaction: lock cursor row, compare-and-set check,
                 sink writes the page, cursor and run counters advance
   |
   +-- more pages: PageResult { kind: 'next', job }  -> worker enqueues next job
   |
   +-- last page: cursor complete, run succeeded, PageResult { kind: 'done', followUp? }
                  followUp = first job of the next resource in an `all` chain
```

The next job is enqueued only after the transaction commits, so a worker never sees a job for state that does not exist. The cursor never advances without its data because both change in the same transaction. If the process dies between commit and enqueue, `resumeStalledRuns` finds the cursor and re-enqueues it.

The compare-and-set: inside the transaction the cursor row is re-read with `FOR UPDATE`. If its status is no longer `running`, its `current_sync_run_id` differs from the job's, or its stored cursor differs from the cursor this job fetched with, the job is stale and returns `done` without writing. A duplicated or replayed job therefore cannot apply a page twice or move the cursor back.

`processSyncPage` also returns early with `done` when the connection or cursor is missing, or the cursor is not `running` for this run.

## 2. Tables

All tenant tables use RLS via `app_secure_tenant_table`, and every child references its parent with a composite `(org_id, id)` foreign key so a row can never point at another tenant's parent. Migrations 0007 to 0011.

- **Locations (`locations`).** Shopify locations (`source = 'shopify'`, with `store_connection_id` and `external_id`, enforced by a CHECK) and manual-count locations (no connection). Two partial unique indexes: `(org_id, store_connection_id, external_id)` where `external_id` is not null, and `(org_id, name)` where `store_connection_id` is null, so sync is idempotent and manual names do not collide.
- **Inventory (`inventory_levels`, `inventory_movements`).** One level row per `(org_id, sku_id, location_id)`. `on_hand` may go negative (oversold stores); `reserved` and `incoming` may not. `inventory_movements` is an append-only ledger: `app_user` has no UPDATE or DELETE on it and the table has no `updated_at`. Its foreign keys to `skus` and `locations` are `ON DELETE NO ACTION`, so deleting a SKU, a location or (through the locations cascade) a store connection that has movements is rejected rather than erasing history. Disconnecting a store must therefore be a status change, not a row delete. A partial unique index on `(org_id, ref_type, ref_id, sku_id, location_id, reason)` where `ref_id` is not null makes movement writes idempotent.
- **Listings (`sku_channel_listings`).** Links a SKU to an external variant on one connection. Unique `(org_id, store_connection_id, external_variant_id)`. This is how order lines and inventory find their SKU.
- **Orders (`orders`, `order_lines`).** Unique on `(org_id, store_connection_id, external_order_id)` and `(org_id, order_id, external_line_id)`. Money columns are bigint cents with non-negative CHECKs; `net_cents` may be negative. `order_lines.sku_id` is nullable (unmapped variant). `unit_cogs_cents_snapshot` is nullable (cost unknown). `refunded_quantity` is checked to be between 0 and `quantity`. `orders.customer_external_id` is an opaque id; there is no customers table yet.
- **Refunds (`refunds`, `refund_lines`).** Unique `(org_id, order_id, external_refund_id)` and `(org_id, refund_id, order_line_id)`. The orders sink recomputes `orders.refund_cents`, `net_cents` and `order_lines.refunded_quantity` from refunds in the same transaction.
- **Cursors (`sync_cursors`).** One row per `(org_id, store_connection_id, resource)`. Holds the page `cursor`, `status` (`idle`, `running`, `failed`, `complete`), `backfill_since`, the `updated_since` watermark, `current_sync_run_id`, `records_processed`, `last_synced_at` and `last_error`. The row is locked with `FOR UPDATE` when a run starts, which is what enforces one active run per connection and resource. Each run is also recorded in `sync_runs` (`connection_kind = 'store'`).
- `store_connections` gained `UNIQUE (org_id, id)` (migration 0007) to support the composite keys.

## 3. Writing a connector

Implement `StoreConnector` from `@erq/connectors`. The sync-relevant method is

```ts
fetchPage<R extends SyncResource>(ctx: ConnectionContext, resource: R, cursor: string | null, options: FetchOptions): Promise<Page<ResourceItems[R]>>
```

- `resource` is one of `locations`, `products`, `inventory`, `orders`. `cursor` is opaque to the engine; null means the first page. Return `{ items, nextCursor, cost? }`; `nextCursor: null` means the last page. Pages must be finite and the cursor must advance.
- `options.since` is set for backfills (only data from that date on). `options.updatedSince` is set for incremental runs (only data changed since). It is the previous run's start time.
- `ctx.credentials` is the decrypted credentials object. Never log it.
- Connectors never touch the database and no platform field may leave the package.

Normalization rules (types in `normalized.ts`):

- All money is integer cents. Currency is an ISO code on the variant or order.
- `NormalizedRefund.amountCents` excludes tax. `shippingRefundCents` is separate.
- All dates are `Date` objects, not strings.
- Customers appear only as an opaque `customerExternalId`. No names, emails or addresses.
- Each product, variant, inventory level and order carries `updatedAt`. It drives the ordering rule in section 4.
- `unitCostCents` on a variant is null when the platform has no cost.
- Order `channel` is `shopify_online` or `shopify_pos`; `isTest` marks test orders.

Typed errors (all exported from `@erq/connectors`), as handled by `processSyncPage`:

| Error | Effect |
|---|---|
| `RateLimitedError(retryAfterMs)` | Returns `delayed`. The worker enqueues the same job again after the delay. No retry attempt is consumed. |
| `TransientError`, and any unknown error | Rethrown. BullMQ retries (5 attempts, exponential backoff from 5 s). After the last attempt the worker marks the run failed. |
| `AuthError` | Cursor and run marked failed, `store_connections.status` set to `error` with the message. Returns `failed`. No retry. |
| `PermanentError` | Cursor and run marked failed. Returns `failed`. No retry. |

Stored error messages are truncated (500 characters) and must not contain credentials.

Testing: `@erq/connectors/testing` exports `FakeConnector` (scripted pages and errors, records calls), the sample data, and `runConnectorContract(subject)`, a shared Vitest suite every connector must pass (finite pages, advancing cursors, only the normalized fields, valid dates and integer cents). Register the connector with `ConnectorRegistry.register(platform, connector)`.

Credentials: encrypt with `encryptConnectionCredentials(credentials, keyProvider, connectionId)`. The AES-256-GCM additional authenticated data is `connection:<connectionId>` (`credentialsAad`), so a ciphertext cannot be moved to another connection. `decryptConnectionCredentials` returns null for a null column (demo connections) and turns any failure into an `AuthError` with a generic message.

## 4. Idempotency and ordering rules

- **Upserts on external ids.** Every write targets the unique external-id keys, so replaying a page changes nothing. Items are de-duplicated inside a page (latest `updatedAt` wins).
- **`external_updated_at` rule.** An existing row is overwritten only when the incoming `updatedAt` is greater than or equal to the stored `external_updated_at` (orders use a `setWhere` on the conflict update; products, listings and inventory compare before writing). An older update is skipped and counted as skipped.
- **Snapshot rule.** `order_lines.unit_cogs_cents_snapshot` is the landed cost per unit in effect on the order's date in the org timezone (`toOrgDate`), computed with the same `isCostInEffect` rule as `@erq/metrics`. It is null when no cost is in effect, a component is per-batch, or a component is in another currency; never silently zero. On conflict the sink uses `coalesce(existing, new)`, so a snapshot, once set, never changes when an order is re-synced. `repriceOrderLines(tx, { orgId, skuId, from? })` is the explicit way to recompute snapshots after costs are added or edited.
- **Cost import.** A variant's `unitCostCents` creates a `product_cost` component (per unit, effective from the backfill start date, or the sync date when there is none) only when the SKU has no `product_cost` component yet. Later Shopify cost changes are not applied automatically, and existing costs are never overwritten.
- **Movement derivation.** The inventory sink writes the level, then a `sync_correction` movement with `delta = onHand - previous on_hand` when it is non-zero. Its `ref_id` is `<syncRunId>:<updatedAt ISO>`, so a replay inserts nothing new.
- **Unmapped variants.** An inventory level whose variant or location is not known yet is skipped. An order line whose variant has no listing is stored with `sku_id` null; a later re-sync of that order links it (`coalesce(excluded.sku_id, existing)`). Syncing resources in the order locations, products, inventory, orders avoids most of these.
- **Products.** A new variant is matched to an existing SKU by `sku_code` (or `shopify-<variantId>` when it has none) before a SKU is created. A product with no variants is skipped.

## 5. Operations

`enqueueSync(deps, { orgId, connectionId, resources, mode, since? })`:

- `resources` is a list or `'all'`. The requested resources always run in dependency order: locations, products, inventory, orders. Only the first starts now; the rest travel in the job's `then` chain and start when the previous one finishes.
- `mode` is `backfill` (requires `since`; resets the cursor and sets `backfill_since`) or `incremental` (uses the stored `updated_since`).
- One active run per connection and resource: if the cursor is already `running`, the existing run id is returned with `started: false`.
- On completion the cursor's `updated_since` is set to the run's start time, so the next incremental run re-reads a small overlap that the idempotent sinks absorb.

`resumeStalledRuns(deps, olderThan)` calls the SECURITY DEFINER function `app_list_stalled_sync_cursors` and re-enqueues cursors still `running` whose `updated_at` is older than the threshold, continuing from the stored cursor. The worker schedules it every 5 minutes with a 10 minute stall threshold (`scheduleResumeStalled`, job `resume-stalled`).

Rate limiting: the engine calls `limiter.take(key, cost, policy)` before each fetch with key `<platform>:<connectionId>`. `RATE_LIMIT_POLICIES` currently holds a generic placeholder for `shopify` (capacity 10, refill 2 per second, cost 1 per page), and unknown platforms use the same default. Real per-platform numbers are set in 1b-2 and 1b-3 after reading each platform's current documentation. `RedisRateLimiter` is an atomic token bucket in a Lua script that uses the Redis clock. A `MemoryRateLimiter` serves tests.

Queue: `BullMqJobQueue` adds jobs named `page` to the `sync` queue with 5 attempts, exponential backoff starting at 5 s, and retention of the last 1000 completed and 5000 failed jobs. A `delayed` result is enqueued again as a delayed job. `createSyncWorker` runs jobs through `handleSyncJob`, which rejects invalid payloads with `UnrecoverableError`. When the last attempt fails (or the error is unrecoverable) the worker calls `failSyncRun` so the owner sees the failure. Concurrency comes from `SYNC_CONCURRENCY` (default 5).

## 6. Known gaps and limitations

- **Unverified until CI with Docker:** the Redis rate limiter, the BullMQ queue and the sync worker. Their tests are skipped without Redis. The engine itself is fully tested on Postgres without them.
- **One currency per org.** Orders in another currency are stored with their currency but there is no FX table. A cost in another currency than the order gives a null snapshot.
- **No customers table.** Only the opaque `customer_external_id` on orders. Customers arrive in Phase 2.
- **The `all` chain is not persisted.** The remaining resources live only in the job's `then` field. `resumeStalledRuns` finishes only the interrupted resource, and the rest of the chain is lost. The chain is also dropped silently when the next resource already has an active run.
- **Delayed jobs can duplicate.** A `delayed` (rate-limited) result is enqueued as a new job and there is no deterministic BullMQ `jobId`, so duplicate jobs are possible. The cursor compare-and-set makes them harmless; the cost is duplicate connector calls.
- **Inventory deltas need serialized runs.** Movement derivation reads the previous level before writing, without a row lock. It is correct only because one active run per connection and resource serializes writers; do not add another writer for the same levels without locking.
- **Database error handling is coarse.** Any SQLSTATE 22xxx or 23xxx error raised while writing a page is treated as permanent and fails the run, even if a retry could succeed. Any other error outside the connector call (for example a database outage while loading the connection) is rethrown and retried by BullMQ. Decrypt failures and unregistered platforms are thrown inside the fetch step, where `AuthError` and `PermanentError` fail the run without a retry.
- **`app_list_stalled_sync_cursors` must never be exposed through an API route.** It is the one intentional cross-tenant read and is for the worker only.
- **Connection status is not checked before syncing.** A connection already in `error` or disabled still syncs if a job is enqueued.
- **Late-linked order lines keep a null cost snapshot.** An order line synced before its variant's listing exists keeps `sku_id` null and a null cost snapshot until that order re-syncs. There is no relink pass yet, so COGS is understated until then.
- **Connection health is recorded at the end of a chain.** When the last page of a chain completes, `store_connections.last_synced_at` is set and an `error` connection returns to `active` (only if none of its resources is still running or has failed). This includes single-resource runs, so `last_synced_at` can be set by a run that synced one resource only (revisit in 1b-3c).
- **A resumed chain records no connection health.** `resumeStalledRuns` marks its jobs `resumed` because the chain is not persisted (1b-3c), so a resumed run never sets `last_synced_at` or recovers an errored connection.
- **An outdated `last_error` can stay visible.** The recovery guard leaves the connection in `error` while another resource's cursor is `failed`, until that resource is re-run successfully.
- **A failing job never changes a disconnected or demo connection.** Only `active`, `pending` and `error` connections are flagged `error`.
- **`updated_since` has no overlap margin.** The incremental watermark is the worker clock at run start, so clock skew or late-arriving platform updates can be missed.
- **Rate-limit numbers are placeholders** until 1b-2 and 1b-3.

## 7. Webhook events handoff (from 1b-2)

1b-2 stores every verified Shopify webhook in `webhook_events` (deduplicated on connection and webhook id), but subscribes each shop to `app/uninstalled` only. The data topics (`orders/create`, `orders/updated`, `orders/cancelled`, `refunds/create`, `products/create|update|delete`, `inventory_levels/update`, exported as `SHOPIFY_FUTURE_DATA_WEBHOOK_TOPICS`) are not subscribed; one that arrives anyway is marked `deferred` with its `payload` replaced by `{}`. 1b-3 subscribes to them (after Shopify's protected customer data approval) together with consuming them: apply them through the existing sinks or use them as a trigger for an incremental sync, mark them `processed`, stop emptying the payload of topics it consumes, and decide a retention policy since payloads carry customer data. Webhooks do not replace the incremental sync: a missed event is only recovered by the next sync. See `docs/shopify-connection.md` for statuses, the sweep and known gaps.
