# eRetailQuery Phase 1b-1: Sync Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the order, inventory and location data model, the page-based connector contract with a fake connector, and the resumable, idempotent sync engine that later Shopify sub-projects plug into.

**Architecture:** New tenant tables (RLS, composite foreign keys) in `@erq/db`. A reworked `@erq/connectors` contract (normalized types, typed errors, credential decryption, registry, fake connector, shared contract tests). A new `@erq/sync` package holds the engine: idempotent sinks per resource, cost snapshots, a page-job processor that commits data and cursor in one transaction, and ports for the queue and rate limiter. `apps/worker` supplies the BullMQ and Redis implementations of those ports.

**Tech Stack:** TypeScript strict, Drizzle ORM + drizzle-kit, Postgres (embedded in dev, Testcontainers in CI), Vitest, BullMQ + ioredis, `@erq/shared`, `@erq/metrics`.

**Spec:** `docs/superpowers/specs/2026-10-06-phase1b1-sync-foundations-design.md` (product rules: `CLAUDE.md`)

## Global Constraints

- Money is `bigint` cents (Drizzle `mode: 'number'`) plus a `currency char(3)` column. Never floats for money.
- Every tenant table: `id uuid`, `org_id`, `created_at`, `updated_at` (append-only `inventory_movements` has no `updated_at`), RLS enabled and forced through `app_secure_tenant_table`, composite `(org_id, id)` foreign keys to tenant parents, and a fixture in `packages/db/test/fixtures.ts`. The isolation suite must pass and must fail for a table without RLS or a fixture.
- Migrations only through Drizzle: generated SQL is never hand-edited; custom migrations (`drizzle-kit generate --custom`) hold RLS calls and functions. New SECURITY DEFINER functions set `search_path = pg_catalog, public, pg_temp`, revoke EXECUTE from PUBLIC, grant to `app_user` only, and revoke from `anon`/`authenticated` when those roles exist.
- All sync database access goes through `withTenant(orgId, ...)`. The unscoped admin client is never used in `packages/sync` or `apps/worker`.
- Connectors never touch the database; platform-specific fields never leave `packages/connectors`.
- Credentials are never logged and never appear in job data or `last_error`; only ids travel through queues.
- Sinks are idempotent: upserts on external-id unique keys, and an existing row is overwritten only when the incoming `external_updated_at` is greater than or equal to the stored one.
- A cursor never advances without the data it covers: data and cursor commit in the same transaction; the next job is enqueued after commit.
- Cost snapshots are `null` when the cost is unknown, never zero.
- TypeScript strict, no `any` without a comment. Config files use `.mts`. Packages build to CJS with tsup.
- Drizzle wraps driver errors: for assertions on errors thrown through Drizzle use `.rejects.toMatchObject({ cause: { message: expect.stringMatching(/.../) } })`; raw `pg` errors use `.rejects.toThrow(/.../)`.
- In SQL fixtures and tests, when a parameter is used both as a `uuid` value and inside a text expression, cast it: `($1::uuid)::text`.
- Disk is small: run one package's tests at a time (`pnpm turbo run test --filter=@erq/<pkg>`), never the whole monorepo in parallel. Docker is not available in this environment: database tests use the embedded-Postgres fallback; Redis/BullMQ tests are skipped here and run in CI.
- Test `afterAll` blocks use optional chaining for resources created in `beforeAll`.
- Conventional Commits, one task per commit. Every commit message ends with exactly `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Plan-level clarifications where the spec is silent or this plan refines it (Task 14 records them in the spec):
  1. Shopify's cost per item is written as a `product_cost` component only when the SKU has no `product_cost` component yet; later Shopify cost changes are not applied automatically (the owner manages costs after import).
  2. `RateLimiter.take(key, cost, policy)` takes the policy per call.
  3. `SyncPageJob` also carries `then` (remaining resources, mode, since) so an `all` sync runs resources sequentially in dependency order (locations, products, inventory, orders).
  4. Cross-tenant discovery of stalled runs uses a SECURITY DEFINER function `app_list_stalled_sync_cursors(timestamptz)`.
  5. `NormalizedRefund.amountCents` is the refunded amount excluding tax; `orders.refund_cents` is the sum of refund `amountCents`.
  6. Order dates for cost snapshots are computed in the org's timezone.

## Review Focus

Failure modes the spec implies but no happy-path test would catch; each has a pinning test in the task named.

1. A page job whose ids belong to another tenant must read and write nothing (RLS), and the stalled-run function must be the only cross-tenant read (Tasks 2, 11, 12).
2. Replaying a page, or receiving an older update after a newer one, must not duplicate rows, duplicate inventory movements, or regress data (Tasks 8, 9, 10, 12).
3. A crash between commit and enqueue must be recoverable from the stored cursor with no lost or duplicated records (Tasks 11, 12).
4. Unmapped variants and locations must be skipped or stored with a null SKU, never crash a page (Tasks 9, 10).
5. COGS snapshots use the order date in the org's timezone and are `null` (not zero) when the cost is unknown, per-batch, or in another currency (Task 7).

## File Structure

```
packages/db/
  src/schema/inventory.ts       locations, inventory_levels, inventory_movements, sku_channel_listings
  src/schema/orders.ts          orders, order_lines, refunds, refund_lines, sync_cursors
  src/schema/connections.ts     + UNIQUE (org_id, id) on store_connections
  migrations/0007-0010          generated schema + custom RLS and stalled-run function
  test/fixtures.ts              + fixtures; test/inventory-schema.test.ts, orders-schema.test.ts
packages/metrics/src/pricing.ts + isCostInEffect
packages/connectors/
  src/normalized.ts errors.ts credentials.ts registry.ts types.ts index.ts
  src/testing/fake-connector.ts contract.ts sample-data.ts index.ts   (subpath @erq/connectors/testing)
packages/sync/
  src/ports.ts policies.ts memory.ts cogs.ts index.ts
  src/sinks/{context,util,locations,products,inventory,orders}.ts
  src/engine/{start,process,fail,resume}.ts
  test/helpers.ts + one test file per unit
apps/worker/src/sync/{bullmq-queue,redis-rate-limiter,handler,worker}.ts ; main.ts wiring
docs/sync.md
```

---

### Task 1: Inventory, locations and channel listings (schema, migrations, fixtures)

**Files:**
- Create: `packages/db/src/schema/inventory.ts`
- Modify: `packages/db/src/schema/connections.ts` (add `UNIQUE (org_id, id)` to `store_connections`), `packages/db/src/schema/index.ts`
- Create: migrations `0007_sync_inventory.sql` (generated), `0008_sync_inventory_rls.sql` (custom)
- Modify: `packages/db/test/fixtures.ts`, `packages/db/test/isolation.test.ts`
- Test: `packages/db/test/inventory-schema.test.ts`

**Interfaces:**
- Produces (from `@erq/db`): tables `locations`, `inventoryLevels`, `inventoryMovements`, `skuChannelListings`; enums `locationType`, `locationSource`, `movementReason`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/db/test/fixtures.ts`: change the existing `store_connections` fixture to use a deterministic id, and append the new fixtures after `sku_cost_components` (parents before children):

```ts
  store_connections: (q, org) =>
    q.query(
      `insert into store_connections (id, org_id, platform, external_account_id, status)
       values ($1, $1, 'shopify', 'shop-' || ($1::uuid)::text, 'demo')`,
      [org],
    ),
```

```ts
  locations: (q, org) =>
    q.query(
      `insert into locations (id, org_id, store_connection_id, external_id, name, type, source)
       values ($1, $1, $1, 'loc-' || ($1::uuid)::text, 'Main warehouse', 'warehouse', 'shopify')`,
      [org],
    ),
  inventory_levels: (q, org) =>
    q.query(`insert into inventory_levels (org_id, sku_id, location_id, on_hand) values ($1, $1, $1, 5)`, [org]),
  inventory_movements: (q, org) =>
    q.query(
      `insert into inventory_movements (org_id, sku_id, location_id, delta, reason) values ($1, $1, $1, 5, 'adjustment')`,
      [org],
    ),
  sku_channel_listings: (q, org) =>
    q.query(
      `insert into sku_channel_listings (org_id, sku_id, store_connection_id, external_product_id, external_variant_id)
       values ($1, $1, $1, 'p-1', 'v-1')`,
      [org],
    ),
```

(The `store_connections` fixture is replaced in place; keep its position. Other tests that insert `store_connections` fixtures keep working because they only depend on the table having a row.)

In `packages/db/test/isolation.test.ts`, wherever the suite special-cases `audit_log` as append-only (`APPEND_ONLY` and the places that skip `audit_log` for the update/delete, WITH CHECK and positive-control cases), add `inventory_movements` to the same set or condition. `inventory_movements` also has no `updated_at`.

`packages/db/test/inventory-schema.test.ts`:

```ts
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenantDb, type TenantDb } from '../src';
import { startTestDatabase, type TestDatabase } from '../src/testing';
import { fixtures } from './fixtures';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let tdb: TestDatabase;
let owner: Pool;
let db: TenantDb;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  for (const org of [A, B]) for (const f of Object.values(fixtures)) await f(owner, org);
  db = createTenantDb(tdb.appUrl);
});
afterAll(async () => {
  await db?.close();
  await owner?.end();
  await tdb?.stop();
});

const asB = (text: string) => db.withTenant(B, (tx) => tx.execute(sql.raw(text)));
const fk = { cause: { message: expect.stringMatching(/foreign key constraint/) } };

describe('cross-tenant references are rejected by composite foreign keys', () => {
  it("a tenant-B location cannot use tenant A's store connection", async () => {
    await expect(
      asB(`insert into locations (org_id, store_connection_id, external_id, name, source) values ('${B}', '${A}', 'x', 'n', 'shopify')`),
    ).rejects.toMatchObject(fk);
  });
  it("a tenant-B inventory level cannot use tenant A's sku or location", async () => {
    await expect(asB(`insert into inventory_levels (org_id, sku_id, location_id, on_hand) values ('${B}', '${A}', '${B}', 1)`)).rejects.toMatchObject(fk);
    await expect(asB(`insert into inventory_levels (org_id, sku_id, location_id, on_hand) values ('${B}', '${B}', '${A}', 1)`)).rejects.toMatchObject(fk);
  });
  it("a tenant-B listing cannot use tenant A's sku or connection", async () => {
    await expect(asB(`insert into sku_channel_listings (org_id, sku_id, store_connection_id, external_product_id, external_variant_id) values ('${B}', '${A}', '${B}', 'p', 'v2')`)).rejects.toMatchObject(fk);
    await expect(asB(`insert into sku_channel_listings (org_id, sku_id, store_connection_id, external_product_id, external_variant_id) values ('${B}', '${B}', '${A}', 'p', 'v3')`)).rejects.toMatchObject(fk);
  });
});

describe('locations', () => {
  it('requires connection and external id for shopify locations', async () => {
    await expect(owner.query(`insert into locations (org_id, name, source) values ($1, 'Bad', 'shopify')`, [A])).rejects.toThrow(/locations_shopify_ids/);
  });
  it('rejects a duplicate external id per connection', async () => {
    await expect(
      owner.query(`insert into locations (org_id, store_connection_id, external_id, name, source) values ($1, $1, 'loc-' || ($1::uuid)::text, 'Dup', 'shopify')`, [A]),
    ).rejects.toThrow(/locations_external_uq|duplicate key/);
  });
  it('allows manual locations and rejects a duplicate manual name per org', async () => {
    await owner.query(`insert into locations (org_id, name, type, source) values ($1, 'Garage', 'other', 'manual')`, [A]);
    await expect(owner.query(`insert into locations (org_id, name, type, source) values ($1, 'Garage', 'other', 'manual')`, [A])).rejects.toThrow(/locations_manual_name_uq|duplicate key/);
    await owner.query(`insert into locations (org_id, name, type, source) values ($1, 'Garage', 'other', 'manual')`, [B]); // other org is fine
  });
});

describe('inventory_levels', () => {
  it('allows negative on_hand (oversold stores) but not negative reserved or incoming', async () => {
    const { rows } = await owner.query(`insert into locations (org_id, name, source) values ($1, 'Shelf', 'manual') returning id`, [A]);
    const loc = rows[0].id as string;
    await owner.query(`insert into inventory_levels (org_id, sku_id, location_id, on_hand) values ($1, $1, $2, -3)`, [A, loc]);
    await expect(owner.query(`insert into inventory_levels (org_id, sku_id, location_id, on_hand, reserved) values ($1, $1, $1, 1, -1)`, [A])).rejects.toThrow(/inventory_levels_nonneg|duplicate key/);
  });
  it('is unique per sku and location', async () => {
    await expect(owner.query(`insert into inventory_levels (org_id, sku_id, location_id, on_hand) values ($1, $1, $1, 9)`, [A])).rejects.toThrow(/inventory_levels_org_sku_loc_uq|duplicate key/);
  });
});

describe('inventory_movements (append-only ledger)', () => {
  it('rejects a zero delta', async () => {
    await expect(owner.query(`insert into inventory_movements (org_id, sku_id, location_id, delta, reason) values ($1, $1, $1, 0, 'adjustment')`, [A])).rejects.toThrow(/inventory_movements_delta_nonzero/);
  });
  it('is idempotent on a reference and allows repeated null references', async () => {
    const ins = `insert into inventory_movements (org_id, sku_id, location_id, delta, reason, ref_type, ref_id) values ($1, $1, $1, 1, 'sync_correction', 'sync', $2)`;
    await owner.query(ins, [A, 'run-1']);
    await expect(owner.query(ins, [A, 'run-1'])).rejects.toThrow(/inventory_movements_ref_uq|duplicate key/);
    const plain = `insert into inventory_movements (org_id, sku_id, location_id, delta, reason) values ($1, $1, $1, 1, 'adjustment')`;
    await owner.query(plain, [A]);
    await owner.query(plain, [A]);
  });
  it('lets app_user insert but never update or delete', async () => {
    await db.withTenant(A, (tx) => tx.execute(sql.raw(`insert into inventory_movements (org_id, sku_id, location_id, delta, reason) values ('${A}', '${A}', '${A}', 2, 'restock')`)));
    const denied = { cause: { message: expect.stringMatching(/permission denied/) } };
    await expect(db.withTenant(A, (tx) => tx.execute(sql.raw(`update inventory_movements set delta = 9`)))).rejects.toMatchObject(denied);
    await expect(db.withTenant(A, (tx) => tx.execute(sql.raw(`delete from inventory_movements`)))).rejects.toMatchObject(denied);
  });
});

describe('sku_channel_listings', () => {
  it('rejects a negative channel price and a duplicate variant per connection', async () => {
    await expect(owner.query(`insert into sku_channel_listings (org_id, sku_id, store_connection_id, external_product_id, external_variant_id, channel_price_cents) values ($1, $1, $1, 'p', 'v-neg', -1)`, [A])).rejects.toThrow(/check/);
    await expect(owner.query(`insert into sku_channel_listings (org_id, sku_id, store_connection_id, external_product_id, external_variant_id) values ($1, $1, $1, 'p', 'v-1')`, [A])).rejects.toThrow(/sku_channel_listings_variant_uq|duplicate key/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm turbo run test --filter=@erq/db -- inventory-schema isolation`
Expected: FAIL (relations `locations`, `inventory_levels`, ... do not exist).

- [ ] **Step 3: Write the schema**

In `packages/db/src/schema/connections.ts`, in the `storeConnections` table's extra-config array add `unique('store_connections_org_id_uq').on(t.orgId, t.id)`.

`packages/db/src/schema/inventory.ts`:

```ts
import { sql } from 'drizzle-orm';
import {
  bigint, boolean, char, check, foreignKey, index, integer, pgEnum, pgTable, text, timestamp, unique, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import { skus } from './catalog';
import { storeConnections } from './connections';
import { tenantId } from './tenant';
import { timestamps } from './timestamps';

export const locationType = pgEnum('location_type', ['warehouse', 'store', '3pl', 'fba', 'other']);
export const locationSource = pgEnum('location_source', ['shopify', 'manual']);
export const movementReason = pgEnum('movement_reason', [
  'sale', 'return', 'restock', 'adjustment', 'count', 'sync_correction',
]);

export const locations = pgTable(
  'locations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    storeConnectionId: uuid('store_connection_id'),
    externalId: text('external_id'),
    name: text('name').notNull(),
    type: locationType('type').notNull().default('warehouse'),
    address: text('address'),
    source: locationSource('source').notNull().default('manual'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    unique('locations_org_id_uq').on(t.orgId, t.id),
    foreignKey({ columns: [t.orgId, t.storeConnectionId], foreignColumns: [storeConnections.orgId, storeConnections.id] }).onDelete('cascade'),
    uniqueIndex('locations_external_uq').on(t.orgId, t.storeConnectionId, t.externalId).where(sql`${t.externalId} is not null`),
    uniqueIndex('locations_manual_name_uq').on(t.orgId, t.name).where(sql`${t.storeConnectionId} is null`),
    check('locations_shopify_ids', sql`${t.source} <> 'shopify' or (${t.storeConnectionId} is not null and ${t.externalId} is not null)`),
  ],
);

export const inventoryLevels = pgTable(
  'inventory_levels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    skuId: uuid('sku_id').notNull(),
    locationId: uuid('location_id').notNull(),
    /** May be negative: stores can oversell. */
    onHand: integer('on_hand').notNull(),
    reserved: integer('reserved').notNull().default(0),
    incoming: integer('incoming').notNull().default(0),
    reorderPoint: integer('reorder_point'),
    safetyStock: integer('safety_stock'),
    countedAt: timestamp('counted_at', { withTimezone: true }),
    externalUpdatedAt: timestamp('external_updated_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique('inventory_levels_org_sku_loc_uq').on(t.orgId, t.skuId, t.locationId),
    foreignKey({ columns: [t.orgId, t.skuId], foreignColumns: [skus.orgId, skus.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.orgId, t.locationId], foreignColumns: [locations.orgId, locations.id] }).onDelete('cascade'),
    check('inventory_levels_nonneg', sql`${t.reserved} >= 0 and ${t.incoming} >= 0 and (${t.reorderPoint} is null or ${t.reorderPoint} >= 0) and (${t.safetyStock} is null or ${t.safetyStock} >= 0)`),
    index('inventory_levels_org_loc_idx').on(t.orgId, t.locationId),
  ],
);

export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    skuId: uuid('sku_id').notNull(),
    locationId: uuid('location_id').notNull(),
    delta: integer('delta').notNull(),
    reason: movementReason('reason').notNull(),
    refType: text('ref_type'),
    refId: text('ref_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.skuId], foreignColumns: [skus.orgId, skus.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.orgId, t.locationId], foreignColumns: [locations.orgId, locations.id] }).onDelete('cascade'),
    check('inventory_movements_delta_nonzero', sql`${t.delta} <> 0`),
    uniqueIndex('inventory_movements_ref_uq')
      .on(t.orgId, t.refType, t.refId, t.skuId, t.locationId, t.reason)
      .where(sql`${t.refId} is not null and ${t.refType} is not null`),
    index('inventory_movements_org_sku_time_idx').on(t.orgId, t.skuId, t.occurredAt),
  ],
);

export const skuChannelListings = pgTable(
  'sku_channel_listings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    skuId: uuid('sku_id').notNull(),
    storeConnectionId: uuid('store_connection_id').notNull(),
    externalProductId: text('external_product_id').notNull(),
    externalVariantId: text('external_variant_id').notNull(),
    channelPriceCents: bigint('channel_price_cents', { mode: 'number' }),
    currency: char('currency', { length: 3 }).notNull().default('USD'),
    externalUpdatedAt: timestamp('external_updated_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique('sku_channel_listings_variant_uq').on(t.orgId, t.storeConnectionId, t.externalVariantId),
    foreignKey({ columns: [t.orgId, t.skuId], foreignColumns: [skus.orgId, skus.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.orgId, t.storeConnectionId], foreignColumns: [storeConnections.orgId, storeConnections.id] }).onDelete('cascade'),
    check('sku_channel_listings_price_nonneg', sql`${t.channelPriceCents} is null or ${t.channelPriceCents} >= 0`),
    index('sku_channel_listings_org_sku_idx').on(t.orgId, t.skuId),
  ],
);
```

Append `export * from './inventory';` to `packages/db/src/schema/index.ts`.

- [ ] **Step 4: Generate migrations and write the RLS migration**

```bash
cd packages/db
pnpm drizzle-kit generate --name=sync_inventory
pnpm drizzle-kit generate --custom --name=sync_inventory_rls
cd ../..
```

Expected: `0007_sync_inventory.sql` (generated; contains the `store_connections` unique constraint, the three enums, four tables) and an empty `0008_sync_inventory_rls.sql`. Fill the latter:

```sql
SELECT app_secure_tenant_table('locations');
--> statement-breakpoint
SELECT app_secure_tenant_table('inventory_levels');
--> statement-breakpoint
SELECT app_secure_tenant_table('inventory_movements', 'org_id', false);
--> statement-breakpoint
REVOKE UPDATE, DELETE ON inventory_movements FROM app_user;
--> statement-breakpoint
SELECT app_secure_tenant_table('sku_channel_listings');
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm turbo run test typecheck build --filter=@erq/db` then `pnpm lint`
Expected: PASS, including the isolation suite iterating the four new tables.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(db): add locations, inventory levels and movements, and channel listings with RLS"
```

---

### Task 2: Orders, refunds, sync cursors and the stalled-run function

**Files:**
- Create: `packages/db/src/schema/orders.ts`; migrations `0009_sync_orders.sql` (generated), `0010_sync_orders_rls.sql` (custom)
- Modify: `packages/db/src/schema/index.ts`, `packages/db/test/fixtures.ts`
- Test: `packages/db/test/orders-schema.test.ts`

**Interfaces:**
- Consumes: Task 1 tables; `tenantId`, `timestamps`.
- Produces (from `@erq/db`): tables `orders`, `orderLines`, `refunds`, `refundLines`, `syncCursors`; enums `salesChannel`, `orderStatus`, `syncResource`, `cursorStatus`; SQL function `app_list_stalled_sync_cursors(p_older_than timestamptz) returns table (o_org_id uuid, o_store_connection_id uuid, o_resource sync_resource, o_sync_run_id uuid)`.

- [ ] **Step 1: Write the failing tests**

Append to `fixtures.ts` after the Task 1 fixtures:

```ts
  orders: (q, org) =>
    q.query(
      `insert into orders (id, org_id, store_connection_id, external_order_id, channel, status, placed_at, currency,
                           gross_cents, discount_cents, shipping_charged_cents, tax_cents, refund_cents, net_cents, external_updated_at)
       values ($1, $1, $1, 'o-' || ($1::uuid)::text, 'shopify_online', 'open', now(), 'USD', 1000, 0, 0, 0, 0, 1000, now())`,
      [org],
    ),
  order_lines: (q, org) =>
    q.query(
      `insert into order_lines (id, org_id, order_id, sku_id, external_line_id, title, quantity, unit_price_cents)
       values ($1, $1, $1, $1, 'line-1', 'Widget', 1, 1000)`,
      [org],
    ),
  refunds: (q, org) =>
    q.query(
      `insert into refunds (id, org_id, order_id, external_refund_id, refunded_at, amount_cents) values ($1, $1, $1, 'r-1', now(), 100)`,
      [org],
    ),
  refund_lines: (q, org) =>
    q.query(`insert into refund_lines (org_id, refund_id, order_line_id, quantity, amount_cents) values ($1, $1, $1, 1, 100)`, [org]),
  sync_cursors: (q, org) =>
    q.query(`insert into sync_cursors (org_id, store_connection_id, resource, status) values ($1, $1, 'orders', 'idle')`, [org]),
```

`packages/db/test/orders-schema.test.ts` (same setup block as `inventory-schema.test.ts`: embedded DB, owner pool, fixtures for A and B, `db`):

```ts
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenantDb, type TenantDb } from '../src';
import { startTestDatabase, type TestDatabase } from '../src/testing';
import { fixtures } from './fixtures';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let tdb: TestDatabase;
let owner: Pool;
let db: TenantDb;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  for (const org of [A, B]) for (const f of Object.values(fixtures)) await f(owner, org);
  db = createTenantDb(tdb.appUrl);
});
afterAll(async () => {
  await db?.close();
  await owner?.end();
  await tdb?.stop();
});

const fk = { cause: { message: expect.stringMatching(/foreign key constraint/) } };
const asB = (text: string) => db.withTenant(B, (tx) => tx.execute(sql.raw(text)));
const orderInsert = (id: string, ext: string, extra = '') =>
  `insert into orders (org_id, store_connection_id, external_order_id, channel, status, placed_at, currency, gross_cents, discount_cents,
     shipping_charged_cents, tax_cents, refund_cents, net_cents, external_updated_at ${extra ? ',' + extra.split('=')[0] : ''})
   values ('${id}', '${id}', '${ext}', 'shopify_pos', 'open', now(), 'USD', 100, 0, 0, 0, 0, 100, now() ${extra ? ',' + extra.split('=')[1] : ''})`;

describe('orders', () => {
  it('stores the POS channel, allows negative net sales, rejects negative money fields', async () => {
    await owner.query(orderInsert(A, 'pos-1'));
    await owner.query(`insert into orders (org_id, store_connection_id, external_order_id, channel, status, placed_at, currency, gross_cents,
      discount_cents, shipping_charged_cents, tax_cents, refund_cents, net_cents, external_updated_at)
      values ($1, $1, 'neg-net', 'shopify_online', 'closed', now(), 'USD', 100, 0, 0, 0, 500, -400, now())`, [A]);
    await expect(owner.query(`insert into orders (org_id, store_connection_id, external_order_id, channel, status, placed_at, currency, gross_cents,
      discount_cents, shipping_charged_cents, tax_cents, refund_cents, net_cents, external_updated_at)
      values ($1, $1, 'neg-money', 'shopify_online', 'open', now(), 'USD', 100, -1, 0, 0, 0, 100, now())`, [A])).rejects.toThrow(/orders_money_nonneg/);
  });
  it('is unique per connection and external order id', async () => {
    await expect(owner.query(orderInsert(A, 'pos-1'))).rejects.toThrow(/orders_external_uq|duplicate key/);
  });
  it('rejects unknown channels and statuses', async () => {
    await expect(owner.query(orderInsert(A, 'x').replace('shopify_pos', 'carrier_pigeon'))).rejects.toThrow(/invalid input value for enum/);
  });
  it("a tenant-B order cannot use tenant A's store connection", async () => {
    await expect(asB(orderInsert(B, 'ok').replace(`'${B}', 'ok'`, `'${A}', 'ok'`))).rejects.toMatchObject(fk);
  });
});

describe('order_lines', () => {
  it('requires a positive quantity and refunded_quantity within quantity', async () => {
    await expect(owner.query(`insert into order_lines (org_id, order_id, sku_id, external_line_id, title, quantity, unit_price_cents) values ($1, $1, $1, 'q0', 'x', 0, 1)`, [A])).rejects.toThrow(/order_lines_quantity_positive/);
    await expect(owner.query(`insert into order_lines (org_id, order_id, sku_id, external_line_id, title, quantity, unit_price_cents, refunded_quantity) values ($1, $1, $1, 'q1', 'x', 1, 1, 2)`, [A])).rejects.toThrow(/order_lines_refunded_within_quantity/);
  });
  it('allows an unmapped (null) sku and rejects negative money', async () => {
    await owner.query(`insert into order_lines (org_id, order_id, sku_id, external_line_id, title, quantity, unit_price_cents) values ($1, $1, null, 'unmapped', 'x', 1, 1)`, [A]);
    await expect(owner.query(`insert into order_lines (org_id, order_id, external_line_id, title, quantity, unit_price_cents, unit_cogs_cents_snapshot) values ($1, $1, 'negc', 'x', 1, 1, -1)`, [A])).rejects.toThrow(/check/);
  });
  it('is unique per order and external line id', async () => {
    await expect(owner.query(`insert into order_lines (org_id, order_id, external_line_id, title, quantity, unit_price_cents) values ($1, $1, 'line-1', 'x', 1, 1)`, [A])).rejects.toThrow(/order_lines_external_uq|duplicate key/);
  });
  it("a tenant-B line cannot use tenant A's order or sku", async () => {
    await expect(asB(`insert into order_lines (org_id, order_id, sku_id, external_line_id, title, quantity, unit_price_cents) values ('${B}', '${A}', '${B}', 'zz', 'x', 1, 1)`)).rejects.toMatchObject(fk);
    await expect(asB(`insert into order_lines (org_id, order_id, sku_id, external_line_id, title, quantity, unit_price_cents) values ('${B}', '${B}', '${A}', 'zy', 'x', 1, 1)`)).rejects.toMatchObject(fk);
  });
});

describe('refunds and refund_lines', () => {
  it('are unique per order/refund and per refund/line, with positive quantities', async () => {
    await expect(owner.query(`insert into refunds (org_id, order_id, external_refund_id, refunded_at, amount_cents) values ($1, $1, 'r-1', now(), 1)`, [A])).rejects.toThrow(/refunds_external_uq|duplicate key/);
    await expect(owner.query(`insert into refund_lines (org_id, refund_id, order_line_id, quantity, amount_cents) values ($1, $1, $1, 1, 1)`, [A])).rejects.toThrow(/refund_lines_uq|duplicate key/);
    await expect(owner.query(`insert into refund_lines (org_id, refund_id, order_line_id, quantity, amount_cents) values ($1, $1, $1, 0, 1)`, [B])).rejects.toThrow(/duplicate key|refund_lines_quantity_positive/);
  });
  it("a tenant-B refund cannot reference tenant A's order", async () => {
    await expect(asB(`insert into refunds (org_id, order_id, external_refund_id, refunded_at, amount_cents) values ('${B}', '${A}', 'rx', now(), 1)`)).rejects.toMatchObject(fk);
  });
});

describe('sync_cursors', () => {
  it('is unique per connection and resource and rejects unknown resources', async () => {
    await expect(owner.query(`insert into sync_cursors (org_id, store_connection_id, resource, status) values ($1, $1, 'orders', 'idle')`, [A])).rejects.toThrow(/sync_cursors_uq|duplicate key/);
    await expect(owner.query(`insert into sync_cursors (org_id, store_connection_id, resource, status) values ($1, $1, 'customers', 'idle')`, [A])).rejects.toThrow(/invalid input value for enum/);
    await owner.query(`insert into sync_cursors (org_id, store_connection_id, resource, status) values ($1, $1, 'products', 'idle')`, [A]);
  });
});

describe('app_list_stalled_sync_cursors (the only cross-tenant read)', () => {
  beforeAll(async () => {
    // Backdate with INSERT: the updated_at trigger overwrites updated_at on UPDATE.
    for (const org of [A, B]) {
      await owner.query(
        `insert into sync_cursors (org_id, store_connection_id, resource, status, current_sync_run_id, updated_at)
         values ($1, $1, 'locations', 'running', gen_random_uuid(), now() - interval '2 hours')`, [org]);
    }
    await owner.query(`insert into sync_cursors (org_id, store_connection_id, resource, status, updated_at) values ($1, $1, 'inventory', 'idle', now() - interval '2 hours')`, [A]);
  });
  it('lists running cursors older than the threshold across tenants, for app_user', async () => {
    const app = new Pool({ connectionString: tdb.appUrl });
    try {
      const { rows } = await app.query(`select * from app_list_stalled_sync_cursors(now() - interval '1 hour')`);
      expect(rows.map((r) => r.o_org_id).sort()).toEqual([A, B].sort());
      expect(rows.every((r) => r.o_resource === 'locations' && r.o_sync_run_id)).toBe(true);
      const none = await app.query(`select * from app_list_stalled_sync_cursors(now() - interval '3 hours')`);
      expect(none.rows).toEqual([]);
    } finally {
      await app.end();
    }
  });
  it('is not executable by PUBLIC', async () => {
    const { rows } = await owner.query(`select has_function_privilege('public', 'app_list_stalled_sync_cursors(timestamptz)', 'execute') as ok`);
    expect(rows[0].ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm turbo run test --filter=@erq/db -- orders-schema isolation`
Expected: FAIL (relations do not exist).

- [ ] **Step 3: Write the schema**

`packages/db/src/schema/orders.ts`:

```ts
import { sql } from 'drizzle-orm';
import {
  bigint, boolean, char, check, foreignKey, index, integer, pgEnum, pgTable, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core';
import { skus } from './catalog';
import { storeConnections } from './connections';
import { tenantId } from './tenant';
import { timestamps } from './timestamps';

export const salesChannel = pgEnum('sales_channel', ['shopify_online', 'shopify_pos']);
export const orderStatus = pgEnum('order_status', ['open', 'closed', 'cancelled']);
export const syncResource = pgEnum('sync_resource', ['products', 'locations', 'inventory', 'orders']);
export const cursorStatus = pgEnum('cursor_status', ['idle', 'running', 'failed', 'complete']);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    storeConnectionId: uuid('store_connection_id').notNull(),
    externalOrderId: text('external_order_id').notNull(),
    channel: salesChannel('channel').notNull(),
    status: orderStatus('status').notNull(),
    placedAt: timestamp('placed_at', { withTimezone: true }).notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    currency: char('currency', { length: 3 }).notNull(),
    grossCents: bigint('gross_cents', { mode: 'number' }).notNull(),
    discountCents: bigint('discount_cents', { mode: 'number' }).notNull(),
    shippingChargedCents: bigint('shipping_charged_cents', { mode: 'number' }).notNull(),
    taxCents: bigint('tax_cents', { mode: 'number' }).notNull(),
    refundCents: bigint('refund_cents', { mode: 'number' }).notNull(),
    /** gross - discount - refund; negative when refunds exceed sales. */
    netCents: bigint('net_cents', { mode: 'number' }).notNull(),
    /** Opaque platform customer id. No names, emails or addresses are stored (customers table is Phase 2). */
    customerExternalId: text('customer_external_id'),
    utmSource: text('utm_source'),
    utmMedium: text('utm_medium'),
    utmCampaign: text('utm_campaign'),
    landingSite: text('landing_site'),
    isTest: boolean('is_test').notNull().default(false),
    externalUpdatedAt: timestamp('external_updated_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    unique('orders_org_id_uq').on(t.orgId, t.id),
    unique('orders_external_uq').on(t.orgId, t.storeConnectionId, t.externalOrderId),
    foreignKey({ columns: [t.orgId, t.storeConnectionId], foreignColumns: [storeConnections.orgId, storeConnections.id] }).onDelete('cascade'),
    check('orders_money_nonneg', sql`${t.grossCents} >= 0 and ${t.discountCents} >= 0 and ${t.shippingChargedCents} >= 0 and ${t.taxCents} >= 0 and ${t.refundCents} >= 0`),
    index('orders_org_placed_idx').on(t.orgId, t.placedAt),
    index('orders_org_channel_placed_idx').on(t.orgId, t.channel, t.placedAt),
  ],
);

export const orderLines = pgTable(
  'order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    orderId: uuid('order_id').notNull(),
    /** Null when the external variant is not mapped to a SKU yet. */
    skuId: uuid('sku_id'),
    externalLineId: text('external_line_id').notNull(),
    externalVariantId: text('external_variant_id'),
    title: text('title').notNull(),
    quantity: integer('quantity').notNull(),
    unitPriceCents: bigint('unit_price_cents', { mode: 'number' }).notNull(),
    discountCents: bigint('discount_cents', { mode: 'number' }).notNull().default(0),
    refundedQuantity: integer('refunded_quantity').notNull().default(0),
    /** Landed cost per unit in effect on the order date; null when unknown (never zero by default). */
    unitCogsCentsSnapshot: bigint('unit_cogs_cents_snapshot', { mode: 'number' }),
    ...timestamps,
  },
  (t) => [
    unique('order_lines_org_id_uq').on(t.orgId, t.id),
    unique('order_lines_external_uq').on(t.orgId, t.orderId, t.externalLineId),
    foreignKey({ columns: [t.orgId, t.orderId], foreignColumns: [orders.orgId, orders.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.orgId, t.skuId], foreignColumns: [skus.orgId, skus.id] }),
    check('order_lines_quantity_positive', sql`${t.quantity} > 0`),
    check('order_lines_refunded_within_quantity', sql`${t.refundedQuantity} >= 0 and ${t.refundedQuantity} <= ${t.quantity}`),
    check('order_lines_money_nonneg', sql`${t.unitPriceCents} >= 0 and ${t.discountCents} >= 0 and (${t.unitCogsCentsSnapshot} is null or ${t.unitCogsCentsSnapshot} >= 0)`),
    index('order_lines_org_sku_idx').on(t.orgId, t.skuId),
  ],
);

export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    orderId: uuid('order_id').notNull(),
    externalRefundId: text('external_refund_id').notNull(),
    refundedAt: timestamp('refunded_at', { withTimezone: true }).notNull(),
    /** Refunded amount excluding tax. */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    shippingRefundCents: bigint('shipping_refund_cents', { mode: 'number' }).notNull().default(0),
    restock: boolean('restock').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    unique('refunds_org_id_uq').on(t.orgId, t.id),
    unique('refunds_external_uq').on(t.orgId, t.orderId, t.externalRefundId),
    foreignKey({ columns: [t.orgId, t.orderId], foreignColumns: [orders.orgId, orders.id] }).onDelete('cascade'),
    check('refunds_money_nonneg', sql`${t.amountCents} >= 0 and ${t.shippingRefundCents} >= 0`),
  ],
);

export const refundLines = pgTable(
  'refund_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    refundId: uuid('refund_id').notNull(),
    orderLineId: uuid('order_line_id').notNull(),
    quantity: integer('quantity').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    ...timestamps,
  },
  (t) => [
    unique('refund_lines_uq').on(t.orgId, t.refundId, t.orderLineId),
    foreignKey({ columns: [t.orgId, t.refundId], foreignColumns: [refunds.orgId, refunds.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.orgId, t.orderLineId], foreignColumns: [orderLines.orgId, orderLines.id] }).onDelete('cascade'),
    check('refund_lines_quantity_positive', sql`${t.quantity} > 0`),
    check('refund_lines_amount_nonneg', sql`${t.amountCents} >= 0`),
  ],
);

export const syncCursors = pgTable(
  'sync_cursors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    storeConnectionId: uuid('store_connection_id').notNull(),
    resource: syncResource('resource').notNull(),
    cursor: text('cursor'),
    status: cursorStatus('status').notNull().default('idle'),
    /** Set for backfill runs; null for incremental runs. */
    backfillSince: timestamp('backfill_since', { withTimezone: true }),
    /** Watermark for incremental runs: the start time of the last completed run. */
    updatedSince: timestamp('updated_since', { withTimezone: true }),
    currentSyncRunId: uuid('current_sync_run_id'),
    recordsProcessed: bigint('records_processed', { mode: 'number' }).notNull().default(0),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),
    ...timestamps,
  },
  (t) => [
    unique('sync_cursors_uq').on(t.orgId, t.storeConnectionId, t.resource),
    foreignKey({ columns: [t.orgId, t.storeConnectionId], foreignColumns: [storeConnections.orgId, storeConnections.id] }).onDelete('cascade'),
  ],
);
```

Append `export * from './orders';` to `packages/db/src/schema/index.ts`.

- [ ] **Step 4: Generate migrations; write the RLS and function migration**

```bash
cd packages/db
pnpm drizzle-kit generate --name=sync_orders
pnpm drizzle-kit generate --custom --name=sync_orders_rls
cd ../..
```

Fill the empty `0010_sync_orders_rls.sql`:

```sql
SELECT app_secure_tenant_table('orders');
--> statement-breakpoint
SELECT app_secure_tenant_table('order_lines');
--> statement-breakpoint
SELECT app_secure_tenant_table('refunds');
--> statement-breakpoint
SELECT app_secure_tenant_table('refund_lines');
--> statement-breakpoint
SELECT app_secure_tenant_table('sync_cursors');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_list_stalled_sync_cursors(p_older_than timestamptz)
RETURNS TABLE (o_org_id uuid, o_store_connection_id uuid, o_resource sync_resource, o_sync_run_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT c.org_id, c.store_connection_id, c.resource, c.current_sync_run_id
  FROM sync_cursors c
  WHERE c.status = 'running' AND c.current_sync_run_id IS NOT NULL AND c.updated_at < p_older_than
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_list_stalled_sync_cursors(timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_list_stalled_sync_cursors(timestamptz) TO app_user;
--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION app_list_stalled_sync_cursors(timestamptz) FROM %I', r);
  END LOOP;
END $$;
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm turbo run test typecheck build --filter=@erq/db` then `pnpm lint`
Expected: PASS. If a check-constraint name in the tests differs from what Drizzle generated, the schema's explicit constraint names above are authoritative; fix the test regex only if the name differs for a legitimate reason and report it.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(db): add orders, refunds and sync cursors with RLS and a stalled-run function"
```

### Task 3: `isCostInEffect` in `@erq/metrics`

**Files:**
- Modify: `packages/metrics/src/pricing.ts`, `packages/metrics/test/pricing.test.ts`, `packages/metrics/test/exports.test.ts`

**Interfaces:**
- Produces (from `@erq/metrics`): `isCostInEffect(component: Pick<CostComponent, 'effectiveFrom' | 'effectiveTo'>, asOf: string): boolean` (`effectiveFrom <= asOf` and (`effectiveTo` null or `asOf < effectiveTo`)). `landedCost` uses it, so the rule has a single source of truth for the sync cost snapshots.

- [ ] **Step 1: Write the failing tests**

Append to `packages/metrics/test/pricing.test.ts` (and add `isCostInEffect` to its import from `../src/pricing`):

```ts
describe('isCostInEffect', () => {
  const closed = { effectiveFrom: '2025-01-01', effectiveTo: '2025-07-01' };
  it.each([
    ['2024-12-31', false], ['2025-01-01', true], ['2025-06-30', true], ['2025-07-01', false], ['2026-01-01', false],
  ])('closed period on %s is %s', (asOf, expected) => {
    expect(isCostInEffect(closed, asOf)).toBe(expected);
  });
  it('is open-ended when effectiveTo is null', () => {
    const open = { effectiveFrom: '2025-07-01', effectiveTo: null };
    expect(isCostInEffect(open, '2025-06-30')).toBe(false);
    expect(isCostInEffect(open, '2025-07-01')).toBe(true);
    expect(isCostInEffect(open, '2099-01-01')).toBe(true);
  });
});
```

In `packages/metrics/test/exports.test.ts` add `'isCostInEffect'` to the list of exported function names.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm turbo run test --filter=@erq/metrics`
Expected: FAIL (`isCostInEffect` is not exported).

- [ ] **Step 3: Implement**

In `packages/metrics/src/pricing.ts` add (above `landedCost`):

```ts
/** A cost component is in effect on `asOf` when effectiveFrom <= asOf < effectiveTo (effectiveTo null = open-ended). */
export function isCostInEffect(
  component: Pick<CostComponent, 'effectiveFrom' | 'effectiveTo'>,
  asOf: string,
): boolean {
  return component.effectiveFrom <= asOf && (component.effectiveTo === null || asOf < component.effectiveTo);
}
```

and inside `landedCost` replace the inline date condition with `if (isCostInEffect(c, asOf)) { ... }` (keep all validation before it unchanged).

- [ ] **Step 4: Run to verify pass, rebuild, commit**

Run: `pnpm turbo run test typecheck build --filter=@erq/metrics` then `pnpm lint`
Expected: PASS (all existing 340 tests plus the new ones).

```bash
git add -A && git commit -m "feat(metrics): export isCostInEffect as the single cost-period rule"
```

---

### Task 4: Connector contract, typed errors, credentials, registry

**Files:**
- Modify: `packages/connectors/package.json`, `packages/connectors/src/types.ts`, `packages/connectors/src/index.ts`
- Create: `packages/connectors/{vitest.config.mts}`, `src/normalized.ts`, `src/errors.ts`, `src/credentials.ts`, `src/registry.ts`
- Test: `packages/connectors/test/errors.test.ts`, `credentials.test.ts`, `registry.test.ts`

**Interfaces:**
- Produces (from `@erq/connectors`): `SyncResource`, `SYNC_RESOURCES`, `Normalized*` types, `Page<T>`, `FetchOptions`, `ConnectionContext`, `ResourceItems`, `StoreConnector`, `RateLimitedError(retryAfterMs)`, `TransientError`, `AuthError`, `PermanentError`, `credentialsAad(connectionId)`, `encryptConnectionCredentials(credentials, keyProvider, connectionId)`, `decryptConnectionCredentials(encrypted, keyProvider, connectionId)`, `ConnectorRegistry`. The `AdConnector`, `Connection`, `SyncResult`, `DateRange`, `InsightLevel` types are unchanged.

- [ ] **Step 1: Package setup**

In `packages/connectors/package.json` set scripts to `build`/`dev`/`typecheck` as today plus `"test": "vitest run"`, add `"dependencies": { "@erq/shared": "workspace:*" }`, and replace the single-entry fields with:

```json
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./testing": { "types": "./dist/testing.d.ts", "default": "./dist/testing.js" }
  },
```

`packages/connectors/tsup.config.ts`:

```ts
import { defineConfig } from 'tsup';
export default defineConfig({
  entry: { index: 'src/index.ts', testing: 'src/testing/index.ts' },
  format: ['cjs'], dts: true, clean: true, sourcemap: true,
  external: ['vitest'],
});
```

`packages/connectors/vitest.config.mts`: `import { defineConfig } from 'vitest/config'; export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });`. Ensure `packages/connectors/tsconfig.json` includes `["src", "test", "*.config.*"]`. Create an empty `packages/connectors/src/testing/index.ts` containing `export {};` (Task 5 fills it). Run `pnpm install`.

- [ ] **Step 2: Write the failing tests**

`packages/connectors/test/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AuthError, PermanentError, RateLimitedError, TransientError } from '../src/errors';

describe('typed errors', () => {
  it('carry names, messages and are distinguishable with instanceof', () => {
    const rl = new RateLimitedError(1500);
    expect(rl).toBeInstanceOf(Error);
    expect(rl).toBeInstanceOf(RateLimitedError);
    expect(rl).not.toBeInstanceOf(TransientError);
    expect(rl.retryAfterMs).toBe(1500);
    expect(rl.name).toBe('RateLimitedError');
    expect(new TransientError('boom').message).toBe('boom');
    expect(new AuthError('revoked')).toBeInstanceOf(Error);
    expect(new PermanentError('bad').name).toBe('PermanentError');
  });
  it('rejects a negative or non-finite retry-after', () => {
    expect(() => new RateLimitedError(-1)).toThrow(RangeError);
    expect(() => new RateLimitedError(Number.NaN)).toThrow(RangeError);
  });
});
```

`packages/connectors/test/credentials.test.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { EnvKeyProvider } from '@erq/shared';
import { describe, expect, it } from 'vitest';
import { credentialsAad, decryptConnectionCredentials, encryptConnectionCredentials } from '../src/credentials';
import { AuthError } from '../src/errors';

const provider = () => new EnvKeyProvider('k1', { k1: randomBytes(32).toString('base64') });
const CONN = '00000000-0000-4000-8000-0000000000c1';

describe('connection credentials', () => {
  it('round-trips JSON credentials', () => {
    const p = provider();
    const encrypted = encryptConnectionCredentials({ accessToken: 'shpat_secret' }, p, CONN);
    expect(encrypted).not.toContain('shpat_secret');
    expect(decryptConnectionCredentials(encrypted, p, CONN)).toEqual({ accessToken: 'shpat_secret' });
  });
  it('returns null for connections without credentials (demo connections)', () => {
    expect(decryptConnectionCredentials(null, provider(), CONN)).toBeNull();
  });
  it('is bound to the connection id through the AAD', () => {
    const p = provider();
    const encrypted = encryptConnectionCredentials({ t: 1 }, p, CONN);
    expect(credentialsAad(CONN)).toBe(`connection:${CONN}`);
    expect(() => decryptConnectionCredentials(encrypted, p, '00000000-0000-4000-8000-0000000000c2')).toThrow(AuthError);
  });
  it('throws AuthError without leaking secrets for garbage, wrong keys and non-JSON plaintext', () => {
    const p = provider();
    expect(() => decryptConnectionCredentials('garbage', p, CONN)).toThrow(AuthError);
    const other = encryptConnectionCredentials({ t: 'SECRETVALUE' }, provider(), CONN);
    try {
      decryptConnectionCredentials(other, p, CONN);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('SECRETVALUE');
    }
  });
});
```

`packages/connectors/test/registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PermanentError } from '../src/errors';
import { ConnectorRegistry } from '../src/registry';
import type { StoreConnector } from '../src/types';

const stub = {} as unknown as StoreConnector; // identity is all the registry cares about

describe('ConnectorRegistry', () => {
  it('returns the registered connector for a platform', () => {
    const r = new ConnectorRegistry().register('shopify', stub);
    expect(r.has('shopify')).toBe(true);
    expect(r.get('shopify')).toBe(stub);
  });
  it('throws a PermanentError for an unknown platform', () => {
    const r = new ConnectorRegistry();
    expect(r.has('amazon')).toBe(false);
    expect(() => r.get('amazon')).toThrow(PermanentError);
  });
  it('refuses to register a platform twice', () => {
    const r = new ConnectorRegistry().register('shopify', stub);
    expect(() => r.register('shopify', stub)).toThrow(/already registered/);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm turbo run test --filter=@erq/connectors`
Expected: FAIL (modules do not exist).

- [ ] **Step 4: Implement**

`packages/connectors/src/errors.ts`:

```ts
/** The platform asked us to slow down. The job is re-queued after `retryAfterMs`; no attempt is consumed. */
export class RateLimitedError extends Error {
  override name = 'RateLimitedError';
  constructor(readonly retryAfterMs: number, message = 'rate limited') {
    super(message);
    if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) {
      throw new RangeError(`retryAfterMs must be a non-negative number, got ${retryAfterMs}`);
    }
  }
}
/** A retryable failure (network, 5xx). The queue retries with exponential backoff. */
export class TransientError extends Error {
  override name = 'TransientError';
}
/** The stored credentials no longer work. The connection is marked as errored; the owner must reconnect. */
export class AuthError extends Error {
  override name = 'AuthError';
}
/** A failure that retrying cannot fix. The run is marked failed. */
export class PermanentError extends Error {
  override name = 'PermanentError';
}
```

`packages/connectors/src/normalized.ts`: write the types exactly as listed in the spec §5 (`SyncResource`, `SYNC_RESOURCES = ['locations','products','inventory','orders']`, `LocationType`, `ProductStatus`, `SalesChannel`, `OrderStatus`, `NormalizedLocation`, `NormalizedVariant`, `NormalizedProduct`, `NormalizedInventoryLevel`, `NormalizedOrderLine`, `NormalizedRefundLine`, `NormalizedRefund`, `NormalizedOrder`) with these exact shapes:

```ts
export type SyncResource = 'products' | 'locations' | 'inventory' | 'orders';
/** Dependency order: inventory and orders refer to locations and products. */
export const SYNC_RESOURCES: readonly SyncResource[] = ['locations', 'products', 'inventory', 'orders'];
export type LocationType = 'warehouse' | 'store' | '3pl' | 'fba' | 'other';
export type ProductStatus = 'active' | 'draft' | 'archived';
export type SalesChannel = 'shopify_online' | 'shopify_pos';
export type OrderStatus = 'open' | 'closed' | 'cancelled';

export interface NormalizedLocation { externalId: string; name: string; type: LocationType; address: string | null; isActive: boolean }
export interface NormalizedVariant {
  externalId: string; skuCode: string | null; barcode: string | null; priceCents: number;
  compareAtPriceCents: number | null; currency: string; unitCostCents: number | null; updatedAt: Date;
}
export interface NormalizedProduct {
  externalId: string; title: string; brand: string | null; category: string | null; status: ProductStatus;
  updatedAt: Date; variants: NormalizedVariant[];
}
export interface NormalizedInventoryLevel {
  externalVariantId: string; locationExternalId: string; onHand: number; reserved: number; incoming: number; updatedAt: Date;
}
export interface NormalizedOrderLine {
  externalLineId: string; externalVariantId: string | null; title: string; quantity: number; unitPriceCents: number; discountCents: number;
}
export interface NormalizedRefundLine { externalLineId: string; quantity: number; amountCents: number }
export interface NormalizedRefund {
  externalId: string; refundedAt: Date;
  /** Refunded amount excluding tax. */
  amountCents: number; shippingRefundCents: number; restock: boolean; lines: NormalizedRefundLine[];
}
export interface NormalizedOrder {
  externalId: string; channel: SalesChannel; status: OrderStatus; placedAt: Date; cancelledAt: Date | null; currency: string;
  grossCents: number; discountCents: number; shippingChargedCents: number; taxCents: number;
  customerExternalId: string | null; utmSource: string | null; utmMedium: string | null; utmCampaign: string | null;
  landingSite: string | null; isTest: boolean; updatedAt: Date; lines: NormalizedOrderLine[]; refunds: NormalizedRefund[];
}
```

Replace the store-related part of `packages/connectors/src/types.ts` (keep `Connection`, `SyncResult`, `InsightLevel`, `DateRange`, `AdConnector` as they are; delete the old `NormalizedOrder`, `NormalizedProduct`, `NormalizedInventory`, `StoreConnector`) and add:

```ts
import type { NormalizedInventoryLevel, NormalizedLocation, NormalizedOrder, NormalizedProduct, SyncResource } from './normalized';

export interface ResourceItems {
  locations: NormalizedLocation;
  products: NormalizedProduct;
  inventory: NormalizedInventoryLevel;
  orders: NormalizedOrder;
}
export interface Page<T> {
  items: T[];
  /** Null when this was the last page. */
  nextCursor: string | null;
  /** Rate-limit cost the call consumed, when the platform reports one. */
  cost?: number;
}
export interface FetchOptions {
  /** Backfill: only data from this date on. */
  since?: Date;
  /** Incremental: only data changed since this date. */
  updatedSince?: Date;
}
export interface ConnectionContext {
  connectionId: string;
  externalAccountId: string;
  /** Decrypted credentials. Never log this. Null for connections without credentials. */
  credentials: unknown;
}
export interface StoreConnector {
  connect(oauthParams: Record<string, string>): Promise<Connection>;
  fetchPage<R extends SyncResource>(
    ctx: ConnectionContext, resource: R, cursor: string | null, options: FetchOptions,
  ): Promise<Page<ResourceItems[R]>>;
  handleWebhook(payload: unknown, headers: Record<string, string>): Promise<void>;
  pushPrice?(sku: string, priceCents: number): Promise<void>; // phase 4
  pushInventory?(sku: string, location: string, qty: number): Promise<void>; // phase 4
}
```

`packages/connectors/src/credentials.ts`:

```ts
import { decrypt, encrypt, type KeyProvider } from '@erq/shared';
import { AuthError } from './errors';

/** Additional authenticated data that binds stored credentials to one connection. */
export const credentialsAad = (connectionId: string): string => `connection:${connectionId}`;

export function encryptConnectionCredentials(credentials: unknown, keyProvider: KeyProvider, connectionId: string): string {
  return encrypt(JSON.stringify(credentials), keyProvider, credentialsAad(connectionId));
}

/** Null (demo connections) stays null. Any failure becomes an AuthError whose message never contains secret material. */
export function decryptConnectionCredentials(encrypted: string | null, keyProvider: KeyProvider, connectionId: string): unknown {
  if (encrypted === null) return null;
  try {
    return JSON.parse(decrypt(encrypted, keyProvider, credentialsAad(connectionId)));
  } catch {
    throw new AuthError('Stored credentials could not be read. Reconnect the store.');
  }
}
```

`packages/connectors/src/registry.ts`:

```ts
import { PermanentError } from './errors';
import type { StoreConnector } from './types';

export class ConnectorRegistry {
  private readonly connectors = new Map<string, StoreConnector>();

  register(platform: string, connector: StoreConnector): this {
    if (this.connectors.has(platform)) throw new Error(`connector for ${platform} already registered`);
    this.connectors.set(platform, connector);
    return this;
  }
  has(platform: string): boolean {
    return this.connectors.has(platform);
  }
  get(platform: string): StoreConnector {
    const connector = this.connectors.get(platform);
    if (!connector) throw new PermanentError(`no connector registered for platform ${platform}`);
    return connector;
  }
}
```

`packages/connectors/src/index.ts`:

```ts
export * from './types';
export * from './normalized';
export * from './errors';
export * from './credentials';
export * from './registry';
```

- [ ] **Step 5: Run to verify pass, then commit**

Run: `pnpm turbo run test typecheck build --filter=@erq/connectors` then `pnpm lint`
Expected: PASS.

```bash
git add -A && git commit -m "feat(connectors): add page-based store connector contract, typed errors and credential helpers"
```

---

### Task 5: Fake connector, sample data and the shared contract test

**Files:**
- Create: `packages/connectors/src/testing/{fake-connector.ts,sample-data.ts,contract.ts}`; modify `packages/connectors/src/testing/index.ts`
- Test: `packages/connectors/test/fake-connector.test.ts`

**Interfaces:**
- Produces (from `@erq/connectors/testing`): `FakeConnector` (`new FakeConnector(data, pageSize = 2)`, `.calls: FakeCall[]`, `.failNext(error, times = 1)`, `.data`), `FakeData`, `sampleData(): FakeData`, `runConnectorContract(subject: { name: string; create(): { connector: StoreConnector; ctx: ConnectionContext } }): void`.

- [ ] **Step 1: Write the failing test**

`packages/connectors/test/fake-connector.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PermanentError, TransientError } from '../src/errors';
import type { ConnectionContext } from '../src/types';
import { FakeConnector, runConnectorContract, sampleData } from '../src/testing';

const ctx: ConnectionContext = { connectionId: 'c1', externalAccountId: 'fake-shop', credentials: { token: 't' } };

runConnectorContract({ name: 'FakeConnector', create: () => ({ connector: new FakeConnector(sampleData(), 2), ctx }) });

describe('FakeConnector', () => {
  it('pages with the given page size and ends with a null cursor', async () => {
    const c = new FakeConnector(sampleData(), 2);
    const p1 = await c.fetchPage(ctx, 'products', null, {});
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBe('2');
    const p2 = await c.fetchPage(ctx, 'products', p1.nextCursor, {});
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
  });
  it('records calls including the credentials it received', async () => {
    const c = new FakeConnector(sampleData(), 5);
    await c.fetchPage(ctx, 'locations', null, { since: new Date('2026-01-01') });
    expect(c.calls).toEqual([{ resource: 'locations', cursor: null, options: { since: new Date('2026-01-01') }, credentials: { token: 't' } }]);
  });
  it('filters by updatedSince for incremental runs', async () => {
    const c = new FakeConnector(sampleData(), 50);
    const all = await c.fetchPage(ctx, 'orders', null, {});
    const cut = all.items[2]!.updatedAt;
    const some = await c.fetchPage(ctx, 'orders', null, { updatedSince: cut });
    expect(some.items.length).toBe(all.items.filter((o) => o.updatedAt >= cut).length);
    expect(some.items.length).toBeLessThan(all.items.length);
  });
  it('filters orders by since (backfill window)', async () => {
    const c = new FakeConnector(sampleData(), 50);
    const all = await c.fetchPage(ctx, 'orders', null, {});
    const cut = all.items[3]!.placedAt;
    const some = await c.fetchPage(ctx, 'orders', null, { since: cut });
    expect(some.items.every((o) => o.placedAt >= cut)).toBe(true);
  });
  it('throws scripted failures in order, then recovers', async () => {
    const c = new FakeConnector(sampleData(), 2);
    c.failNext(new TransientError('flaky'), 2);
    await expect(c.fetchPage(ctx, 'locations', null, {})).rejects.toThrow('flaky');
    await expect(c.fetchPage(ctx, 'locations', null, {})).rejects.toThrow('flaky');
    await expect(c.fetchPage(ctx, 'locations', null, {})).resolves.toBeTruthy();
  });
  it('rejects an invalid cursor', async () => {
    const c = new FakeConnector(sampleData(), 2);
    await expect(c.fetchPage(ctx, 'locations', 'abc', {})).rejects.toBeInstanceOf(PermanentError);
  });
});

describe('sampleData', () => {
  it('covers online and POS orders, a refund, a cancellation and an unmapped variant', () => {
    const d = sampleData();
    expect(d.orders.some((o) => o.channel === 'shopify_pos')).toBe(true);
    expect(d.orders.some((o) => o.refunds.length > 0)).toBe(true);
    expect(d.orders.some((o) => o.status === 'cancelled')).toBe(true);
    const known = new Set(d.products.flatMap((p) => p.variants.map((v) => v.externalId)));
    expect(d.orders.some((o) => o.lines.some((l) => l.externalVariantId && !known.has(l.externalVariantId)))).toBe(true);
    expect(d.locations.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm turbo run test --filter=@erq/connectors`
Expected: FAIL (`../src/testing` exports nothing).

- [ ] **Step 3: Implement**

`packages/connectors/src/testing/sample-data.ts`:

```ts
import type { FakeData } from './fake-connector';

const d = (iso: string): Date => new Date(iso);

/** Deterministic data: 2 locations, 3 products (4 variants), 6 inventory levels, 5 orders. */
export function sampleData(): FakeData {
  return {
    locations: [
      { externalId: 'loc-1', name: 'Main warehouse', type: 'warehouse', address: '1 Dock Rd, Austin TX', isActive: true },
      { externalId: 'loc-2', name: 'Downtown store', type: 'store', address: '9 Main St, Austin TX', isActive: true },
    ],
    products: [
      {
        externalId: 'p-1', title: 'Logo T-Shirt', brand: 'Demo Co', category: 'Apparel', status: 'active', updatedAt: d('2026-09-01T10:00:00Z'),
        variants: [
          { externalId: 'v-1', skuCode: 'TSHIRT-S', barcode: null, priceCents: 2500, compareAtPriceCents: null, currency: 'USD', unitCostCents: 800, updatedAt: d('2026-09-01T10:00:00Z') },
          { externalId: 'v-2', skuCode: 'TSHIRT-M', barcode: null, priceCents: 2500, compareAtPriceCents: 3000, currency: 'USD', unitCostCents: 800, updatedAt: d('2026-09-01T10:00:00Z') },
        ],
      },
      {
        externalId: 'p-2', title: 'Poster', brand: null, category: 'Home', status: 'active', updatedAt: d('2026-09-02T10:00:00Z'),
        variants: [{ externalId: 'v-3', skuCode: null, barcode: '123456789012', priceCents: 4000, compareAtPriceCents: null, currency: 'USD', unitCostCents: null, updatedAt: d('2026-09-02T10:00:00Z') }],
      },
      {
        externalId: 'p-3', title: 'Coffee Mug', brand: 'Demo Co', category: 'Kitchen', status: 'active', updatedAt: d('2026-09-03T10:00:00Z'),
        variants: [{ externalId: 'v-4', skuCode: 'MUG-1', barcode: null, priceCents: 1200, compareAtPriceCents: null, currency: 'USD', unitCostCents: 300, updatedAt: d('2026-09-03T10:00:00Z') }],
      },
    ],
    inventory: [
      { externalVariantId: 'v-1', locationExternalId: 'loc-1', onHand: 40, reserved: 2, incoming: 0, updatedAt: d('2026-09-04T09:00:00Z') },
      { externalVariantId: 'v-1', locationExternalId: 'loc-2', onHand: 5, reserved: 0, incoming: 0, updatedAt: d('2026-09-04T09:00:00Z') },
      { externalVariantId: 'v-2', locationExternalId: 'loc-1', onHand: 30, reserved: 0, incoming: 10, updatedAt: d('2026-09-04T09:00:00Z') },
      { externalVariantId: 'v-3', locationExternalId: 'loc-1', onHand: 12, reserved: 1, incoming: 0, updatedAt: d('2026-09-04T09:00:00Z') },
      { externalVariantId: 'v-4', locationExternalId: 'loc-1', onHand: 100, reserved: 0, incoming: 0, updatedAt: d('2026-09-04T09:00:00Z') },
      { externalVariantId: 'v-4', locationExternalId: 'loc-2', onHand: -2, reserved: 0, incoming: 0, updatedAt: d('2026-09-04T09:00:00Z') },
    ],
    orders: [
      {
        externalId: 'o-1', channel: 'shopify_online', status: 'closed', placedAt: d('2026-09-05T14:00:00Z'), cancelledAt: null, currency: 'USD',
        grossCents: 7500, discountCents: 100, shippingChargedCents: 500, taxCents: 600, customerExternalId: 'cust-1',
        utmSource: 'meta', utmMedium: 'cpc', utmCampaign: 'fall', landingSite: '/products/logo-t-shirt', isTest: false, updatedAt: d('2026-09-05T14:05:00Z'),
        lines: [
          { externalLineId: 'l-1', externalVariantId: 'v-1', title: 'Logo T-Shirt S', quantity: 2, unitPriceCents: 2500, discountCents: 100 },
          { externalLineId: 'l-2', externalVariantId: 'v-3', title: 'Poster', quantity: 1, unitPriceCents: 2500, discountCents: 0 },
        ],
        refunds: [],
      },
      {
        externalId: 'o-2', channel: 'shopify_pos', status: 'closed', placedAt: d('2026-09-06T16:30:00Z'), cancelledAt: null, currency: 'USD',
        grossCents: 3600, discountCents: 0, shippingChargedCents: 0, taxCents: 297, customerExternalId: null,
        utmSource: null, utmMedium: null, utmCampaign: null, landingSite: null, isTest: false, updatedAt: d('2026-09-06T16:31:00Z'),
        lines: [{ externalLineId: 'l-1', externalVariantId: 'v-4', title: 'Coffee Mug', quantity: 3, unitPriceCents: 1200, discountCents: 0 }],
        refunds: [],
      },
      {
        externalId: 'o-3', channel: 'shopify_online', status: 'closed', placedAt: d('2026-09-07T09:00:00Z'), cancelledAt: null, currency: 'USD',
        grossCents: 2500, discountCents: 0, shippingChargedCents: 500, taxCents: 206, customerExternalId: 'cust-2',
        utmSource: null, utmMedium: null, utmCampaign: null, landingSite: null, isTest: false, updatedAt: d('2026-09-09T08:00:00Z'),
        lines: [{ externalLineId: 'l-1', externalVariantId: 'v-2', title: 'Logo T-Shirt M', quantity: 1, unitPriceCents: 2500, discountCents: 0 }],
        refunds: [{ externalId: 'r-1', refundedAt: d('2026-09-09T08:00:00Z'), amountCents: 2500, shippingRefundCents: 0, restock: true, lines: [{ externalLineId: 'l-1', quantity: 1, amountCents: 2500 }] }],
      },
      {
        externalId: 'o-4', channel: 'shopify_online', status: 'cancelled', placedAt: d('2026-09-08T11:00:00Z'), cancelledAt: d('2026-09-08T12:00:00Z'), currency: 'USD',
        grossCents: 1200, discountCents: 0, shippingChargedCents: 0, taxCents: 99, customerExternalId: 'cust-3',
        utmSource: null, utmMedium: null, utmCampaign: null, landingSite: null, isTest: false, updatedAt: d('2026-09-08T12:00:00Z'),
        lines: [{ externalLineId: 'l-1', externalVariantId: 'v-4', title: 'Coffee Mug', quantity: 1, unitPriceCents: 1200, discountCents: 0 }],
        refunds: [],
      },
      {
        externalId: 'o-5', channel: 'shopify_online', status: 'open', placedAt: d('2026-09-10T20:00:00Z'), cancelledAt: null, currency: 'USD',
        grossCents: 900, discountCents: 0, shippingChargedCents: 0, taxCents: 0, customerExternalId: null,
        utmSource: null, utmMedium: null, utmCampaign: null, landingSite: null, isTest: true, updatedAt: d('2026-09-10T20:00:00Z'),
        lines: [{ externalLineId: 'l-1', externalVariantId: 'v-999', title: 'Deleted product', quantity: 1, unitPriceCents: 900, discountCents: 0 }],
        refunds: [],
      },
    ],
  };
}
```

`packages/connectors/src/testing/fake-connector.ts`:

```ts
import { PermanentError } from '../errors';
import type {
  NormalizedInventoryLevel, NormalizedLocation, NormalizedOrder, NormalizedProduct, SyncResource,
} from '../normalized';
import type { Connection, ConnectionContext, FetchOptions, Page, ResourceItems, StoreConnector } from '../types';

export interface FakeData {
  locations: NormalizedLocation[];
  products: NormalizedProduct[];
  inventory: NormalizedInventoryLevel[];
  orders: NormalizedOrder[];
}
export interface FakeCall {
  resource: SyncResource;
  cursor: string | null;
  options: FetchOptions;
  credentials: unknown;
}

/** In-memory connector for tests: deterministic pages, scripted failures, call recording. */
export class FakeConnector implements StoreConnector {
  readonly calls: FakeCall[] = [];
  private readonly failures: Error[] = [];

  constructor(
    public data: FakeData,
    private readonly pageSize = 2,
  ) {}

  /** The next `times` fetchPage calls throw `error`. */
  failNext(error: Error, times = 1): void {
    for (let i = 0; i < times; i++) this.failures.push(error);
  }

  async connect(): Promise<Connection> {
    return { id: 'fake', externalAccountId: 'fake-shop' };
  }

  async handleWebhook(): Promise<void> {}

  async fetchPage<R extends SyncResource>(
    ctx: ConnectionContext, resource: R, cursor: string | null, options: FetchOptions,
  ): Promise<Page<ResourceItems[R]>> {
    this.calls.push({ resource, cursor, options, credentials: ctx.credentials });
    const failure = this.failures.shift();
    if (failure) throw failure;

    const start = cursor === null ? 0 : Number(cursor);
    if (!Number.isSafeInteger(start) || start < 0) throw new PermanentError(`invalid cursor ${cursor}`);

    let all = this.data[resource] as unknown as Array<{ updatedAt?: Date; placedAt?: Date }>;
    const { updatedSince, since } = options;
    if (updatedSince) all = all.filter((i) => i.updatedAt === undefined || i.updatedAt >= updatedSince);
    if (since && resource === 'orders') all = all.filter((i) => i.placedAt === undefined || i.placedAt >= since);

    const next = start + this.pageSize;
    return {
      items: all.slice(start, next) as unknown as ResourceItems[R][],
      nextCursor: next < all.length ? String(next) : null,
      cost: 1,
    };
  }
}
```

`packages/connectors/src/testing/contract.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SYNC_RESOURCES, type SyncResource } from '../normalized';
import type { ConnectionContext, StoreConnector } from '../types';

export interface ContractSubject {
  name: string;
  create(): { connector: StoreConnector; ctx: ConnectionContext };
}

const KEYS = {
  locations: ['externalId', 'name', 'type', 'address', 'isActive'],
  products: ['externalId', 'title', 'brand', 'category', 'status', 'updatedAt', 'variants'],
  variant: ['externalId', 'skuCode', 'barcode', 'priceCents', 'compareAtPriceCents', 'currency', 'unitCostCents', 'updatedAt'],
  inventory: ['externalVariantId', 'locationExternalId', 'onHand', 'reserved', 'incoming', 'updatedAt'],
  orders: ['externalId', 'channel', 'status', 'placedAt', 'cancelledAt', 'currency', 'grossCents', 'discountCents', 'shippingChargedCents',
    'taxCents', 'customerExternalId', 'utmSource', 'utmMedium', 'utmCampaign', 'landingSite', 'isTest', 'updatedAt', 'lines', 'refunds'],
  line: ['externalLineId', 'externalVariantId', 'title', 'quantity', 'unitPriceCents', 'discountCents'],
  refund: ['externalId', 'refundedAt', 'amountCents', 'shippingRefundCents', 'restock', 'lines'],
  refundLine: ['externalLineId', 'quantity', 'amountCents'],
} as const;

const onlyKeys = (obj: object, allowed: readonly string[], label: string) =>
  expect(Object.keys(obj).sort(), `${label} has unexpected or missing fields`).toEqual([...allowed].sort());
const nonEmpty = (v: unknown, label: string) => expect(typeof v === 'string' && v.length > 0, `${label} must be a non-empty string`).toBe(true);
const date = (v: unknown, label: string) => expect(v instanceof Date && !Number.isNaN(v.getTime()), `${label} must be a valid Date`).toBe(true);
const cents = (v: unknown, label: string, min = 0) =>
  expect(Number.isSafeInteger(v) && (v as number) >= min, `${label} must be an integer >= ${min}`).toBe(true);

type Item = Record<string, unknown> & { externalId?: string };
function validate(resource: SyncResource, item: Item): void {
  const i = item as never as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- structural checks on untyped connector output
  if (resource === 'locations') {
    onlyKeys(i, KEYS.locations, 'location');
    nonEmpty(i.externalId, 'location.externalId'); nonEmpty(i.name, 'location.name');
    expect(['warehouse', 'store', '3pl', 'fba', 'other']).toContain(i.type);
  } else if (resource === 'products') {
    onlyKeys(i, KEYS.products, 'product');
    nonEmpty(i.externalId, 'product.externalId'); nonEmpty(i.title, 'product.title'); date(i.updatedAt, 'product.updatedAt');
    expect(['active', 'draft', 'archived']).toContain(i.status);
    for (const v of i.variants) {
      onlyKeys(v, KEYS.variant, 'variant');
      nonEmpty(v.externalId, 'variant.externalId'); cents(v.priceCents, 'variant.priceCents'); date(v.updatedAt, 'variant.updatedAt');
      expect(v.currency).toMatch(/^[A-Z]{3}$/);
      if (v.unitCostCents !== null) cents(v.unitCostCents, 'variant.unitCostCents');
    }
  } else if (resource === 'inventory') {
    onlyKeys(i, KEYS.inventory, 'inventory level');
    nonEmpty(i.externalVariantId, 'level.externalVariantId'); nonEmpty(i.locationExternalId, 'level.locationExternalId');
    expect(Number.isSafeInteger(i.onHand)).toBe(true); cents(i.reserved, 'level.reserved'); cents(i.incoming, 'level.incoming'); date(i.updatedAt, 'level.updatedAt');
  } else {
    onlyKeys(i, KEYS.orders, 'order');
    nonEmpty(i.externalId, 'order.externalId'); date(i.placedAt, 'order.placedAt'); date(i.updatedAt, 'order.updatedAt');
    expect(['shopify_online', 'shopify_pos']).toContain(i.channel);
    expect(['open', 'closed', 'cancelled']).toContain(i.status);
    expect(i.currency).toMatch(/^[A-Z]{3}$/);
    for (const k of ['grossCents', 'discountCents', 'shippingChargedCents', 'taxCents']) cents(i[k], `order.${k}`);
    for (const l of i.lines) {
      onlyKeys(l, KEYS.line, 'order line');
      nonEmpty(l.externalLineId, 'line.externalLineId'); cents(l.quantity, 'line.quantity', 1); cents(l.unitPriceCents, 'line.unitPriceCents');
    }
    for (const r of i.refunds) {
      onlyKeys(r, KEYS.refund, 'refund');
      nonEmpty(r.externalId, 'refund.externalId'); date(r.refundedAt, 'refund.refundedAt'); cents(r.amountCents, 'refund.amountCents');
      for (const rl of r.lines) { onlyKeys(rl, KEYS.refundLine, 'refund line'); cents(rl.quantity, 'refundLine.quantity', 1); }
    }
  }
}

/** Every store connector (fake now, Shopify in 1b-3) must pass this suite. */
export function runConnectorContract(subject: ContractSubject): void {
  describe(`connector contract: ${subject.name}`, () => {
    for (const resource of SYNC_RESOURCES) {
      it(`${resource}: pages are finite, cursors advance, items are normalized and unique`, async () => {
        const { connector, ctx } = subject.create();
        const seenCursors = new Set<string>();
        const ids = new Set<string>();
        let cursor: string | null = null;
        let pages = 0;
        do {
          const page = await connector.fetchPage(ctx, resource, cursor, {});
          expect(Array.isArray(page.items)).toBe(true);
          for (const item of page.items as unknown as Item[]) {
            validate(resource, item);
            const id = resource === 'inventory'
              ? `${(item as { externalVariantId: string }).externalVariantId}@${(item as { locationExternalId: string }).locationExternalId}`
              : (item.externalId as string);
            expect(ids.has(id), `duplicate item ${id}`).toBe(false);
            ids.add(id);
          }
          if (page.nextCursor !== null) {
            nonEmpty(page.nextCursor, 'nextCursor');
            expect(seenCursors.has(page.nextCursor), 'cursor repeated').toBe(false);
            seenCursors.add(page.nextCursor);
          }
          cursor = page.nextCursor;
          pages++;
          expect(pages).toBeLessThan(500);
        } while (cursor !== null);
        expect(ids.size).toBeGreaterThan(0);
      });
    }
    for (const resource of ['products', 'inventory', 'orders'] as const) {
      it(`${resource}: an updatedSince in the future returns nothing`, async () => {
        const { connector, ctx } = subject.create();
        const page = await connector.fetchPage(ctx, resource, null, { updatedSince: new Date('2999-01-01T00:00:00Z') });
        expect(page.items).toEqual([]);
        expect(page.nextCursor).toBeNull();
      });
    }
  });
}
```

`packages/connectors/src/testing/index.ts`:

```ts
export * from './fake-connector';
export * from './sample-data';
export * from './contract';
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm turbo run test typecheck build --filter=@erq/connectors` then `pnpm lint`
Expected: PASS. (Note: `contract.ts` imports `vitest`; it is exported only through the `./testing` subpath and `vitest` is a tsup external.)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(connectors): add fake connector, sample data and the shared connector contract suite"
```

### Task 6: `@erq/sync` package, ports, rate-limit policies, in-memory implementations, test helpers

**Files:**
- Create: `packages/sync/{package.json,tsconfig.json,tsup.config.ts,vitest.config.mts}`, `src/{ports.ts,policies.ts,memory.ts,index.ts}`
- Create: `packages/sync/test/{helpers.ts,memory.test.ts}`

**Interfaces:**
- Produces (from `@erq/sync`): `SyncMode`, `SyncChain`, `SyncPageJob`, `RateLimitPolicy`, `RateLimitDecision`, `RateLimiter`, `JobQueue`, `PageResult`, `DEFAULT_RATE_LIMIT_POLICY`, `RATE_LIMIT_POLICIES`, `policyFor(platform, overrides?)`, `MemoryRateLimiter(clock?)`, `InMemoryJobQueue`.
- Produces (test-only, `packages/sync/test/helpers.ts`): `ORG_A`, `ORG_B`, `CONN_A`, `CONN_B`, `startEnv()`, `seedSku(owner, orgId, code, price?)`, `seedCost(owner, orgId, skuId, cents, opts?)`, `seedListing(owner, orgId, connectionId, skuId, variantId)`, `seedOrder(owner, opts)`.

- [ ] **Step 1: Package setup**

`packages/sync/package.json`:

```json
{
  "name": "@erq/sync",
  "version": "0.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "scripts": { "build": "tsup", "dev": "tsup --watch", "typecheck": "tsc --noEmit", "test": "vitest run" }
}
```

```bash
pnpm --filter @erq/sync add drizzle-orm @erq/connectors@workspace:* @erq/db@workspace:* @erq/metrics@workspace:* @erq/shared@workspace:*
pnpm --filter @erq/sync add -D pg @types/pg
```

`tsconfig.json` (extends `../../tsconfig.base.json`, `noEmit`, include `["src", "test", "*.config.*"]`), `tsup.config.ts` (`entry: ['src/index.ts']`, `format: ['cjs']`, `dts: true`, `clean: true`, `sourcemap: true`), `vitest.config.mts`:

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 180_000, pool: 'forks' },
});
```

- [ ] **Step 2: Write the test helpers and the failing memory tests**

`packages/sync/test/helpers.ts`:

```ts
import { createTenantDb, type TenantDb } from '@erq/db';
import { startTestDatabase, type TestDatabase } from '@erq/db/testing';
import { Pool } from 'pg';

export const ORG_A = '11111111-1111-4111-8111-111111111111';
export const ORG_B = '22222222-2222-4222-8222-222222222222';
export const CONN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const CONN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export interface TestEnv {
  tdb: TestDatabase;
  owner: Pool;
  db: TenantDb;
  stop(): Promise<void>;
}

/** Fresh database with two orgs (A in New York time, B in UTC), one store connection each. */
export async function startEnv(): Promise<TestEnv> {
  const tdb = await startTestDatabase();
  const owner = new Pool({ connectionString: tdb.ownerUrl });
  await owner.query(
    `insert into orgs (id, name, slug, timezone) values ($1, 'Org A', 'org-a', 'America/New_York'), ($2, 'Org B', 'org-b', 'UTC')`,
    [ORG_A, ORG_B],
  );
  await owner.query(
    `insert into store_connections (id, org_id, platform, external_account_id, status)
     values ($1, $3, 'shopify', 'shop-a', 'active'), ($2, $4, 'shopify', 'shop-b', 'active')`,
    [CONN_A, CONN_B, ORG_A, ORG_B],
  );
  const db = createTenantDb(tdb.appUrl);
  return {
    tdb, owner, db,
    stop: async () => {
      await db.close();
      await owner.end();
      await tdb.stop();
    },
  };
}

export async function seedSku(owner: Pool, orgId: string, code: string, price = 2500): Promise<string> {
  const p = await owner.query(`insert into products (org_id, title) values ($1, $2) returning id`, [orgId, `Product ${code}`]);
  const s = await owner.query(
    `insert into skus (org_id, product_id, sku_code, selling_price_cents) values ($1, $2, $3, $4) returning id`,
    [orgId, p.rows[0].id, code, price],
  );
  return s.rows[0].id as string;
}

export async function seedCost(
  owner: Pool, orgId: string, skuId: string, cents: number,
  opts: { from?: string; to?: string | null; type?: string; perUnit?: boolean; currency?: string } = {},
): Promise<void> {
  await owner.query(
    `insert into sku_cost_components (org_id, sku_id, component_type, amount_cents, per_unit, currency, effective_from, effective_to)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [orgId, skuId, opts.type ?? 'product_cost', cents, opts.perUnit ?? true, opts.currency ?? 'USD', opts.from ?? '2026-01-01', opts.to ?? null],
  );
}

export async function seedListing(owner: Pool, orgId: string, connectionId: string, skuId: string, variantId: string): Promise<void> {
  await owner.query(
    `insert into sku_channel_listings (org_id, sku_id, store_connection_id, external_product_id, external_variant_id)
     values ($1, $2, $3, $4, $5)`,
    [orgId, skuId, connectionId, `p-${variantId}`, variantId],
  );
}

export async function seedOrder(
  owner: Pool,
  o: {
    orgId: string; connectionId: string; externalId: string; placedAt: string; currency?: string;
    lines: { skuId: string | null; qty: number; price?: number; externalLineId?: string }[];
  },
): Promise<string> {
  const { rows } = await owner.query(
    `insert into orders (org_id, store_connection_id, external_order_id, channel, status, placed_at, currency, gross_cents, discount_cents,
       shipping_charged_cents, tax_cents, refund_cents, net_cents, external_updated_at)
     values ($1, $2, $3, 'shopify_online', 'closed', $4, $5, 0, 0, 0, 0, 0, 0, $4) returning id`,
    [o.orgId, o.connectionId, o.externalId, o.placedAt, o.currency ?? 'USD'],
  );
  const orderId = rows[0].id as string;
  for (const [i, l] of o.lines.entries()) {
    await owner.query(
      `insert into order_lines (org_id, order_id, sku_id, external_line_id, title, quantity, unit_price_cents)
       values ($1, $2, $3, $4, 'Line', $5, $6)`,
      [o.orgId, orderId, l.skuId, l.externalLineId ?? `l-${i + 1}`, l.qty, l.price ?? 1000],
    );
  }
  return orderId;
}
```

`packages/sync/test/memory.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { InMemoryJobQueue, MemoryRateLimiter } from '../src/memory';
import { DEFAULT_RATE_LIMIT_POLICY, RATE_LIMIT_POLICIES, policyFor } from '../src/policies';

const policy = { capacity: 3, refillPerSecond: 1, costPerPage: 1 };

describe('MemoryRateLimiter (token bucket)', () => {
  it('allows up to capacity, then tells the caller how long to wait', async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(() => now);
    for (let i = 0; i < 3; i++) expect(await limiter.take('k', 1, policy)).toEqual({ allowed: true });
    expect(await limiter.take('k', 1, policy)).toEqual({ allowed: false, retryAfterMs: 1000 });
  });
  it('refills over time, never above capacity', async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(() => now);
    for (let i = 0; i < 3; i++) await limiter.take('k', 1, policy);
    now = 1000;
    expect(await limiter.take('k', 1, policy)).toEqual({ allowed: true });
    expect((await limiter.take('k', 1, policy)).allowed).toBe(false);
    now = 3_600_000;
    for (let i = 0; i < 3; i++) expect((await limiter.take('k', 1, policy)).allowed).toBe(true);
    expect((await limiter.take('k', 1, policy)).allowed).toBe(false);
  });
  it('keeps keys independent', async () => {
    const limiter = new MemoryRateLimiter(() => 0);
    for (let i = 0; i < 3; i++) await limiter.take('a', 1, policy);
    expect((await limiter.take('a', 1, policy)).allowed).toBe(false);
    expect((await limiter.take('b', 1, policy)).allowed).toBe(true);
  });
  it('supports costs above 1 and rejects costs above capacity', async () => {
    const limiter = new MemoryRateLimiter(() => 0);
    expect(await limiter.take('k', 2, policy)).toEqual({ allowed: true });
    expect(await limiter.take('k', 2, policy)).toEqual({ allowed: false, retryAfterMs: 1000 });
    await expect(limiter.take('k', 4, policy)).rejects.toThrow(RangeError);
  });
});

describe('InMemoryJobQueue', () => {
  const job = { orgId: 'o', connectionId: 'c', resource: 'orders' as const, syncRunId: 'r' };
  it('is FIFO and records delays', async () => {
    const q = new InMemoryJobQueue();
    await q.enqueue(job);
    await q.enqueue({ ...job, resource: 'products' }, { delayMs: 500 });
    expect(q.size).toBe(2);
    expect(q.take()).toEqual({ job, delayMs: 0 });
    expect(q.take()?.delayMs).toBe(500);
    expect(q.take()).toBeUndefined();
  });
});

describe('policies', () => {
  it('uses the platform policy or the default', () => {
    expect(policyFor('shopify')).toEqual(RATE_LIMIT_POLICIES.shopify);
    expect(policyFor('woocommerce')).toEqual(DEFAULT_RATE_LIMIT_POLICY);
    expect(policyFor('shopify', { shopify: { capacity: 1, refillPerSecond: 1, costPerPage: 1 } }).capacity).toBe(1);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm install && pnpm turbo run test --filter=@erq/sync`
Expected: FAIL (modules do not exist).

- [ ] **Step 4: Implement**

`packages/sync/src/ports.ts`:

```ts
import type { SyncResource } from '@erq/connectors';

export type SyncMode = 'backfill' | 'incremental';

/** The rest of an `all` sync: resources run one after another in dependency order. */
export interface SyncChain {
  resources: SyncResource[];
  mode: SyncMode;
  /** ISO timestamp for backfill runs, otherwise null. */
  since: string | null;
}

/** Only ids travel through the queue. Never credentials. */
export interface SyncPageJob {
  orgId: string;
  connectionId: string;
  resource: SyncResource;
  syncRunId: string;
  then?: SyncChain;
}

export interface RateLimitPolicy {
  capacity: number;
  refillPerSecond: number;
  costPerPage: number;
}
export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterMs: number };
export interface RateLimiter {
  take(key: string, cost: number, policy: RateLimitPolicy): Promise<RateLimitDecision>;
}

export interface JobQueue {
  enqueue(job: SyncPageJob, opts?: { delayMs?: number }): Promise<void>;
}

export type PageResult =
  | { kind: 'next'; job: SyncPageJob }
  | { kind: 'done'; followUp?: SyncPageJob }
  | { kind: 'delayed'; delayMs: number }
  | { kind: 'failed'; reason: string };
```

`packages/sync/src/policies.ts`:

```ts
import type { RateLimitPolicy } from './ports';

/** Conservative generic default. Real per-platform limits are set in 1b-2/1b-3 after reading each platform's current documentation. */
export const DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicy = { capacity: 10, refillPerSecond: 2, costPerPage: 1 };

export const RATE_LIMIT_POLICIES: Record<string, RateLimitPolicy> = {
  shopify: { capacity: 10, refillPerSecond: 2, costPerPage: 1 },
};

export function policyFor(platform: string, overrides: Record<string, RateLimitPolicy> = {}): RateLimitPolicy {
  return overrides[platform] ?? RATE_LIMIT_POLICIES[platform] ?? DEFAULT_RATE_LIMIT_POLICY;
}
```

`packages/sync/src/memory.ts`:

```ts
import type { JobQueue, RateLimitDecision, RateLimitPolicy, RateLimiter, SyncPageJob } from './ports';

export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly clock: () => number = Date.now) {}

  async take(key: string, cost: number, policy: RateLimitPolicy): Promise<RateLimitDecision> {
    if (cost > policy.capacity) throw new RangeError(`cost ${cost} exceeds bucket capacity ${policy.capacity}`);
    const now = this.clock();
    const bucket = this.buckets.get(key) ?? { tokens: policy.capacity, at: now };
    const refilled = Math.min(policy.capacity, bucket.tokens + ((now - bucket.at) / 1000) * policy.refillPerSecond);
    if (refilled >= cost) {
      this.buckets.set(key, { tokens: refilled - cost, at: now });
      return { allowed: true };
    }
    this.buckets.set(key, { tokens: refilled, at: now });
    return { allowed: false, retryAfterMs: Math.ceil(((cost - refilled) / policy.refillPerSecond) * 1000) };
  }
}

export class InMemoryJobQueue implements JobQueue {
  private readonly jobs: { job: SyncPageJob; delayMs: number }[] = [];

  async enqueue(job: SyncPageJob, opts: { delayMs?: number } = {}): Promise<void> {
    this.jobs.push({ job, delayMs: opts.delayMs ?? 0 });
  }
  get size(): number {
    return this.jobs.length;
  }
  take(): { job: SyncPageJob; delayMs: number } | undefined {
    return this.jobs.shift();
  }
}
```

`packages/sync/src/index.ts`:

```ts
export * from './ports';
export * from './policies';
export * from './memory';
```

- [ ] **Step 5: Run to verify pass, then commit**

Run: `pnpm turbo run test typecheck build --filter=@erq/sync` then `pnpm lint`
Expected: PASS (only the memory tests run; the helpers file is imported by later tasks).

```bash
git add -A && git commit -m "feat(sync): add sync package with ports, rate-limit policies and in-memory implementations"
```

---

### Task 7: Cost snapshots and `repriceOrderLines`

**Files:**
- Create: `packages/sync/src/cogs.ts`; modify `packages/sync/src/index.ts`
- Test: `packages/sync/test/cogs.test.ts`

**Interfaces:**
- Consumes: `isCostInEffect`, `landedCost`, `CostComponent` from `@erq/metrics`; tables from `@erq/db`.
- Produces: `toOrgDate(instant: Date, timeZone: string): string` (YYYY-MM-DD), `CostRow`, `loadCostRows(tx, skuIds): Promise<Map<string, CostRow[]>>`, `snapshotUnitCogs(rows: CostRow[] | undefined, placedOn: string, currency: string): number | null`, `repriceOrderLines(tx, { orgId, skuId, from? }): Promise<number>` (number of lines changed).

- [ ] **Step 1: Write the failing tests**

`packages/sync/test/cogs.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orderLines } from '@erq/db';
import { eq } from 'drizzle-orm';
import { loadCostRows, repriceOrderLines, snapshotUnitCogs, toOrgDate, type CostRow } from '../src/cogs';
import { CONN_A, ORG_A, seedCost, seedOrder, seedSku, startEnv, type TestEnv } from './helpers';

const row = (over: Partial<CostRow> = {}): CostRow => ({
  skuId: 's', componentType: 'product_cost', amountCents: 800, perUnit: true, currency: 'USD',
  effectiveFrom: '2026-01-01', effectiveTo: null, ...over,
});

describe('toOrgDate', () => {
  it('uses the org timezone, not UTC', () => {
    expect(toOrgDate(new Date('2026-03-01T03:30:00Z'), 'America/New_York')).toBe('2026-02-28');
    expect(toOrgDate(new Date('2026-03-01T03:30:00Z'), 'UTC')).toBe('2026-03-01');
    expect(toOrgDate(new Date('2026-03-08T06:30:00Z'), 'America/New_York')).toBe('2026-03-08'); // day of the DST switch
    expect(toOrgDate(new Date('2026-11-01T04:30:00Z'), 'America/New_York')).toBe('2026-11-01');
  });
  it('rejects an unknown timezone', () => {
    expect(() => toOrgDate(new Date(), 'Mars/Olympus')).toThrow(RangeError);
  });
});

describe('snapshotUnitCogs', () => {
  it('sums the components in effect on the order date', () => {
    const rows = [row(), row({ componentType: 'inbound_freight', amountCents: 100 })];
    expect(snapshotUnitCogs(rows, '2026-09-05', 'USD')).toBe(900);
  });
  it('respects cost versions and their boundaries', () => {
    const rows = [row({ amountCents: 700, effectiveTo: '2026-06-01' }), row({ amountCents: 900, effectiveFrom: '2026-06-01' })];
    expect(snapshotUnitCogs(rows, '2026-05-31', 'USD')).toBe(700);
    expect(snapshotUnitCogs(rows, '2026-06-01', 'USD')).toBe(900);
  });
  it('is null (never zero) when the cost is unknown', () => {
    expect(snapshotUnitCogs(undefined, '2026-09-05', 'USD')).toBeNull();
    expect(snapshotUnitCogs([], '2026-09-05', 'USD')).toBeNull();
    expect(snapshotUnitCogs([row()], '2025-12-31', 'USD')).toBeNull(); // before any cost existed
  });
  it('is null when a component in effect is per-batch or in another currency', () => {
    expect(snapshotUnitCogs([row(), row({ perUnit: false, componentType: 'inbound_freight', amountCents: 5000 })], '2026-09-05', 'USD')).toBeNull();
    expect(snapshotUnitCogs([row({ currency: 'EUR' })], '2026-09-05', 'USD')).toBeNull();
  });
  it('treats a genuine zero cost as zero, not unknown', () => {
    expect(snapshotUnitCogs([row({ amountCents: 0 })], '2026-09-05', 'USD')).toBe(0);
  });
});

describe('repriceOrderLines', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await startEnv(); });
  afterAll(async () => { await env?.stop(); });

  const snapshots = async (orderId: string) =>
    env.db.withTenant(ORG_A, (tx) => tx.select({ ext: orderLines.externalLineId, s: orderLines.unitCogsCentsSnapshot }).from(orderLines).where(eq(orderLines.orderId, orderId)));

  it('fills snapshots after costs are added, only from the given date, and recomputes when costs change', async () => {
    const sku = await seedSku(env.owner, ORG_A, 'REPRICE-1');
    const early = await seedOrder(env.owner, { orgId: ORG_A, connectionId: CONN_A, externalId: 'old', placedAt: '2026-02-10T15:00:00Z', lines: [{ skuId: sku, qty: 1 }] });
    const late = await seedOrder(env.owner, { orgId: ORG_A, connectionId: CONN_A, externalId: 'new', placedAt: '2026-09-10T15:00:00Z', lines: [{ skuId: sku, qty: 2 }, { skuId: null, qty: 1 }] });
    expect((await snapshots(late)).map((l) => l.s)).toEqual([null, null]);

    await seedCost(env.owner, ORG_A, sku, 800, { from: '2026-01-01' });
    const changed = await env.db.withTenant(ORG_A, (tx) => repriceOrderLines(tx, { orgId: ORG_A, skuId: sku, from: new Date('2026-06-01T00:00:00Z') }));
    expect(changed).toBe(1); // only the late order's mapped line
    expect((await snapshots(early))[0]!.s).toBeNull();
    const lateSnaps = await snapshots(late);
    expect(lateSnaps.find((l) => l.ext === 'l-1')!.s).toBe(800);
    expect(lateSnaps.find((l) => l.ext === 'l-2')!.s).toBeNull(); // unmapped line untouched

    expect(await env.db.withTenant(ORG_A, (tx) => repriceOrderLines(tx, { orgId: ORG_A, skuId: sku }))).toBe(1); // early order now filled; late unchanged
    expect((await snapshots(early))[0]!.s).toBe(800);

    await env.owner.query(`update sku_cost_components set effective_to = '2026-03-01' where sku_id = $1`, [sku]);
    await seedCost(env.owner, ORG_A, sku, 950, { from: '2026-03-01' });
    await env.db.withTenant(ORG_A, (tx) => repriceOrderLines(tx, { orgId: ORG_A, skuId: sku }));
    expect((await snapshots(early))[0]!.s).toBe(800);
    expect((await snapshots(late)).find((l) => l.ext === 'l-1')!.s).toBe(950);
  });

  it('loads cost rows only for the requested skus', async () => {
    const a = await seedSku(env.owner, ORG_A, 'LOAD-A');
    const b = await seedSku(env.owner, ORG_A, 'LOAD-B');
    await seedCost(env.owner, ORG_A, a, 100);
    const map = await env.db.withTenant(ORG_A, (tx) => loadCostRows(tx, [a, b]));
    expect(map.get(a)).toHaveLength(1);
    expect(map.get(b)).toBeUndefined();
    expect(await env.db.withTenant(ORG_A, (tx) => loadCostRows(tx, []))).toEqual(new Map());
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm turbo run test --filter=@erq/sync -- cogs`
Expected: FAIL (`../src/cogs` does not exist).

- [ ] **Step 3: Implement**

`packages/sync/src/cogs.ts`:

```ts
import { and, eq, gte, inArray } from 'drizzle-orm';
import { orderLines, orders, orgs, skuCostComponents, type Tx } from '@erq/db';
import { isCostInEffect, landedCost, type CostComponent } from '@erq/metrics';

export interface CostRow {
  skuId: string;
  componentType: string;
  amountCents: number;
  perUnit: boolean;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** The calendar date of an instant in the org's timezone (YYYY-MM-DD). */
export function toOrgDate(instant: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
  } catch {
    throw new RangeError(`unknown timezone: ${timeZone}`);
  }
}

export async function loadCostRows(tx: Tx, skuIds: string[]): Promise<Map<string, CostRow[]>> {
  const result = new Map<string, CostRow[]>();
  if (skuIds.length === 0) return result;
  const rows = await tx
    .select({
      skuId: skuCostComponents.skuId, componentType: skuCostComponents.componentType, amountCents: skuCostComponents.amountCents,
      perUnit: skuCostComponents.perUnit, currency: skuCostComponents.currency,
      effectiveFrom: skuCostComponents.effectiveFrom, effectiveTo: skuCostComponents.effectiveTo,
    })
    .from(skuCostComponents)
    .where(inArray(skuCostComponents.skuId, skuIds));
  for (const r of rows) {
    const list = result.get(r.skuId) ?? [];
    list.push({ ...r, currency: r.currency.trim() });
    result.set(r.skuId, list);
  }
  return result;
}

/**
 * Landed cost per unit in effect on `placedOn`, or null when it is unknown: no component in effect,
 * a per-batch component in effect, or a component in another currency. Null is never silently zero.
 */
export function snapshotUnitCogs(rows: CostRow[] | undefined, placedOn: string, currency: string): number | null {
  if (!rows) return null;
  const inEffect = rows.filter((r) => isCostInEffect(r, placedOn));
  if (inEffect.length === 0) return null;
  if (inEffect.some((r) => !r.perUnit || r.currency !== currency)) return null;
  const components: CostComponent[] = inEffect.map((r) => ({
    componentType: r.componentType, amountCents: r.amountCents, currency: r.currency,
    effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo,
  }));
  return landedCost(components, placedOn, currency).cents;
}

/**
 * Recomputes the cost snapshot of every order line of a SKU (optionally only for orders placed at or after `from`).
 * Call it after costs are added or edited. Returns the number of lines whose snapshot changed.
 */
export async function repriceOrderLines(tx: Tx, args: { orgId: string; skuId: string; from?: Date }): Promise<number> {
  const [org] = await tx.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, args.orgId));
  if (!org) return 0;
  const rows = (await loadCostRows(tx, [args.skuId])).get(args.skuId);
  const lines = await tx
    .select({ id: orderLines.id, snapshot: orderLines.unitCogsCentsSnapshot, placedAt: orders.placedAt, currency: orders.currency })
    .from(orderLines)
    .innerJoin(orders, and(eq(orders.orgId, orderLines.orgId), eq(orders.id, orderLines.orderId)))
    .where(and(eq(orderLines.skuId, args.skuId), args.from ? gte(orders.placedAt, args.from) : undefined));
  let changed = 0;
  for (const line of lines) {
    const next = snapshotUnitCogs(rows, toOrgDate(line.placedAt, org.timezone), line.currency.trim());
    if (next !== line.snapshot) {
      await tx.update(orderLines).set({ unitCogsCentsSnapshot: next }).where(eq(orderLines.id, line.id));
      changed++;
    }
  }
  return changed;
}
```

Append `export * from './cogs';` to `packages/sync/src/index.ts`.

- [ ] **Step 4: Run to verify pass, then commit**

Run: `pnpm turbo run test typecheck build --filter=@erq/sync` then `pnpm lint`
Expected: PASS. (The reprice test's first call changes exactly one line because the early order is before `from` and the unmapped line has no SKU.)

```bash
git add -A && git commit -m "feat(sync): add cost snapshots in the org timezone and repriceOrderLines"
```

---

### Task 8: Sink context and the locations and products sinks

**Files:**
- Create: `packages/sync/src/sinks/{context.ts,util.ts,locations.ts,products.ts}`; modify `packages/sync/src/index.ts`
- Modify: `packages/sync/test/helpers.ts` (add `sinkContext`)
- Test: `packages/sync/test/sinks-products.test.ts`

**Interfaces:**
- Produces: `SinkContext { orgId; connectionId; syncRunId; timezone; now: Date; costEffectiveFrom: string }`, `SinkResult { processed: number; skipped: number }`, `dedupeLatest(items, key, updatedAt?)`, `upsertLocations(tx, ctx, items): Promise<SinkResult>`, `upsertProducts(tx, ctx, items): Promise<SinkResult>`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/sync/test/helpers.ts`:

```ts
import type { SinkContext } from '../src/sinks/context';

export const sinkContext = (over: Partial<SinkContext> = {}): SinkContext => ({
  orgId: ORG_A, connectionId: CONN_A, syncRunId: '99999999-9999-4999-8999-999999999999',
  timezone: 'America/New_York', now: new Date('2026-10-06T12:00:00Z'), costEffectiveFrom: '2026-01-01', ...over,
});
```

`packages/sync/test/sinks-products.test.ts`:

```ts
import { sampleData } from '@erq/connectors/testing';
import type { NormalizedProduct } from '@erq/connectors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertLocations } from '../src/sinks/locations';
import { upsertProducts } from '../src/sinks/products';
import { CONN_A, ORG_A, ORG_B, seedCost, seedSku, sinkContext, startEnv, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => { env = await startEnv(); });
afterAll(async () => { await env?.stop(); });

const count = async (table: string, orgId = ORG_A) =>
  Number((await env.owner.query(`select count(*) c from ${table} where org_id = $1`, [orgId])).rows[0].c);
const run = (items: NormalizedProduct[], ctx = sinkContext()) => env.db.withTenant(ctx.orgId, (tx) => upsertProducts(tx, ctx, items));

describe('upsertLocations', () => {
  it('upserts by external id and is idempotent', async () => {
    const { locations } = sampleData();
    const ctx = sinkContext();
    const first = await env.db.withTenant(ORG_A, (tx) => upsertLocations(tx, ctx, locations));
    expect(first).toEqual({ processed: 2, skipped: 0 });
    await env.db.withTenant(ORG_A, (tx) => upsertLocations(tx, ctx, [{ ...locations[0]!, name: 'Renamed' }, locations[1]!, locations[1]!]));
    expect(await count('locations')).toBe(2);
    const { rows } = await env.owner.query(`select name, source, type from locations where org_id = $1 and external_id = 'loc-1'`, [ORG_A]);
    expect(rows[0]).toEqual({ name: 'Renamed', source: 'shopify', type: 'warehouse' });
  });
  it("cannot write another tenant's connection", async () => {
    await expect(
      env.db.withTenant(ORG_B, (tx) => upsertLocations(tx, sinkContext({ orgId: ORG_B, connectionId: CONN_A }), sampleData().locations)),
    ).rejects.toBeTruthy();
  });
});

describe('upsertProducts', () => {
  const [tshirt, poster, mug] = sampleData().products as [NormalizedProduct, NormalizedProduct, NormalizedProduct];

  it('creates products, SKUs, listings and imported product costs', async () => {
    expect(await run([tshirt, poster, mug])).toEqual({ processed: 3, skipped: 0 });
    expect(await count('products')).toBeGreaterThanOrEqual(3);
    const skus = await env.owner.query(`select sku_code, selling_price_cents, currency from skus where org_id = $1 and sku_code in ('TSHIRT-S','TSHIRT-M','MUG-1','shopify-v-3') order by sku_code`, [ORG_A]);
    expect(skus.rows.map((r) => r.sku_code)).toEqual(['MUG-1', 'TSHIRT-M', 'TSHIRT-S', 'shopify-v-3']); // blank skuCode gets a stable fallback
    expect(Number(skus.rows.find((r) => r.sku_code === 'TSHIRT-S').selling_price_cents)).toBe(2500);
    const listings = await env.owner.query(`select external_variant_id from sku_channel_listings where org_id = $1 and store_connection_id = $2 order by 1`, [ORG_A, CONN_A]);
    expect(listings.rows.map((r) => r.external_variant_id)).toEqual(['v-1', 'v-2', 'v-3', 'v-4']);
    const costs = await env.owner.query(
      `select s.sku_code, c.amount_cents, c.effective_from::text as effective_from, c.per_unit from sku_cost_components c join skus s on s.id = c.sku_id where c.org_id = $1 and c.component_type = 'product_cost' order by s.sku_code`, [ORG_A]);
    expect(costs.rows.map((r) => [r.sku_code, Number(r.amount_cents), r.effective_from, r.per_unit])).toEqual(
      expect.arrayContaining([['MUG-1', 300, '2026-01-01', true], ['TSHIRT-S', 800, '2026-01-01', true]]),
    );
    expect(costs.rows.some((r) => r.sku_code === 'shopify-v-3')).toBe(false); // unitCostCents null: no component
  });

  it('is idempotent: replaying changes nothing', async () => {
    const before = [await count('products'), await count('skus'), await count('sku_channel_listings'), await count('sku_cost_components')];
    await run([tshirt, poster, mug]);
    expect([await count('products'), await count('skus'), await count('sku_channel_listings'), await count('sku_cost_components')]).toEqual(before);
  });

  it('applies newer updates and ignores older ones', async () => {
    const newer: NormalizedProduct = {
      ...tshirt, title: 'Logo Tee v2', updatedAt: new Date('2026-09-20T10:00:00Z'),
      variants: tshirt.variants.map((v) => ({ ...v, priceCents: 2900, updatedAt: new Date('2026-09-20T10:00:00Z') })),
    };
    await run([newer]);
    const read = async () => (await env.owner.query(`select s.selling_price_cents p, p.title t from skus s join products p on p.id = s.product_id where s.org_id = $1 and s.sku_code = 'TSHIRT-S'`, [ORG_A])).rows[0];
    expect(Number((await read()).p)).toBe(2900);
    expect((await read()).t).toBe('Logo Tee v2');
    await run([tshirt]); // older snapshot arrives late
    expect(Number((await read()).p)).toBe(2900);
    expect((await read()).t).toBe('Logo Tee v2');
  });

  it('links to an existing SKU with the same code instead of duplicating it, without creating a product', async () => {
    const manual = await seedSku(env.owner, ORG_A, 'MANUAL-1', 1500);
    const productsBefore = await count('products');
    const incoming: NormalizedProduct = {
      externalId: 'p-link', title: 'Linked', brand: null, category: null, status: 'active', updatedAt: new Date('2026-09-01T00:00:00Z'),
      variants: [{ externalId: 'v-link', skuCode: 'MANUAL-1', barcode: null, priceCents: 1800, compareAtPriceCents: null, currency: 'USD', unitCostCents: null, updatedAt: new Date('2026-09-01T00:00:00Z') }],
    };
    await run([incoming]);
    expect(await count('products')).toBe(productsBefore);
    const { rows } = await env.owner.query(`select sku_id from sku_channel_listings where org_id = $1 and external_variant_id = 'v-link'`, [ORG_A]);
    expect(rows[0].sku_id).toBe(manual);
  });

  it('never overwrites an existing product cost with the imported one', async () => {
    const sku = await seedSku(env.owner, ORG_A, 'OWNER-COST');
    await seedCost(env.owner, ORG_A, sku, 500);
    const incoming: NormalizedProduct = {
      externalId: 'p-cost', title: 'Costed', brand: null, category: null, status: 'active', updatedAt: new Date('2026-09-01T00:00:00Z'),
      variants: [{ externalId: 'v-cost', skuCode: 'OWNER-COST', barcode: null, priceCents: 1000, compareAtPriceCents: null, currency: 'USD', unitCostCents: 800, updatedAt: new Date('2026-09-01T00:00:00Z') }],
    };
    await run([incoming]);
    const { rows } = await env.owner.query(`select amount_cents from sku_cost_components where sku_id = $1`, [sku]);
    expect(rows.map((r) => Number(r.amount_cents))).toEqual([500]);
  });

  it('skips products without variants and keeps tenants apart', async () => {
    expect(await run([{ ...mug, externalId: 'p-empty', variants: [] }])).toEqual({ processed: 0, skipped: 1 });
    expect(await count('skus', ORG_B)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm turbo run test --filter=@erq/sync -- sinks-products`
Expected: FAIL (sink modules do not exist).

- [ ] **Step 3: Implement**

`packages/sync/src/sinks/context.ts`:

```ts
export interface SinkContext {
  orgId: string;
  connectionId: string;
  syncRunId: string;
  /** IANA timezone of the org; order dates for cost snapshots are computed in it. */
  timezone: string;
  now: Date;
  /** YYYY-MM-DD: effective_from for product costs imported from the platform. */
  costEffectiveFrom: string;
}

export interface SinkResult {
  /** Items applied (inserted or updated). */
  processed: number;
  /** Items that could not be applied (unmapped references) or were stale. */
  skipped: number;
}
```

`packages/sync/src/sinks/util.ts`:

```ts
/** Keeps one item per key: the one with the latest `updatedAt` (the last one when there is none). */
export function dedupeLatest<T>(items: T[], key: (item: T) => string, updatedAt?: (item: T) => Date): T[] {
  const best = new Map<string, T>();
  for (const item of items) {
    const k = key(item);
    const current = best.get(k);
    if (!current || !updatedAt || updatedAt(item) >= updatedAt(current)) best.set(k, item);
  }
  return [...best.values()];
}
```

`packages/sync/src/sinks/locations.ts`:

```ts
import { sql } from 'drizzle-orm';
import type { NormalizedLocation } from '@erq/connectors';
import { locations, type Tx } from '@erq/db';
import type { SinkContext, SinkResult } from './context';
import { dedupeLatest } from './util';

export async function upsertLocations(tx: Tx, ctx: SinkContext, items: NormalizedLocation[]): Promise<SinkResult> {
  const unique = dedupeLatest(items, (l) => l.externalId);
  if (unique.length === 0) return { processed: 0, skipped: 0 };
  await tx
    .insert(locations)
    .values(
      unique.map((l) => ({
        orgId: ctx.orgId, storeConnectionId: ctx.connectionId, externalId: l.externalId, name: l.name, type: l.type,
        address: l.address, source: 'shopify' as const, isActive: l.isActive,
      })),
    )
    .onConflictDoUpdate({
      target: [locations.orgId, locations.storeConnectionId, locations.externalId],
      targetWhere: sql`${locations.externalId} is not null`,
      set: { name: sql`excluded.name`, type: sql`excluded.type`, address: sql`excluded.address`, isActive: sql`excluded.is_active` },
    });
  return { processed: unique.length, skipped: 0 };
}
```

`packages/sync/src/sinks/products.ts`:

```ts
import { and, eq, inArray } from 'drizzle-orm';
import type { NormalizedProduct } from '@erq/connectors';
import { products, skuChannelListings, skuCostComponents, skus, type Tx } from '@erq/db';
import type { SinkContext, SinkResult } from './context';
import { dedupeLatest } from './util';

export async function upsertProducts(tx: Tx, ctx: SinkContext, items: NormalizedProduct[]): Promise<SinkResult> {
  let processed = 0;
  let skipped = 0;
  for (const product of dedupeLatest(items, (p) => p.externalId, (p) => p.updatedAt)) {
    if (product.variants.length === 0) {
      skipped++;
      continue;
    }
    await upsertProduct(tx, ctx, product);
    processed++;
  }
  return { processed, skipped };
}

async function upsertProduct(tx: Tx, ctx: SinkContext, product: NormalizedProduct): Promise<void> {
  const variants = dedupeLatest(product.variants, (v) => v.externalId, (v) => v.updatedAt);
  const existing = await tx
    .select({
      externalVariantId: skuChannelListings.externalVariantId, skuId: skuChannelListings.skuId,
      listingUpdatedAt: skuChannelListings.externalUpdatedAt, productId: skus.productId,
    })
    .from(skuChannelListings)
    .innerJoin(skus, and(eq(skus.orgId, skuChannelListings.orgId), eq(skus.id, skuChannelListings.skuId)))
    .where(and(eq(skuChannelListings.storeConnectionId, ctx.connectionId), inArray(skuChannelListings.externalVariantId, variants.map((v) => v.externalId))));
  const byVariant = new Map(existing.map((e) => [e.externalVariantId, e]));

  let productId: string | undefined = existing[0]?.productId;
  if (productId) {
    const newest = existing.reduce<Date | null>((m, e) => (e.listingUpdatedAt && (!m || e.listingUpdatedAt > m) ? e.listingUpdatedAt : m), null);
    if (!newest || product.updatedAt >= newest) {
      await tx.update(products).set({ title: product.title, brand: product.brand, category: product.category, status: product.status }).where(eq(products.id, productId));
    }
  }
  const ensureProduct = async (): Promise<string> => {
    if (!productId) {
      const [created] = await tx
        .insert(products)
        .values({ orgId: ctx.orgId, title: product.title, brand: product.brand, category: product.category, status: product.status })
        .returning({ id: products.id });
      productId = created!.id;
    }
    return productId;
  };

  for (const variant of variants) {
    const listing = byVariant.get(variant.externalId);
    let skuId: string;
    if (listing) {
      skuId = listing.skuId;
      if (!listing.listingUpdatedAt || variant.updatedAt >= listing.listingUpdatedAt) {
        await tx
          .update(skus)
          .set({ sellingPriceCents: variant.priceCents, compareAtPriceCents: variant.compareAtPriceCents, barcode: variant.barcode, currency: variant.currency })
          .where(eq(skus.id, skuId));
        await tx
          .update(skuChannelListings)
          .set({ channelPriceCents: variant.priceCents, currency: variant.currency, externalProductId: product.externalId, externalUpdatedAt: variant.updatedAt })
          .where(and(eq(skuChannelListings.storeConnectionId, ctx.connectionId), eq(skuChannelListings.externalVariantId, variant.externalId)));
      }
    } else {
      const skuCode = variant.skuCode?.trim() || `shopify-${variant.externalId}`;
      const [linked] = await tx.select({ id: skus.id }).from(skus).where(eq(skus.skuCode, skuCode));
      if (linked) {
        skuId = linked.id;
      } else {
        const [created] = await tx
          .insert(skus)
          .values({
            orgId: ctx.orgId, productId: await ensureProduct(), skuCode, barcode: variant.barcode, sellingPriceCents: variant.priceCents,
            compareAtPriceCents: variant.compareAtPriceCents, currency: variant.currency,
          })
          .returning({ id: skus.id });
        skuId = created!.id;
      }
      await tx.insert(skuChannelListings).values({
        orgId: ctx.orgId, skuId, storeConnectionId: ctx.connectionId, externalProductId: product.externalId,
        externalVariantId: variant.externalId, channelPriceCents: variant.priceCents, currency: variant.currency, externalUpdatedAt: variant.updatedAt,
      });
    }

    if (variant.unitCostCents !== null) {
      const [hasCost] = await tx
        .select({ id: skuCostComponents.id })
        .from(skuCostComponents)
        .where(and(eq(skuCostComponents.skuId, skuId), eq(skuCostComponents.componentType, 'product_cost')))
        .limit(1);
      if (!hasCost) {
        await tx.insert(skuCostComponents).values({
          orgId: ctx.orgId, skuId, componentType: 'product_cost', amountCents: variant.unitCostCents, perUnit: true,
          currency: variant.currency, effectiveFrom: ctx.costEffectiveFrom, effectiveTo: null,
        });
      }
    }
  }
}
```

Append to `packages/sync/src/index.ts`:

```ts
export * from './sinks/context';
export * from './sinks/util';
export * from './sinks/locations';
export * from './sinks/products';
```

- [ ] **Step 4: Run to verify pass, then commit**

Run: `pnpm turbo run test typecheck build --filter=@erq/sync` then `pnpm lint`
Expected: PASS. If Drizzle rejects `targetWhere` or `onConflictDoUpdate` typing for the partial unique index, use the installed Drizzle's documented equivalent and report it; the SQL semantics (`ON CONFLICT (org_id, store_connection_id, external_id) WHERE external_id IS NOT NULL DO UPDATE`) must not change.

```bash
git add -A && git commit -m "feat(sync): add idempotent location and product sinks"
```

### Task 9: Inventory sink

**Files:**
- Create: `packages/sync/src/sinks/inventory.ts`; modify `packages/sync/src/index.ts`
- Test: `packages/sync/test/sinks-inventory.test.ts`

**Interfaces:**
- Consumes: `SinkContext`, `SinkResult`, `dedupeLatest`; tables `inventoryLevels`, `inventoryMovements`, `locations`, `skuChannelListings`.
- Produces: `upsertInventory(tx, ctx, items: NormalizedInventoryLevel[]): Promise<SinkResult>`. Levels are upserted by (sku, location); a movement (`reason: 'sync_correction'`, `ref_type: 'sync'`, `ref_id: '<runId>:<updatedAt ISO>'`) is written when `on_hand` changes, so the sum of a SKU/location's movements always equals its `on_hand`.

- [ ] **Step 1: Write the failing tests**

`packages/sync/test/sinks-inventory.test.ts`:

```ts
import { sampleData } from '@erq/connectors/testing';
import type { NormalizedInventoryLevel } from '@erq/connectors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertInventory } from '../src/sinks/inventory';
import { upsertLocations } from '../src/sinks/locations';
import { upsertProducts } from '../src/sinks/products';
import { ORG_A, sinkContext, startEnv, type TestEnv } from './helpers';

let env: TestEnv;
const data = sampleData();
beforeAll(async () => {
  env = await startEnv();
  const ctx = sinkContext();
  await env.db.withTenant(ORG_A, async (tx) => {
    await upsertLocations(tx, ctx, data.locations);
    await upsertProducts(tx, ctx, data.products);
  });
});
afterAll(async () => { await env?.stop(); });

const run = (items: NormalizedInventoryLevel[], ctx = sinkContext()) => env.db.withTenant(ORG_A, (tx) => upsertInventory(tx, ctx, items));
const count = async (table: string) => Number((await env.owner.query(`select count(*) c from ${table} where org_id = $1`, [ORG_A])).rows[0].c);
const level = async (variant: string, loc: string) =>
  (await env.owner.query(
    `select l.on_hand, l.reserved, l.incoming from inventory_levels l
       join sku_channel_listings cl on cl.sku_id = l.sku_id and cl.external_variant_id = $1
       join locations lo on lo.id = l.location_id and lo.external_id = $2 where l.org_id = $3`, [variant, loc, ORG_A])).rows[0];

describe('upsertInventory', () => {
  it('creates levels (including negative on_hand) and one opening movement per level', async () => {
    expect(await run(data.inventory)).toEqual({ processed: 6, skipped: 0 });
    expect(await count('inventory_levels')).toBe(6);
    expect(await count('inventory_movements')).toBe(6);
    expect(await level('v-1', 'loc-1')).toEqual({ on_hand: 40, reserved: 2, incoming: 0 });
    expect((await level('v-4', 'loc-2')).on_hand).toBe(-2);
  });

  it('is idempotent: replaying adds no levels and no movements', async () => {
    await run(data.inventory);
    expect(await count('inventory_levels')).toBe(6);
    expect(await count('inventory_movements')).toBe(6);
  });

  it('applies a newer count with a movement for the difference, and ignores an older one', async () => {
    const base = data.inventory[0]!;
    await run([{ ...base, onHand: 35, updatedAt: new Date('2026-09-10T09:00:00Z') }]);
    expect((await level('v-1', 'loc-1')).on_hand).toBe(35);
    expect(await count('inventory_movements')).toBe(7);
    await run([{ ...base, onHand: 99, updatedAt: new Date('2026-09-05T09:00:00Z') }]); // older: ignored
    expect((await level('v-1', 'loc-1')).on_hand).toBe(35);
    expect(await count('inventory_movements')).toBe(7);
  });

  it('updates reserved and incoming without writing a movement when on_hand is unchanged', async () => {
    const base = data.inventory[0]!;
    await run([{ ...base, onHand: 35, reserved: 7, incoming: 3, updatedAt: new Date('2026-09-11T09:00:00Z') }]);
    expect(await level('v-1', 'loc-1')).toEqual({ on_hand: 35, reserved: 7, incoming: 3 });
    expect(await count('inventory_movements')).toBe(7);
  });

  it('skips unknown variants and unknown locations instead of failing the page', async () => {
    const base = data.inventory[0]!;
    const result = await run([
      { ...base, externalVariantId: 'v-unknown' },
      { ...base, locationExternalId: 'loc-unknown' },
      { ...base, onHand: 35, reserved: 7, incoming: 3, updatedAt: new Date('2026-09-11T09:00:00Z') },
    ]);
    expect(result).toEqual({ processed: 1, skipped: 2 });
  });

  it('keeps the ledger consistent: movements always sum to on_hand', async () => {
    const { rows } = await env.owner.query(
      `select l.on_hand, coalesce((select sum(m.delta) from inventory_movements m where m.sku_id = l.sku_id and m.location_id = l.location_id), 0)::int as moved
         from inventory_levels l where l.org_id = $1`, [ORG_A]);
    expect(rows.length).toBe(6);
    for (const r of rows) expect(r.moved).toBe(r.on_hand);
  });

  it('handles an empty page and duplicate rows in one page', async () => {
    expect(await run([])).toEqual({ processed: 0, skipped: 0 });
    const base = data.inventory[3]!;
    expect(await run([base, base])).toEqual({ processed: 1, skipped: 0 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm turbo run test --filter=@erq/sync -- sinks-inventory`
Expected: FAIL (`../src/sinks/inventory` does not exist).

- [ ] **Step 3: Implement**

`packages/sync/src/sinks/inventory.ts`:

```ts
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NormalizedInventoryLevel } from '@erq/connectors';
import { inventoryLevels, inventoryMovements, locations, skuChannelListings, type Tx } from '@erq/db';
import type { SinkContext, SinkResult } from './context';
import { dedupeLatest } from './util';

export async function upsertInventory(tx: Tx, ctx: SinkContext, items: NormalizedInventoryLevel[]): Promise<SinkResult> {
  const unique = dedupeLatest(items, (i) => `${i.externalVariantId}@${i.locationExternalId}`, (i) => i.updatedAt);
  if (unique.length === 0) return { processed: 0, skipped: 0 };

  const variantIds = [...new Set(unique.map((i) => i.externalVariantId))];
  const locationIds = [...new Set(unique.map((i) => i.locationExternalId))];
  const listings = await tx
    .select({ externalVariantId: skuChannelListings.externalVariantId, skuId: skuChannelListings.skuId })
    .from(skuChannelListings)
    .where(and(eq(skuChannelListings.storeConnectionId, ctx.connectionId), inArray(skuChannelListings.externalVariantId, variantIds)));
  const locs = await tx
    .select({ externalId: locations.externalId, id: locations.id })
    .from(locations)
    .where(and(eq(locations.storeConnectionId, ctx.connectionId), inArray(locations.externalId, locationIds)));
  const skuByVariant = new Map(listings.map((l) => [l.externalVariantId, l.skuId]));
  const locByExternal = new Map(locs.flatMap((l) => (l.externalId ? [[l.externalId, l.id] as const] : [])));

  const skuIds = [...new Set(skuByVariant.values())];
  const locIds = [...new Set(locByExternal.values())];
  const existing =
    skuIds.length && locIds.length
      ? await tx
          .select({ skuId: inventoryLevels.skuId, locationId: inventoryLevels.locationId, onHand: inventoryLevels.onHand, updatedAt: inventoryLevels.externalUpdatedAt })
          .from(inventoryLevels)
          .where(and(inArray(inventoryLevels.skuId, skuIds), inArray(inventoryLevels.locationId, locIds)))
      : [];
  const existingByKey = new Map(existing.map((e) => [`${e.skuId}:${e.locationId}`, e]));

  let processed = 0;
  let skipped = 0;
  for (const item of unique) {
    const skuId = skuByVariant.get(item.externalVariantId);
    const locationId = locByExternal.get(item.locationExternalId);
    if (!skuId || !locationId) {
      skipped++;
      continue;
    }
    const prev = existingByKey.get(`${skuId}:${locationId}`);
    if (prev?.updatedAt && prev.updatedAt > item.updatedAt) {
      skipped++;
      continue;
    }
    await tx
      .insert(inventoryLevels)
      .values({
        orgId: ctx.orgId, skuId, locationId, onHand: item.onHand, reserved: item.reserved, incoming: item.incoming,
        externalUpdatedAt: item.updatedAt,
      })
      .onConflictDoUpdate({
        target: [inventoryLevels.orgId, inventoryLevels.skuId, inventoryLevels.locationId],
        set: {
          onHand: sql`excluded.on_hand`, reserved: sql`excluded.reserved`, incoming: sql`excluded.incoming`,
          externalUpdatedAt: sql`excluded.external_updated_at`,
        },
      });
    const delta = item.onHand - (prev?.onHand ?? 0);
    if (delta !== 0) {
      await tx
        .insert(inventoryMovements)
        .values({
          orgId: ctx.orgId, skuId, locationId, delta, reason: 'sync_correction', refType: 'sync',
          refId: `${ctx.syncRunId}:${item.updatedAt.toISOString()}`, occurredAt: item.updatedAt,
        })
        .onConflictDoNothing();
    }
    processed++;
  }
  return { processed, skipped };
}
```

Append `export * from './sinks/inventory';` to `packages/sync/src/index.ts`.

- [ ] **Step 4: Run to verify pass, then commit**

Run: `pnpm turbo run test typecheck build --filter=@erq/sync` then `pnpm lint`
Expected: PASS.

```bash
git add -A && git commit -m "feat(sync): add idempotent inventory sink with derived movements"
```

---

### Task 10: Orders sink (orders, lines, refunds, cost snapshots)

**Files:**
- Create: `packages/sync/src/sinks/orders.ts`; modify `packages/sync/src/index.ts`
- Test: `packages/sync/test/sinks-orders.test.ts`

**Interfaces:**
- Consumes: `loadCostRows`, `snapshotUnitCogs`, `toOrgDate` (Task 7), `dedupeLatest`, `SinkContext`, `SinkResult`.
- Produces: `upsertOrders(tx, ctx, items: NormalizedOrder[]): Promise<SinkResult>`. An order is skipped when the stored `external_updated_at` is newer. Lines map to SKUs through `sku_channel_listings` (unmapped variants keep `sku_id` null until a later pass fills it); snapshots use `coalesce(existing, new)` so they never change once set; `orders.refund_cents` is the sum of refund `amountCents`, `net_cents = gross - discount - refund`, and `order_lines.refunded_quantity` is recomputed from refund lines.

- [ ] **Step 1: Write the failing tests**

`packages/sync/test/sinks-orders.test.ts`:

```ts
import { sampleData } from '@erq/connectors/testing';
import type { NormalizedOrder } from '@erq/connectors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertLocations } from '../src/sinks/locations';
import { upsertOrders } from '../src/sinks/orders';
import { upsertProducts } from '../src/sinks/products';
import { CONN_A, ORG_A, ORG_B, seedCost, sinkContext, startEnv, type TestEnv } from './helpers';

let env: TestEnv;
const data = sampleData();
const [o1, o2, o3, o4, o5] = data.orders as [NormalizedOrder, NormalizedOrder, NormalizedOrder, NormalizedOrder, NormalizedOrder];

beforeAll(async () => {
  env = await startEnv();
  const ctx = sinkContext();
  await env.db.withTenant(ORG_A, async (tx) => {
    await upsertLocations(tx, ctx, data.locations);
    await upsertProducts(tx, ctx, data.products); // TSHIRT-S/M cost 800, MUG-1 cost 300, poster has no cost
  });
});
afterAll(async () => { await env?.stop(); });

const run = (items: NormalizedOrder[], ctx = sinkContext()) => env.db.withTenant(ctx.orgId, (tx) => upsertOrders(tx, ctx, items));
const count = async (table: string) => Number((await env.owner.query(`select count(*) c from ${table} where org_id = $1`, [ORG_A])).rows[0].c);
const order = async (ext: string) => (await env.owner.query(`select * from orders where org_id = $1 and external_order_id = $2`, [ORG_A, ext])).rows[0];
const lines = async (ext: string) =>
  (await env.owner.query(
    `select ol.external_line_id, ol.sku_id, ol.quantity, ol.unit_cogs_cents_snapshot, ol.refunded_quantity
       from order_lines ol join orders o on o.id = ol.order_id where o.org_id = $1 and o.external_order_id = $2 order by 1`, [ORG_A, ext])).rows;

describe('upsertOrders', () => {
  it('stores orders, lines, refunds and cost snapshots', async () => {
    expect(await run([o1, o2, o3, o4, o5])).toEqual({ processed: 5, skipped: 0 });
    expect(await count('orders')).toBe(5);
    expect(await count('order_lines')).toBe(6);
    expect(await count('refunds')).toBe(1);
    expect(await count('refund_lines')).toBe(1);

    const a = await order('o-1');
    expect([a.channel, a.status, Number(a.gross_cents), Number(a.discount_cents), Number(a.refund_cents), Number(a.net_cents)]).toEqual(['shopify_online', 'closed', 7500, 100, 0, 7400]);
    expect(a.customer_external_id).toBe('cust-1');
    const l1 = await lines('o-1');
    expect(l1.map((l) => Number(l.unit_cogs_cents_snapshot ?? -1))).toEqual([800, -1]); // t-shirt costed; poster has no cost => null, not zero
  });

  it('tags POS orders and snapshots their cost', async () => {
    expect((await order('o-2')).channel).toBe('shopify_pos');
    expect(Number((await lines('o-2'))[0]!.unit_cogs_cents_snapshot)).toBe(300);
  });

  it('records refunds: refund_cents, net_cents and refunded quantity', async () => {
    const r = await order('o-3');
    expect([Number(r.refund_cents), Number(r.net_cents)]).toEqual([2500, 0]);
    expect((await lines('o-3'))[0]!.refunded_quantity).toBe(1);
  });

  it('keeps cancelled and test orders, and leaves unmapped variants with a null sku', async () => {
    const c = await order('o-4');
    expect(c.status).toBe('cancelled');
    expect(c.cancelled_at).not.toBeNull();
    expect((await order('o-5')).is_test).toBe(true);
    const l = (await lines('o-5'))[0]!;
    expect(l.sku_id).toBeNull();
    expect(l.unit_cogs_cents_snapshot).toBeNull();
  });

  it('is idempotent', async () => {
    const before = [await count('orders'), await count('order_lines'), await count('refunds'), await count('refund_lines')];
    await run([o1, o2, o3, o4, o5]);
    expect([await count('orders'), await count('order_lines'), await count('refunds'), await count('refund_lines')]).toEqual(before);
  });

  it('ignores an older version of an order (a late webhook cannot undo a refund)', async () => {
    const stale: NormalizedOrder = { ...o3, refunds: [], updatedAt: new Date('2026-09-07T10:00:00Z') };
    expect(await run([stale])).toEqual({ processed: 0, skipped: 1 });
    expect(Number((await order('o-3')).refund_cents)).toBe(2500);
    expect((await lines('o-3'))[0]!.refunded_quantity).toBe(1);
  });

  it('applies a newer version: a refund added later updates totals and quantities', async () => {
    const newer: NormalizedOrder = {
      ...o1, updatedAt: new Date('2026-09-12T10:00:00Z'),
      refunds: [{ externalId: 'r-9', refundedAt: new Date('2026-09-12T10:00:00Z'), amountCents: 2500, shippingRefundCents: 0, restock: false, lines: [{ externalLineId: 'l-1', quantity: 1, amountCents: 2500 }] }],
    };
    await run([newer]);
    await run([newer]); // replay
    const a = await order('o-1');
    expect([Number(a.refund_cents), Number(a.net_cents)]).toEqual([2500, 4900]);
    expect((await lines('o-1'))[0]!.refunded_quantity).toBe(1);
    expect(await count('refunds')).toBe(2);
  });

  it('never changes a snapshot once set, even if costs change later', async () => {
    const sku = (await lines('o-1'))[0]!.sku_id as string;
    await seedCost(env.owner, ORG_A, sku, 1000, { from: '2026-02-01' }); // an extra, overlapping component
    await run([{ ...o1, updatedAt: new Date('2026-09-13T10:00:00Z') }]);
    expect(Number((await lines('o-1'))[0]!.unit_cogs_cents_snapshot)).toBe(800);
  });

  it('uses the org-timezone order date for snapshots (and null before the cost existed)', async () => {
    // 2026-01-01T02:00Z is still 2025-12-31 in New York, before the mug cost took effect on 2026-01-01.
    const early: NormalizedOrder = { ...o2, externalId: 'o-tz', placedAt: new Date('2026-01-01T02:00:00Z'), updatedAt: new Date('2026-01-02T00:00:00Z') };
    await run([early]);
    expect((await lines('o-tz'))[0]!.unit_cogs_cents_snapshot).toBeNull();
    const later: NormalizedOrder = { ...o2, externalId: 'o-tz2', placedAt: new Date('2026-01-01T06:00:00Z'), updatedAt: new Date('2026-01-02T00:00:00Z') };
    await run([later]); // 2026-01-01 01:00 in New York: cost in effect
    expect(Number((await lines('o-tz2'))[0]!.unit_cogs_cents_snapshot)).toBe(300);
  });

  it('fills the sku of a previously unmapped line once the variant is known', async () => {
    await env.db.withTenant(ORG_A, (tx) =>
      upsertProducts(tx, sinkContext(), [{ externalId: 'p-late', title: 'Late', brand: null, category: null, status: 'active', updatedAt: new Date('2026-09-01T00:00:00Z'),
        variants: [{ externalId: 'v-999', skuCode: 'LATE-1', barcode: null, priceCents: 900, compareAtPriceCents: null, currency: 'USD', unitCostCents: 400, updatedAt: new Date('2026-09-01T00:00:00Z') }] }]));
    await run([{ ...o5, updatedAt: new Date('2026-09-14T00:00:00Z') }]);
    const l = (await lines('o-5'))[0]!;
    expect(l.sku_id).not.toBeNull();
    expect(Number(l.unit_cogs_cents_snapshot)).toBe(400);
  });

  it('keeps net = gross - discount - refund for every order', async () => {
    const { rows } = await env.owner.query(`select count(*)::int c from orders where org_id = $1 and net_cents <> gross_cents - discount_cents - refund_cents`, [ORG_A]);
    expect(rows[0].c).toBe(0);
  });

  it('handles an empty page and cannot write another tenant\'s connection', async () => {
    expect(await run([])).toEqual({ processed: 0, skipped: 0 });
    await expect(run([o1], sinkContext({ orgId: ORG_B, connectionId: CONN_A }))).rejects.toBeTruthy();
  });
});
```

(`sinkContext` is imported from `./helpers`; add `ORG_B` use as shown.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm turbo run test --filter=@erq/sync -- sinks-orders`
Expected: FAIL (`../src/sinks/orders` does not exist).

- [ ] **Step 3: Implement**

`packages/sync/src/sinks/orders.ts`:

```ts
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NormalizedOrder } from '@erq/connectors';
import { orderLines, orders, refundLines, refunds, skuChannelListings, type Tx } from '@erq/db';
import { loadCostRows, snapshotUnitCogs, toOrgDate } from '../cogs';
import type { SinkContext, SinkResult } from './context';
import { dedupeLatest } from './util';

export async function upsertOrders(tx: Tx, ctx: SinkContext, items: NormalizedOrder[]): Promise<SinkResult> {
  const unique = dedupeLatest(items, (o) => o.externalId, (o) => o.updatedAt);
  if (unique.length === 0) return { processed: 0, skipped: 0 };

  const existing = await tx
    .select({ externalOrderId: orders.externalOrderId, externalUpdatedAt: orders.externalUpdatedAt })
    .from(orders)
    .where(and(eq(orders.storeConnectionId, ctx.connectionId), inArray(orders.externalOrderId, unique.map((o) => o.externalId))));
  const storedUpdatedAt = new Map(existing.map((e) => [e.externalOrderId, e.externalUpdatedAt]));

  const variantIds = [...new Set(unique.flatMap((o) => o.lines.flatMap((l) => (l.externalVariantId ? [l.externalVariantId] : []))))];
  const listings = variantIds.length
    ? await tx
        .select({ externalVariantId: skuChannelListings.externalVariantId, skuId: skuChannelListings.skuId })
        .from(skuChannelListings)
        .where(and(eq(skuChannelListings.storeConnectionId, ctx.connectionId), inArray(skuChannelListings.externalVariantId, variantIds)))
    : [];
  const skuByVariant = new Map(listings.map((l) => [l.externalVariantId, l.skuId]));
  const costRows = await loadCostRows(tx, [...new Set(skuByVariant.values())]);

  let processed = 0;
  let skipped = 0;
  for (const order of unique) {
    const stored = storedUpdatedAt.get(order.externalId);
    if (stored && stored > order.updatedAt) {
      skipped++;
      continue;
    }
    const refundCents = order.refunds.reduce((sum, r) => sum + r.amountCents, 0);
    const [row] = await tx
      .insert(orders)
      .values({
        orgId: ctx.orgId, storeConnectionId: ctx.connectionId, externalOrderId: order.externalId, channel: order.channel,
        status: order.status, placedAt: order.placedAt, cancelledAt: order.cancelledAt, currency: order.currency,
        grossCents: order.grossCents, discountCents: order.discountCents, shippingChargedCents: order.shippingChargedCents,
        taxCents: order.taxCents, refundCents, netCents: order.grossCents - order.discountCents - refundCents,
        customerExternalId: order.customerExternalId, utmSource: order.utmSource, utmMedium: order.utmMedium,
        utmCampaign: order.utmCampaign, landingSite: order.landingSite, isTest: order.isTest, externalUpdatedAt: order.updatedAt,
      })
      .onConflictDoUpdate({
        target: [orders.orgId, orders.storeConnectionId, orders.externalOrderId],
        set: {
          channel: sql`excluded.channel`, status: sql`excluded.status`, placedAt: sql`excluded.placed_at`,
          cancelledAt: sql`excluded.cancelled_at`, currency: sql`excluded.currency`, grossCents: sql`excluded.gross_cents`,
          discountCents: sql`excluded.discount_cents`, shippingChargedCents: sql`excluded.shipping_charged_cents`,
          taxCents: sql`excluded.tax_cents`, refundCents: sql`excluded.refund_cents`, netCents: sql`excluded.net_cents`,
          customerExternalId: sql`excluded.customer_external_id`, utmSource: sql`excluded.utm_source`,
          utmMedium: sql`excluded.utm_medium`, utmCampaign: sql`excluded.utm_campaign`, landingSite: sql`excluded.landing_site`,
          isTest: sql`excluded.is_test`, externalUpdatedAt: sql`excluded.external_updated_at`,
        },
        setWhere: sql`excluded.external_updated_at >= ${orders.externalUpdatedAt}`,
      })
      .returning({ id: orders.id });
    if (!row) {
      skipped++;
      continue;
    }

    const placedOn = toOrgDate(order.placedAt, ctx.timezone);
    const lineValues = dedupeLatest(order.lines, (l) => l.externalLineId).map((l) => {
      const skuId = l.externalVariantId ? (skuByVariant.get(l.externalVariantId) ?? null) : null;
      return {
        orgId: ctx.orgId, orderId: row.id, skuId, externalLineId: l.externalLineId, externalVariantId: l.externalVariantId,
        title: l.title, quantity: l.quantity, unitPriceCents: l.unitPriceCents, discountCents: l.discountCents,
        unitCogsCentsSnapshot: skuId ? snapshotUnitCogs(costRows.get(skuId), placedOn, order.currency) : null,
      };
    });
    if (lineValues.length > 0) {
      await tx
        .insert(orderLines)
        .values(lineValues)
        .onConflictDoUpdate({
          target: [orderLines.orgId, orderLines.orderId, orderLines.externalLineId],
          set: {
            externalVariantId: sql`excluded.external_variant_id`, title: sql`excluded.title`, quantity: sql`excluded.quantity`,
            unitPriceCents: sql`excluded.unit_price_cents`, discountCents: sql`excluded.discount_cents`,
            skuId: sql`coalesce(excluded.sku_id, ${orderLines.skuId})`,
            // A snapshot is historical: once set it never changes (repriceOrderLines is the explicit way to recompute).
            unitCogsCentsSnapshot: sql`coalesce(${orderLines.unitCogsCentsSnapshot}, excluded.unit_cogs_cents_snapshot)`,
          },
        });
    }

    if (order.refunds.length > 0) {
      const lineRows = await tx.select({ id: orderLines.id, externalLineId: orderLines.externalLineId }).from(orderLines).where(eq(orderLines.orderId, row.id));
      const lineIdByExternal = new Map(lineRows.map((l) => [l.externalLineId, l.id]));
      for (const refund of dedupeLatest(order.refunds, (r) => r.externalId)) {
        const [saved] = await tx
          .insert(refunds)
          .values({
            orgId: ctx.orgId, orderId: row.id, externalRefundId: refund.externalId, refundedAt: refund.refundedAt,
            amountCents: refund.amountCents, shippingRefundCents: refund.shippingRefundCents, restock: refund.restock,
          })
          .onConflictDoUpdate({
            target: [refunds.orgId, refunds.orderId, refunds.externalRefundId],
            set: {
              refundedAt: sql`excluded.refunded_at`, amountCents: sql`excluded.amount_cents`,
              shippingRefundCents: sql`excluded.shipping_refund_cents`, restock: sql`excluded.restock`,
            },
          })
          .returning({ id: refunds.id });
        const rl = refund.lines.flatMap((l) => {
          const orderLineId = lineIdByExternal.get(l.externalLineId);
          return orderLineId ? [{ orgId: ctx.orgId, refundId: saved!.id, orderLineId, quantity: l.quantity, amountCents: l.amountCents }] : [];
        });
        if (rl.length > 0) {
          await tx
            .insert(refundLines)
            .values(rl)
            .onConflictDoUpdate({
              target: [refundLines.orgId, refundLines.refundId, refundLines.orderLineId],
              set: { quantity: sql`excluded.quantity`, amountCents: sql`excluded.amount_cents` },
            });
        }
      }
      await tx
        .update(orderLines)
        .set({ refundedQuantity: sql`coalesce((select sum(${refundLines.quantity}) from ${refundLines} where ${refundLines.orderLineId} = ${orderLines.id}), 0)::int` })
        .where(eq(orderLines.orderId, row.id));
    }
    processed++;
  }
  return { processed, skipped };
}
```

Append `export * from './sinks/orders';` to `packages/sync/src/index.ts`.

- [ ] **Step 4: Run to verify pass, then commit**

Run: `pnpm turbo run test typecheck build --filter=@erq/sync` then `pnpm lint`
Expected: PASS. Notes for the implementer: if the Drizzle `update ... set refundedQuantity: sql` subquery renders the table reference differently, keep the SQL semantics (`refunded_quantity = coalesce((select sum(quantity) from refund_lines where order_line_id = order_lines.id), 0)::int`); if `refundedQuantity` would exceed `quantity` because a connector sends inconsistent data, the check constraint raises, which the engine reports as a permanent error.

```bash
git add -A && git commit -m "feat(sync): add idempotent order sink with refunds and cost snapshots"
```

### Task 11: Sync engine: `enqueueSync`, `processSyncPage`, `failSyncRun`, `resumeStalledRuns`

**Files:**
- Create: `packages/sync/src/engine/{deps.ts,start.ts,process.ts,fail.ts,resume.ts}`; modify `packages/sync/src/index.ts`
- Create: `packages/sync/test/engine-helpers.ts`
- Test: `packages/sync/test/engine.test.ts`

**Interfaces:**
- Consumes: ports, sinks, `toOrgDate`, `ConnectorRegistry`, typed errors, `decryptConnectionCredentials`, `TenantDb` (with `.pool`), `KeyProvider`.
- Produces: `SyncDeps { db; connectors; limiter; queue; keyProvider; now?; policies? }`; `enqueueSync(deps, { orgId, connectionId, resources: SyncResource[] | 'all', mode, since? }): Promise<{ resource; syncRunId; started }>`; `startRun(tx, args)`; `processSyncPage(deps, job): Promise<PageResult>`; `failSyncRun(deps, job, message): Promise<void>`; `resumeStalledRuns(deps, olderThan: Date): Promise<number>`.

- [ ] **Step 1: Write the test helpers and the failing tests**

`packages/sync/test/engine-helpers.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { ConnectorRegistry } from '@erq/connectors';
import { FakeConnector, sampleData, type FakeData } from '@erq/connectors/testing';
import { EnvKeyProvider } from '@erq/shared';
import type { SyncDeps } from '../src/engine/deps';
import { processSyncPage } from '../src/engine/process';
import { InMemoryJobQueue, MemoryRateLimiter } from '../src/memory';
import type { PageResult } from '../src/ports';
import type { TestEnv } from './helpers';

export interface Harness {
  deps: SyncDeps;
  queue: InMemoryJobQueue;
  connector: FakeConnector;
  keyProvider: EnvKeyProvider;
  clock: { now(): Date; advance(ms: number): void };
}

export function makeHarness(env: TestEnv, opts: { data?: FakeData; pageSize?: number; deps?: Partial<SyncDeps> } = {}): Harness {
  const queue = new InMemoryJobQueue();
  const connector = new FakeConnector(opts.data ?? sampleData(), opts.pageSize ?? 2);
  const keyProvider = new EnvKeyProvider('k1', { k1: randomBytes(32).toString('base64') });
  let nowMs = Date.parse('2026-10-06T12:00:00Z');
  const clock = { now: () => new Date(nowMs), advance: (ms: number) => { nowMs += ms; } };
  const deps: SyncDeps = {
    db: env.db, connectors: new ConnectorRegistry().register('shopify', connector), limiter: new MemoryRateLimiter(() => nowMs),
    queue, keyProvider, now: clock.now, ...opts.deps,
  };
  return { deps, queue, connector, keyProvider, clock };
}

/** Plays the part of the worker: processes queued jobs FIFO until the queue is empty. */
export async function drain(h: Harness, maxJobs = 500): Promise<PageResult[]> {
  const results: PageResult[] = [];
  for (let i = 0; i < maxJobs; i++) {
    const item = h.queue.take();
    if (!item) return results;
    if (item.delayMs) h.clock.advance(item.delayMs);
    const result = await processSyncPage(h.deps, item.job);
    results.push(result);
    if (result.kind === 'next') await h.queue.enqueue(result.job);
    else if (result.kind === 'delayed') await h.queue.enqueue(item.job, { delayMs: result.delayMs });
    else if (result.kind === 'done' && result.followUp) await h.queue.enqueue(result.followUp);
  }
  throw new Error('drain exceeded maxJobs');
}

export async function resetSync(env: TestEnv): Promise<void> {
  await env.owner.query('delete from sync_cursors');
  await env.owner.query('delete from sync_runs');
}
```

`packages/sync/test/engine.test.ts`:

```ts
import { AuthError, PermanentError, RateLimitedError, TransientError, encryptConnectionCredentials } from '@erq/connectors';
import { sampleData } from '@erq/connectors/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enqueueSync } from '../src/engine/start';
import { failSyncRun } from '../src/engine/fail';
import { processSyncPage } from '../src/engine/process';
import type { RateLimiter, SyncPageJob } from '../src/ports';
import { drain, makeHarness, resetSync } from './engine-helpers';
import { CONN_A, ORG_A, ORG_B, startEnv, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => { env = await startEnv(); });
afterAll(async () => { await env?.stop(); });
beforeEach(async () => { await resetSync(env); });

const since = new Date('2026-01-01T00:00:00Z');
const cursorRow = async (resource: string) =>
  (await env.owner.query(`select * from sync_cursors where store_connection_id = $1 and resource = $2`, [CONN_A, resource])).rows[0];
const runRow = async (id: string) => (await env.owner.query(`select * from sync_runs where id = $1`, [id])).rows[0];
async function start(h: ReturnType<typeof makeHarness>, resource: 'locations' | 'products' | 'inventory' | 'orders', mode: 'backfill' | 'incremental' = 'backfill'): Promise<SyncPageJob> {
  await enqueueSync(h.deps, { orgId: ORG_A, connectionId: CONN_A, resources: [resource], mode, since: mode === 'backfill' ? since : undefined });
  return h.queue.take()!.job;
}

describe('enqueueSync', () => {
  it('creates a run, a running cursor row and the first page job', async () => {
    const h = makeHarness(env);
    const r = await enqueueSync(h.deps, { orgId: ORG_A, connectionId: CONN_A, resources: ['orders'], mode: 'backfill', since });
    expect(r).toMatchObject({ resource: 'orders', started: true });
    expect(h.queue.size).toBe(1);
    const c = await cursorRow('orders');
    expect([c.status, c.current_sync_run_id, c.cursor]).toEqual(['running', r.syncRunId, null]);
    expect(c.backfill_since.toISOString()).toBe(since.toISOString());
    expect(await runRow(r.syncRunId)).toMatchObject({ type: 'backfill', status: 'running', connection_kind: 'store' });
  });
  it('allows one active run per connection and resource', async () => {
    const h = makeHarness(env);
    const a = await enqueueSync(h.deps, { orgId: ORG_A, connectionId: CONN_A, resources: ['orders'], mode: 'backfill', since });
    const b = await enqueueSync(h.deps, { orgId: ORG_A, connectionId: CONN_A, resources: ['orders'], mode: 'backfill', since });
    expect(b).toEqual({ resource: 'orders', syncRunId: a.syncRunId, started: false });
    expect(h.queue.size).toBe(1);
  });
  it('runs "all" in dependency order, chaining the rest', async () => {
    const h = makeHarness(env);
    const r = await enqueueSync(h.deps, { orgId: ORG_A, connectionId: CONN_A, resources: 'all', mode: 'backfill', since });
    expect(r.resource).toBe('locations');
    expect(h.queue.take()!.job.then).toEqual({ resources: ['products', 'inventory', 'orders'], mode: 'backfill', since: since.toISOString() });
    expect(await cursorRow('products')).toBeUndefined(); // later resources start when their predecessor finishes
  });
  it('sorts explicit resources into dependency order', async () => {
    const h = makeHarness(env);
    const r = await enqueueSync(h.deps, { orgId: ORG_A, connectionId: CONN_A, resources: ['orders', 'products'], mode: 'backfill', since });
    expect(r.resource).toBe('products');
  });
  it('requires since for backfill, and clears it for incremental runs', async () => {
    const h = makeHarness(env);
    await expect(enqueueSync(h.deps, { orgId: ORG_A, connectionId: CONN_A, resources: ['orders'], mode: 'backfill' })).rejects.toThrow(RangeError);
    await enqueueSync(h.deps, { orgId: ORG_A, connectionId: CONN_A, resources: ['orders'], mode: 'incremental' });
    expect((await cursorRow('orders')).backfill_since).toBeNull();
  });
  it('rejects a missing connection and another tenant\'s connection', async () => {
    const h = makeHarness(env);
    await expect(enqueueSync(h.deps, { orgId: ORG_B, connectionId: CONN_A, resources: ['orders'], mode: 'incremental' })).rejects.toBeInstanceOf(PermanentError);
    await expect(enqueueSync(h.deps, { orgId: ORG_A, connectionId: '00000000-0000-4000-8000-000000000000', resources: ['orders'], mode: 'incremental' })).rejects.toBeInstanceOf(PermanentError);
    expect(h.queue.size).toBe(0);
  });
});

describe('processSyncPage', () => {
  it('writes a page and the cursor in one step, then asks for the next page', async () => {
    const h = makeHarness(env);
    const job = await start(h, 'products');
    const result = await processSyncPage(h.deps, job);
    expect(result).toEqual({ kind: 'next', job });
    const c = await cursorRow('products');
    expect([c.cursor, Number(c.records_processed), c.status]).toEqual(['2', 2, 'running']);
    expect(Number((await env.owner.query(`select count(*) c from sku_channel_listings where org_id = $1`, [ORG_A])).rows[0].c)).toBeGreaterThanOrEqual(3);
  });
  it('completes on the last page: cursor complete, run succeeded, watermark = run start', async () => {
    const h = makeHarness(env);
    const job = await start(h, 'locations');
    expect(await processSyncPage(h.deps, job)).toEqual({ kind: 'done' });
    const c = await cursorRow('locations');
    expect([c.status, c.cursor, c.current_sync_run_id, Number(c.records_processed)]).toEqual(['complete', null, null, 2]);
    expect(c.updated_since.toISOString()).toBe('2026-10-06T12:00:00.000Z');
    expect(c.last_synced_at.toISOString()).toBe('2026-10-06T12:00:00.000Z');
    expect(await runRow(job.syncRunId)).toMatchObject({ status: 'succeeded', records_processed: 2 });
  });
  it('ignores stale jobs (finished run or wrong run id)', async () => {
    const h = makeHarness(env);
    const job = await start(h, 'locations');
    await processSyncPage(h.deps, job);
    const before = h.connector.calls.length;
    expect(await processSyncPage(h.deps, job)).toEqual({ kind: 'done' }); // run already finished
    expect(await processSyncPage(h.deps, { ...job, syncRunId: '00000000-0000-4000-8000-000000000001' })).toEqual({ kind: 'done' });
    expect(h.connector.calls.length).toBe(before);
  });
  it('another tenant cannot process or touch this connection\'s job', async () => {
    const h = makeHarness(env);
    const job = await start(h, 'locations');
    expect(await processSyncPage(h.deps, { ...job, orgId: ORG_B })).toEqual({ kind: 'done' });
    expect(h.connector.calls.length).toBe(0);
    expect((await cursorRow('locations')).status).toBe('running');
  });
  it('delays without calling the connector when the rate limiter is empty', async () => {
    const limiter: RateLimiter = { take: async () => ({ allowed: false, retryAfterMs: 1500 }) };
    const h = makeHarness(env, { deps: { limiter } });
    const job = await start(h, 'locations');
    expect(await processSyncPage(h.deps, job)).toEqual({ kind: 'delayed', delayMs: 1500 });
    expect(h.connector.calls.length).toBe(0);
    expect((await cursorRow('locations')).status).toBe('running');
  });
  it('delays on a RateLimitedError from the platform and keeps the cursor', async () => {
    const h = makeHarness(env);
    const job = await start(h, 'products');
    h.connector.failNext(new RateLimitedError(2000));
    expect(await processSyncPage(h.deps, job)).toEqual({ kind: 'delayed', delayMs: 2000 });
    expect((await cursorRow('products')).cursor).toBeNull();
  });
  it('marks the connection errored on an AuthError and stops the run', async () => {
    const h = makeHarness(env);
    const job = await start(h, 'products');
    h.connector.failNext(new AuthError('token revoked'));
    const result = await processSyncPage(h.deps, job);
    expect(result).toMatchObject({ kind: 'failed' });
    const conn = (await env.owner.query(`select status, last_error from store_connections where id = $1`, [CONN_A])).rows[0];
    expect(conn).toEqual({ status: 'error', last_error: 'token revoked' });
    expect(await cursorRow('products')).toMatchObject({ status: 'failed', last_error: 'token revoked' });
    expect(await runRow(job.syncRunId)).toMatchObject({ status: 'failed', error: 'token revoked' });
    await env.owner.query(`update store_connections set status = 'active', last_error = null where id = $1`, [CONN_A]);
  });
  it('fails the run on a PermanentError without touching the connection', async () => {
    const h = makeHarness(env);
    const job = await start(h, 'products');
    h.connector.failNext(new PermanentError('bad request'));
    expect(await processSyncPage(h.deps, job)).toEqual({ kind: 'failed', reason: 'bad request' });
    expect((await env.owner.query(`select status from store_connections where id = $1`, [CONN_A])).rows[0].status).toBe('active');
    expect((await cursorRow('products')).status).toBe('failed');
  });
  it('rethrows a TransientError and leaves cursor and data untouched (the queue retries)', async () => {
    const h = makeHarness(env);
    const job = await start(h, 'products');
    h.connector.failNext(new TransientError('503'));
    await expect(processSyncPage(h.deps, job)).rejects.toBeInstanceOf(TransientError);
    expect((await cursorRow('products')).cursor).toBeNull();
    expect(await processSyncPage(h.deps, job)).toEqual({ kind: 'next', job }); // the retry succeeds
  });
  it('fails permanently when the data violates a database rule', async () => {
    const data = sampleData();
    data.orders[2]!.refunds[0]!.lines[0]!.quantity = 5; // refund 5 units of a 1-unit line
    const h = makeHarness(env, { data, pageSize: 50 });
    const prod = await start(h, 'products');
    await processSyncPage(h.deps, prod);
    const job = await start(h, 'orders');
    const result = await processSyncPage(h.deps, job);
    expect(result.kind).toBe('failed');
    expect((await cursorRow('orders')).status).toBe('failed');
    expect(Number((await env.owner.query(`select count(*) c from orders where org_id = $1`, [ORG_A])).rows[0].c)).toBe(0); // the page rolled back
  });
  it('decrypts stored credentials for the connector and never puts them in job data', async () => {
    const h = makeHarness(env);
    await env.owner.query(`update store_connections set encrypted_credentials = $1 where id = $2`, [
      encryptConnectionCredentials({ accessToken: 'shpat_x' }, h.keyProvider, CONN_A), CONN_A,
    ]);
    const job = await start(h, 'locations');
    expect(JSON.stringify(job)).not.toContain('shpat_x');
    await processSyncPage(h.deps, job);
    expect(h.connector.calls[0]!.credentials).toEqual({ accessToken: 'shpat_x' });
    await env.owner.query(`update store_connections set encrypted_credentials = null where id = $1`, [CONN_A]);
  });
  it('commits a page once even if two workers hold the same job (compare-and-set on the cursor)', async () => {
    const h = makeHarness(env);
    const job = await start(h, 'products');
    let waiting = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => { release = r; });
    const inner = h.connector.fetchPage.bind(h.connector);
    h.connector.fetchPage = (async (...args: Parameters<typeof inner>) => {
      if (++waiting === 2) release();
      await barrier; // both workers have read cursor = null before either commits
      return inner(...args);
    }) as typeof inner;
    const [a, b] = await Promise.all([processSyncPage(h.deps, job), processSyncPage(h.deps, job)]);
    expect([a.kind, b.kind].sort()).toEqual(['done', 'next']);
    const c = await cursorRow('products');
    expect([c.cursor, Number(c.records_processed)]).toEqual(['2', 2]);
  });
});

describe('failSyncRun', () => {
  it('marks the current run and cursor failed (used after the last queue attempt)', async () => {
    const h = makeHarness(env);
    const job = await start(h, 'orders');
    await failSyncRun(h.deps, job, 'gave up after 5 attempts');
    expect(await cursorRow('orders')).toMatchObject({ status: 'failed', last_error: 'gave up after 5 attempts' });
    expect(await runRow(job.syncRunId)).toMatchObject({ status: 'failed' });
  });
  it('does not touch a newer run', async () => {
    const h = makeHarness(env);
    const job = await start(h, 'orders');
    await failSyncRun(h.deps, { ...job, syncRunId: '00000000-0000-4000-8000-000000000002' }, 'old');
    expect((await cursorRow('orders')).status).toBe('running');
  });
});

describe('drain helper sanity', () => {
  it('runs a single resource to completion', async () => {
    const h = makeHarness(env);
    await enqueueSync(h.deps, { orgId: ORG_A, connectionId: CONN_A, resources: ['locations'], mode: 'backfill', since });
    const results = await drain(h);
    expect(results.map((r) => r.kind)).toEqual(['done']);
  });
});
```

(The "database rule" test seeds products first so order lines map; the refund line quantity 5 on a quantity-1 line violates `order_lines_refunded_within_quantity` after recomputation, raising a check violation that the engine classifies as permanent.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm turbo run test --filter=@erq/sync -- engine.test`
Expected: FAIL (engine modules do not exist).

- [ ] **Step 3: Implement**

`packages/sync/src/engine/deps.ts`:

```ts
import type { ConnectorRegistry } from '@erq/connectors';
import type { TenantDb } from '@erq/db';
import type { KeyProvider } from '@erq/shared';
import type { JobQueue, RateLimitPolicy, RateLimiter } from '../ports';

export interface SyncDeps {
  db: TenantDb;
  connectors: ConnectorRegistry;
  limiter: RateLimiter;
  queue: JobQueue;
  keyProvider: KeyProvider;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Per-platform rate-limit overrides. */
  policies?: Record<string, RateLimitPolicy>;
}

export const nowOf = (deps: SyncDeps): Date => (deps.now ?? (() => new Date()))();
```

`packages/sync/src/engine/start.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import { PermanentError, SYNC_RESOURCES, type SyncResource } from '@erq/connectors';
import { storeConnections, syncCursors, syncRuns, type Tx } from '@erq/db';
import type { SyncMode } from '../ports';
import { nowOf, type SyncDeps } from './deps';

export interface EnqueueSyncArgs {
  orgId: string;
  connectionId: string;
  resources: SyncResource[] | 'all';
  mode: SyncMode;
  /** Required for backfill: how far back to import. */
  since?: Date;
}

/**
 * Starts (or finds) the run for one resource. Locks the cursor row, so only one run per connection and resource is active.
 */
export async function startRun(
  tx: Tx,
  args: { orgId: string; connectionId: string; resource: SyncResource; mode: SyncMode; since: Date | null; now: Date },
): Promise<{ syncRunId: string; created: boolean }> {
  if (args.mode === 'backfill' && !args.since) throw new RangeError('a backfill needs a start date (since)');
  await tx
    .insert(syncCursors)
    .values({ orgId: args.orgId, storeConnectionId: args.connectionId, resource: args.resource })
    .onConflictDoNothing();
  const [cursor] = await tx
    .select()
    .from(syncCursors)
    .where(and(eq(syncCursors.storeConnectionId, args.connectionId), eq(syncCursors.resource, args.resource)))
    .for('update');
  if (!cursor) throw new PermanentError('sync cursor could not be created');
  if (cursor.status === 'running' && cursor.currentSyncRunId) return { syncRunId: cursor.currentSyncRunId, created: false };

  const [run] = await tx
    .insert(syncRuns)
    .values({ orgId: args.orgId, connectionKind: 'store', connectionId: args.connectionId, type: args.mode, status: 'running', startedAt: args.now })
    .returning({ id: syncRuns.id });
  await tx
    .update(syncCursors)
    .set({
      status: 'running', cursor: null, currentSyncRunId: run!.id, recordsProcessed: 0, lastError: null,
      backfillSince: args.mode === 'backfill' ? args.since : null,
    })
    .where(eq(syncCursors.id, cursor.id));
  return { syncRunId: run!.id, created: true };
}

/**
 * Starts a sync for a connection. With several resources, only the first starts now; the rest are chained in the job
 * and start when their predecessor finishes (locations, products, inventory, orders).
 */
export async function enqueueSync(deps: SyncDeps, args: EnqueueSyncArgs): Promise<{ resource: SyncResource; syncRunId: string; started: boolean }> {
  const requested = args.resources === 'all' ? [...SYNC_RESOURCES] : SYNC_RESOURCES.filter((r) => (args.resources as SyncResource[]).includes(r));
  const [first, ...rest] = requested;
  if (!first) throw new RangeError('no resources to sync');
  if (args.mode === 'backfill' && !args.since) throw new RangeError('a backfill needs a start date (since)');
  const now = nowOf(deps);

  const started = await deps.db.withTenant(args.orgId, async (tx) => {
    const [connection] = await tx.select({ id: storeConnections.id }).from(storeConnections).where(eq(storeConnections.id, args.connectionId));
    if (!connection) throw new PermanentError('store connection not found');
    return startRun(tx, { orgId: args.orgId, connectionId: args.connectionId, resource: first, mode: args.mode, since: args.since ?? null, now });
  });
  if (started.created) {
    await deps.queue.enqueue({
      orgId: args.orgId, connectionId: args.connectionId, resource: first, syncRunId: started.syncRunId,
      then: rest.length > 0 ? { resources: rest, mode: args.mode, since: args.since?.toISOString() ?? null } : undefined,
    });
  }
  return { resource: first, syncRunId: started.syncRunId, started: started.created };
}
```

`packages/sync/src/engine/fail.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import { storeConnections, syncCursors, syncRuns, type Tx } from '@erq/db';
import type { SyncPageJob } from '../ports';
import { nowOf, type SyncDeps } from './deps';

export const safeMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 500);

/** Marks the job's run and cursor failed (only if that run is still the current one). Optionally flags the connection. */
export async function failRun(tx: Tx, job: SyncPageJob, message: string, now: Date, opts: { connectionError?: boolean } = {}): Promise<void> {
  await tx
    .update(syncCursors)
    .set({ status: 'failed', lastError: message })
    .where(and(eq(syncCursors.storeConnectionId, job.connectionId), eq(syncCursors.resource, job.resource), eq(syncCursors.currentSyncRunId, job.syncRunId)));
  await tx.update(syncRuns).set({ status: 'failed', error: message, finishedAt: now }).where(and(eq(syncRuns.id, job.syncRunId), eq(syncRuns.status, 'running')));
  if (opts.connectionError) {
    await tx.update(storeConnections).set({ status: 'error', lastError: message }).where(eq(storeConnections.id, job.connectionId));
  }
}

/** Called by the worker after the last queue attempt. */
export async function failSyncRun(deps: SyncDeps, job: SyncPageJob, message: string): Promise<void> {
  await deps.db.withTenant(job.orgId, (tx) => failRun(tx, job, message.slice(0, 500), nowOf(deps)));
}
```

`packages/sync/src/engine/process.ts`:

```ts
import { and, eq, sql } from 'drizzle-orm';
import {
  AuthError, PermanentError, RateLimitedError, decryptConnectionCredentials,
  type NormalizedInventoryLevel, type NormalizedLocation, type NormalizedOrder, type NormalizedProduct, type Page, type SyncResource,
} from '@erq/connectors';
import { orgs, storeConnections, syncCursors, syncRuns, type Tx } from '@erq/db';
import { toOrgDate } from '../cogs';
import type { PageResult, SyncPageJob } from '../ports';
import { policyFor } from '../policies';
import type { SinkContext, SinkResult } from '../sinks/context';
import { upsertInventory } from '../sinks/inventory';
import { upsertLocations } from '../sinks/locations';
import { upsertOrders } from '../sinks/orders';
import { upsertProducts } from '../sinks/products';
import { nowOf, type SyncDeps } from './deps';
import { failRun, safeMessage } from './fail';
import { startRun } from './start';

function applyPage(tx: Tx, ctx: SinkContext, resource: SyncResource, items: unknown[]): Promise<SinkResult> {
  switch (resource) {
    case 'locations': return upsertLocations(tx, ctx, items as NormalizedLocation[]);
    case 'products': return upsertProducts(tx, ctx, items as NormalizedProduct[]);
    case 'inventory': return upsertInventory(tx, ctx, items as NormalizedInventoryLevel[]);
    case 'orders': return upsertOrders(tx, ctx, items as NormalizedOrder[]);
  }
}

/** Constraint (23xxx) and data (22xxx) errors cannot be fixed by retrying. */
function isDataError(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code;
  return typeof code === 'string' && (code.startsWith('23') || code.startsWith('22'));
}

export async function processSyncPage(deps: SyncDeps, job: SyncPageJob): Promise<PageResult> {
  const now = nowOf(deps);
  const loaded = await deps.db.withTenant(job.orgId, async (tx) => {
    const [connection] = await tx
      .select({ id: storeConnections.id, platform: storeConnections.platform, externalAccountId: storeConnections.externalAccountId, encryptedCredentials: storeConnections.encryptedCredentials })
      .from(storeConnections)
      .where(eq(storeConnections.id, job.connectionId));
    if (!connection) return null;
    const [cursor] = await tx
      .select()
      .from(syncCursors)
      .where(and(eq(syncCursors.storeConnectionId, job.connectionId), eq(syncCursors.resource, job.resource)));
    const [org] = await tx.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, job.orgId));
    const [run] = await tx.select({ startedAt: syncRuns.startedAt }).from(syncRuns).where(eq(syncRuns.id, job.syncRunId));
    return { connection, cursor, timezone: org?.timezone ?? 'UTC', runStartedAt: run?.startedAt ?? now };
  });
  if (!loaded || !loaded.cursor || loaded.cursor.status !== 'running' || loaded.cursor.currentSyncRunId !== job.syncRunId) {
    return { kind: 'done' }; // stale job: nothing to do
  }
  const { connection, cursor, timezone, runStartedAt } = loaded;

  const policy = policyFor(connection.platform, deps.policies);
  const decision = await deps.limiter.take(`${connection.platform}:${connection.id}`, policy.costPerPage, policy);
  if (!decision.allowed) return { kind: 'delayed', delayMs: decision.retryAfterMs };

  let page: Page<unknown>;
  try {
    const connector = deps.connectors.get(connection.platform);
    const credentials = decryptConnectionCredentials(connection.encryptedCredentials, deps.keyProvider, connection.id);
    page = await connector.fetchPage(
      { connectionId: connection.id, externalAccountId: connection.externalAccountId, credentials },
      job.resource, cursor.cursor,
      { since: cursor.backfillSince ?? undefined, updatedSince: cursor.updatedSince ?? undefined },
    );
  } catch (error) {
    if (error instanceof RateLimitedError) return { kind: 'delayed', delayMs: error.retryAfterMs };
    if (error instanceof AuthError || error instanceof PermanentError) {
      const message = safeMessage(error);
      await deps.db.withTenant(job.orgId, (tx) => failRun(tx, job, message, now, { connectionError: error instanceof AuthError }));
      return { kind: 'failed', reason: message };
    }
    throw error; // transient or unknown: the queue retries with backoff
  }

  const sinkCtx: SinkContext = {
    orgId: job.orgId, connectionId: job.connectionId, syncRunId: job.syncRunId, timezone, now,
    costEffectiveFrom: toOrgDate(cursor.backfillSince ?? now, timezone),
  };

  try {
    return await deps.db.withTenant(job.orgId, async (tx): Promise<PageResult> => {
      // Compare-and-set: if another worker already advanced this cursor, this page is stale.
      const [fresh] = await tx.select().from(syncCursors).where(eq(syncCursors.id, cursor.id)).for('update');
      if (!fresh || fresh.status !== 'running' || fresh.currentSyncRunId !== job.syncRunId || fresh.cursor !== cursor.cursor) {
        return { kind: 'done' };
      }
      const result = await applyPage(tx, sinkCtx, job.resource, page.items);
      const done = page.nextCursor === null;
      await tx
        .update(syncRuns)
        .set({ recordsProcessed: sql`${syncRuns.recordsProcessed} + ${result.processed}`, ...(done ? { status: 'succeeded' as const, finishedAt: now } : {}) })
        .where(eq(syncRuns.id, job.syncRunId));
      await tx
        .update(syncCursors)
        .set(
          done
            ? { cursor: null, status: 'complete' as const, lastSyncedAt: now, updatedSince: runStartedAt, currentSyncRunId: null, lastError: null, recordsProcessed: sql`${syncCursors.recordsProcessed} + ${result.processed}` }
            : { cursor: page.nextCursor, recordsProcessed: sql`${syncCursors.recordsProcessed} + ${result.processed}` },
        )
        .where(eq(syncCursors.id, cursor.id));
      if (!done) return { kind: 'next', job };

      let followUp: SyncPageJob | undefined;
      if (job.then && job.then.resources.length > 0) {
        const [next, ...rest] = job.then.resources;
        const started = await startRun(tx, {
          orgId: job.orgId, connectionId: job.connectionId, resource: next!, mode: job.then.mode,
          since: job.then.since ? new Date(job.then.since) : null, now,
        });
        if (started.created) {
          followUp = {
            orgId: job.orgId, connectionId: job.connectionId, resource: next!, syncRunId: started.syncRunId,
            then: rest.length > 0 ? { ...job.then, resources: rest } : undefined,
          };
        }
      }
      return { kind: 'done', followUp };
    });
  } catch (error) {
    if (isDataError(error)) {
      const message = safeMessage((error as { cause?: unknown }).cause ?? error).slice(0, 300);
      await deps.db.withTenant(job.orgId, (tx) => failRun(tx, job, `data rejected by database: ${message}`, now));
      return { kind: 'failed', reason: message };
    }
    throw error;
  }
}
```

`packages/sync/src/engine/resume.ts`:

```ts
import type { SyncResource } from '@erq/connectors';
import type { SyncDeps } from './deps';

/**
 * Re-enqueues runs whose cursor has not moved since `olderThan` (for example after a crash between commit and enqueue).
 * Resumed runs continue from the stored cursor. Note: the `then` chain of an `all` sync is not persisted, so after a
 * resume only the interrupted resource completes; trigger the sync again to run the remaining resources.
 */
export async function resumeStalledRuns(deps: SyncDeps, olderThan: Date): Promise<number> {
  const { rows } = await deps.db.pool.query<{ o_org_id: string; o_store_connection_id: string; o_resource: SyncResource; o_sync_run_id: string }>(
    'select * from app_list_stalled_sync_cursors($1)',
    [olderThan],
  );
  for (const r of rows) {
    await deps.queue.enqueue({ orgId: r.o_org_id, connectionId: r.o_store_connection_id, resource: r.o_resource, syncRunId: r.o_sync_run_id });
  }
  return rows.length;
}
```

Append to `packages/sync/src/index.ts`:

```ts
export * from './engine/deps';
export * from './engine/start';
export * from './engine/process';
export * from './engine/fail';
export * from './engine/resume';
```

- [ ] **Step 4: Run to verify pass, then commit**

Run: `pnpm turbo run test typecheck build --filter=@erq/sync` then `pnpm lint`
Expected: PASS. If a Drizzle API detail differs (`.for('update')`, `onConflictDoNothing()` on a table with composite unique, the `set` object union typing), keep the exact SQL semantics: the cursor row is locked `FOR UPDATE`, the page and cursor commit in one transaction, and the compare-and-set check precedes the sink call.

```bash
git add -A && git commit -m "feat(sync): add resumable page-job engine with compare-and-set cursors and typed error handling"
```

---

### Task 12: End-to-end engine tests with the fake connector

**Files:**
- Test: `packages/sync/test/engine-e2e.test.ts` (no new source files; fix source defects the tests reveal)

**Interfaces:**
- Consumes: everything from Tasks 1 to 11.

- [ ] **Step 1: Write the tests**

`packages/sync/test/engine-e2e.test.ts`:

```ts
import { PermanentError, TransientError } from '@erq/connectors';
import { sampleData } from '@erq/connectors/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enqueueSync } from '../src/engine/start';
import { processSyncPage } from '../src/engine/process';
import { resumeStalledRuns } from '../src/engine/resume';
import { MemoryRateLimiter } from '../src/memory';
import { drain, makeHarness, resetSync } from './engine-helpers';
import { CONN_A, ORG_A, startEnv, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => { env = await startEnv(); });
afterAll(async () => { await env?.stop(); });
beforeEach(async () => {
  await resetSync(env);
  for (const t of ['refund_lines', 'refunds', 'order_lines', 'orders', 'inventory_movements', 'inventory_levels', 'sku_channel_listings', 'sku_cost_components', 'skus', 'products', 'locations']) {
    await env.owner.query(`delete from ${t} where org_id = $1`, [ORG_A]);
  }
});

const since = new Date('2026-01-01T00:00:00Z');
const counts = async () => {
  const out: Record<string, number> = {};
  for (const t of ['locations', 'products', 'skus', 'sku_channel_listings', 'sku_cost_components', 'inventory_levels', 'inventory_movements', 'orders', 'order_lines', 'refunds', 'refund_lines']) {
    out[t] = Number((await env.owner.query(`select count(*) c from ${t} where org_id = $1`, [ORG_A])).rows[0].c);
  }
  return out;
};
const full = { locations: 2, products: 3, skus: 4, sku_channel_listings: 4, sku_cost_components: 3, inventory_levels: 6, inventory_movements: 6, orders: 5, order_lines: 6, refunds: 1, refund_lines: 1 };
const backfillAll = (h: ReturnType<typeof makeHarness>) =>
  enqueueSync(h.deps, { orgId: ORG_A, connectionId: CONN_A, resources: 'all', mode: 'backfill', since });

describe('backfill of every resource', () => {
  it('lands all data in dependency order, costs the orders, and finishes every run', async () => {
    const h = makeHarness(env);
    await backfillAll(h);
    const results = await drain(h);
    expect(results.every((r) => r.kind === 'done' || r.kind === 'next')).toBe(true);
    expect(await counts()).toEqual(full);

    const runs = (await env.owner.query(`select status, records_processed from sync_runs where org_id = $1 order by started_at, created_at`, [ORG_A])).rows;
    expect(runs).toHaveLength(4);
    expect(runs.every((r) => r.status === 'succeeded')).toBe(true);
    const cursors = (await env.owner.query(`select resource, status from sync_cursors where org_id = $1 order by resource`, [ORG_A])).rows;
    expect(cursors.every((c) => c.status === 'complete')).toBe(true);

    // products ran before orders, so the t-shirt line has its imported cost snapshot, the poster line (no cost) has null
    const snaps = (await env.owner.query(
      `select ol.external_line_id, ol.unit_cogs_cents_snapshot s from order_lines ol join orders o on o.id = ol.order_id where o.org_id = $1 and o.external_order_id = 'o-1' order by 1`, [ORG_A])).rows;
    expect(snaps.map((r) => (r.s === null ? null : Number(r.s)))).toEqual([800, null]);
  });

  it('is repeatable: a second backfill changes nothing', async () => {
    const h = makeHarness(env);
    await backfillAll(h);
    await drain(h);
    await backfillAll(h);
    await drain(h);
    expect(await counts()).toEqual(full);
  });
});

describe('crash recovery', () => {
  it('resumes from the stored cursor after a lost job, with no loss or duplication', async () => {
    const h = makeHarness(env);
    await backfillAll(h);
    // Process locations fully and the first products page, then "crash": the queue loses the next job.
    let item = h.queue.take()!;
    let r = await processSyncPage(h.deps, item.job); // locations (one page)
    if (r.kind !== 'done' || !r.followUp) throw new Error('expected the locations run to chain into products');
    await h.queue.enqueue(r.followUp);
    item = h.queue.take()!;
    r = await processSyncPage(h.deps, item.job); // first products page
    expect(r.kind).toBe('next');
    while (h.queue.take()) { /* the crash: pending jobs are gone */ }

    // updated_at is stamped by the database clock, so use the real clock here (the fake clock only drives the engine)
    expect(await resumeStalledRuns(h.deps, new Date(Date.now() - 3_600_000))).toBe(0); // not stalled yet
    expect(await resumeStalledRuns(h.deps, new Date('2999-01-01T00:00:00Z'))).toBe(1);
    await drain(h);
    expect((await counts()).skus).toBe(4);
    expect((await env.owner.query(`select status from sync_cursors where resource = 'products' and org_id = $1`, [ORG_A])).rows[0].status).toBe('complete');

    // The chain is not persisted: re-running the sync completes the rest.
    await enqueueSync(h.deps, { orgId: ORG_A, connectionId: CONN_A, resources: 'all', mode: 'incremental' });
    await drain(h);
    expect(await counts()).toEqual(full);
  });
});

describe('incremental runs', () => {
  it('ask the platform only for changes since the previous run and apply them', async () => {
    const h = makeHarness(env, { pageSize: 50 });
    await backfillAll(h);
    await drain(h);
    h.clock.advance(3_600_000);
    const data = h.connector.data;
    const changed = { ...data.orders[4]!, updatedAt: new Date('2026-10-06T12:30:00Z'), status: 'closed' as const };
    h.connector.data = { ...data, orders: [...data.orders.slice(0, 4), changed] };
    h.connector.calls.length = 0;

    await enqueueSync(h.deps, { orgId: ORG_A, connectionId: CONN_A, resources: ['orders'], mode: 'incremental' });
    await drain(h);
    expect(h.connector.calls[0]!.options.updatedSince?.toISOString()).toBe('2026-10-06T12:00:00.000Z'); // previous run's start
    expect(h.connector.calls[0]!.options.since).toBeUndefined();
    const run = (await env.owner.query(`select type, records_processed from sync_runs where org_id = $1 order by created_at desc limit 1`, [ORG_A])).rows[0];
    expect([run.type, Number(run.records_processed)]).toEqual(['incremental', 1]);
    expect((await env.owner.query(`select status from orders where org_id = $1 and external_order_id = 'o-5'`, [ORG_A])).rows[0].status).toBe('closed');
    expect((await counts()).orders).toBe(5);
  });
});

describe('failures', () => {
  it('a permanent failure stops the chain and leaves later resources unstarted', async () => {
    const h = makeHarness(env);
    h.connector.failNext(new PermanentError('shop closed'), 1); // consumed by the very first fetch: the locations page
    await backfillAll(h);
    await drain(h);
    const cursors = (await env.owner.query(`select resource, status from sync_cursors where org_id = $1 order by resource`, [ORG_A])).rows;
    expect(cursors.find((c) => c.resource === 'locations')!.status).toBe('failed'); // the scripted failure hit the first fetch
    expect(cursors.find((c) => c.resource === 'orders')).toBeUndefined();
  });

  it('a transient failure is retried by the queue and the retry gives the same result', async () => {
    const h = makeHarness(env);
    await enqueueSync(h.deps, { orgId: ORG_A, connectionId: CONN_A, resources: ['locations'], mode: 'backfill', since });
    const job = h.queue.take()!.job;
    h.connector.failNext(new TransientError('503'), 2);
    await expect(processSyncPage(h.deps, job)).rejects.toBeInstanceOf(TransientError);
    await expect(processSyncPage(h.deps, job)).rejects.toBeInstanceOf(TransientError);
    expect((await processSyncPage(h.deps, job)).kind).toBe('done');
    expect((await counts()).locations).toBe(2);
  });

  it('rate limiting delays jobs, never loses them, and the run still completes', async () => {
    const h = makeHarness(env);
    h.deps.limiter = new MemoryRateLimiter(() => h.clock.now().getTime());
    h.deps.policies = { shopify: { capacity: 1, refillPerSecond: 1, costPerPage: 1 } };
    await backfillAll(h);
    const results = await drain(h);
    expect(results.some((r) => r.kind === 'delayed')).toBe(true);
    expect(await counts()).toEqual(full);
  });
});

describe('data safety', () => {
  it('never advances a cursor without its data: a failed page leaves cursor and tables unchanged', async () => {
    const data = sampleData();
    data.orders[2]!.refunds[0]!.lines[0]!.quantity = 9; // violates refunded <= quantity on the last order page
    const h = makeHarness(env, { data, pageSize: 50 });
    await enqueueSync(h.deps, { orgId: ORG_A, connectionId: CONN_A, resources: ['products', 'orders'], mode: 'backfill', since });
    await drain(h);
    const orders = (await env.owner.query(`select status, cursor, records_processed from sync_cursors where org_id = $1 and resource = 'orders'`, [ORG_A])).rows[0];
    expect(orders.status).toBe('failed');
    expect(Number(orders.records_processed)).toBe(0);
    expect((await counts()).orders).toBe(0);
    expect((await counts()).skus).toBe(4); // the successful products run is kept
  });
});
```

Notes for the implementer: (1) `FakeConnector.data` is a public mutable field, so tests can swap data between runs. (2) Verify the expected counts in `full` against `sampleData()` (3 costs: TSHIRT-S, TSHIRT-M, MUG-1; the poster has none) and report any difference with its cause instead of editing the expectation silently.

- [ ] **Step 2: Run to verify behaviour**

Run: `pnpm turbo run test --filter=@erq/sync -- engine-e2e`
Expected: PASS once Task 11 is correct. If a test exposes a defect in the engine or a sink, fix the source (not the test), keep the fix minimal, and report what it was.

- [ ] **Step 3: Whole-package check and commit**

Run: `pnpm turbo run test typecheck build --filter=@erq/sync` then `pnpm lint`
Expected: PASS.

```bash
git add -A && git commit -m "test(sync): add end-to-end engine tests for backfill, recovery, incremental runs and failures"
```

### Task 13: Worker glue (BullMQ queue, Redis rate limiter, job handler, sync worker)

**Files:**
- Create: `packages/sync/src/job-schema.ts`; modify `packages/sync/src/index.ts`, `packages/sync/package.json` (add `zod@^3`)
- Create: `apps/worker/src/sync/{bullmq-queue.ts,redis-rate-limiter.ts,handler.ts,worker.ts}`; modify `apps/worker/src/main.ts`, `apps/worker/package.json`, `.env.example`
- Test: `packages/sync/test/job-schema.test.ts`, `apps/worker/test/sync-handler.test.ts`, `apps/worker/test/sync-redis.test.ts`

**Interfaces:**
- Produces (`@erq/sync`): `parseSyncPageJob(data: unknown): SyncPageJob` (strict zod validation: uuids, known resource, optional `then`; unknown keys rejected so credentials can never ride along).
- Produces (`apps/worker`): `SYNC_QUEUE = 'sync'`, `BullMqJobQueue` (implements `JobQueue`), `RedisRateLimiter` (implements `RateLimiter`, atomic Lua token bucket using Redis `TIME`), `handleSyncJob(deps, job, impl?)`, `createSyncWorker(deps, connection, opts?)`, `scheduleResumeStalled(queue)`.

- [ ] **Step 1: Write the failing tests**

`packages/sync/test/job-schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseSyncPageJob } from '../src/job-schema';

const base = { orgId: '11111111-1111-4111-8111-111111111111', connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', resource: 'orders', syncRunId: '99999999-9999-4999-8999-999999999999' };

describe('parseSyncPageJob', () => {
  it('accepts a valid job, with and without a chain', () => {
    expect(parseSyncPageJob(base)).toEqual(base);
    const chained = { ...base, then: { resources: ['inventory', 'orders'], mode: 'backfill', since: '2026-01-01T00:00:00.000Z' } };
    expect(parseSyncPageJob(chained)).toEqual(chained);
  });
  it.each([
    [{ ...base, orgId: 'nope' }], [{ ...base, resource: 'customers' }], [{ ...base, syncRunId: undefined }], [null], ['x'],
    [{ ...base, then: { resources: ['bogus'], mode: 'backfill', since: null } }],
    [{ ...base, then: { resources: [], mode: 'weekly', since: null } }],
  ])('rejects %j', (data) => {
    expect(() => parseSyncPageJob(data)).toThrow();
  });
  it('rejects unknown keys so credentials can never travel in job data', () => {
    expect(() => parseSyncPageJob({ ...base, accessToken: 'shpat_x' })).toThrow();
  });
});
```

`apps/worker/test/sync-handler.test.ts`:

```ts
import { UnrecoverableError } from 'bullmq';
import { InMemoryJobQueue, type PageResult, type SyncDeps, type SyncPageJob } from '@erq/sync';
import { describe, expect, it, vi } from 'vitest';
import { handleSyncJob } from '../src/sync/handler';

const job: SyncPageJob = { orgId: '11111111-1111-4111-8111-111111111111', connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', resource: 'orders', syncRunId: '99999999-9999-4999-8999-999999999999' };
const setup = (result: PageResult) => {
  const queue = new InMemoryJobQueue();
  const deps = { queue, now: () => new Date('2026-10-06T12:00:00Z') } as unknown as SyncDeps;
  const impl = { processSyncPage: vi.fn(async () => result), resumeStalledRuns: vi.fn(async () => 0) };
  return { queue, deps, impl };
};

describe('handleSyncJob', () => {
  it('enqueues the next page job', async () => {
    const { queue, deps, impl } = setup({ kind: 'next', job });
    await handleSyncJob(deps, { name: 'page', data: job }, impl);
    expect(queue.take()).toEqual({ job, delayMs: 0 });
  });
  it('re-enqueues a delayed job with its delay', async () => {
    const { queue, deps, impl } = setup({ kind: 'delayed', delayMs: 2500 });
    await handleSyncJob(deps, { name: 'page', data: job }, impl);
    expect(queue.take()).toEqual({ job, delayMs: 2500 });
  });
  it('enqueues the follow-up when a resource finishes, and nothing otherwise', async () => {
    const followUp = { ...job, resource: 'products' as const };
    const a = setup({ kind: 'done', followUp });
    await handleSyncJob(a.deps, { name: 'page', data: job }, a.impl);
    expect(a.queue.take()).toEqual({ job: followUp, delayMs: 0 });
    const b = setup({ kind: 'done' });
    await handleSyncJob(b.deps, { name: 'page', data: job }, b.impl);
    const c = setup({ kind: 'failed', reason: 'x' });
    await handleSyncJob(c.deps, { name: 'page', data: job }, c.impl);
    expect(b.queue.size + c.queue.size).toBe(0);
  });
  it('rejects malformed job data permanently, without processing it', async () => {
    const { deps, impl } = setup({ kind: 'done' });
    await expect(handleSyncJob(deps, { name: 'page', data: { ...job, orgId: 'nope' } }, impl)).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(handleSyncJob(deps, { name: 'page', data: { ...job, accessToken: 'shpat_x' } }, impl)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(impl.processSyncPage).not.toHaveBeenCalled();
  });
  it('lets processing errors propagate so the queue retries', async () => {
    const { deps, impl } = setup({ kind: 'done' });
    impl.processSyncPage.mockRejectedValueOnce(new Error('503'));
    await expect(handleSyncJob(deps, { name: 'page', data: job }, impl)).rejects.toThrow('503');
  });
  it('resumes stalled runs older than 10 minutes on the resume-stalled job', async () => {
    const { deps, impl } = setup({ kind: 'done' });
    await handleSyncJob(deps, { name: 'resume-stalled', data: {} }, impl);
    expect(impl.resumeStalledRuns).toHaveBeenCalledWith(deps, new Date('2026-10-06T11:50:00Z'));
  });
});
```

`apps/worker/test/sync-redis.test.ts` (runs only where Docker exists, like the Phase 0 worker test; skipped here):

```ts
import { dockerAvailable } from '@erq/db/testing';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BullMqJobQueue, SYNC_QUEUE } from '../src/sync/bullmq-queue';
import { RedisRateLimiter } from '../src/sync/redis-rate-limiter';

let hasDocker = false;
let container: StartedTestContainer | undefined;
let redis: IORedis | undefined;
const policy = { capacity: 2, refillPerSecond: 1, costPerPage: 1 };

beforeAll(async () => {
  hasDocker = await dockerAvailable();
  if (!hasDocker) return;
  container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  redis = new IORedis({ host: container.getHost(), port: container.getMappedPort(6379), maxRetriesPerRequest: null });
});
afterAll(async () => {
  await redis?.quit();
  await container?.stop();
});

describe('RedisRateLimiter', () => {
  it('allows up to capacity, reports a retry delay, then refills', async (ctx) => {
    ctx.skip(!hasDocker);
    const limiter = new RedisRateLimiter(redis!);
    const key = `test:${Date.now()}`;
    expect((await limiter.take(key, 1, policy)).allowed).toBe(true);
    expect((await limiter.take(key, 1, policy)).allowed).toBe(true);
    const denied = await limiter.take(key, 1, policy);
    expect(denied.allowed).toBe(false);
    expect(denied.allowed === false && denied.retryAfterMs).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 1200));
    expect((await limiter.take(key, 1, policy)).allowed).toBe(true);
  });
  it('rejects a cost above capacity', async (ctx) => {
    ctx.skip(!hasDocker);
    const limiter = new RedisRateLimiter(redis!);
    await expect(limiter.take('k', 3, policy)).rejects.toThrow(RangeError);
  });
});

describe('BullMqJobQueue', () => {
  it('adds a page job with retry options and an optional delay', async (ctx) => {
    ctx.skip(!hasDocker);
    const queue = new Queue(SYNC_QUEUE, { connection: redis! });
    try {
      await new BullMqJobQueue(queue).enqueue({ orgId: 'o', connectionId: 'c', resource: 'orders', syncRunId: 'r' }, { delayMs: 5000 });
      const [job] = await queue.getDelayed();
      expect(job!.name).toBe('page');
      expect(job!.opts.attempts).toBe(5);
      expect(job!.opts.delay).toBe(5000);
      expect(job!.data).toEqual({ orgId: 'o', connectionId: 'c', resource: 'orders', syncRunId: 'r' });
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm turbo run test --filter=@erq/sync -- job-schema` and `pnpm turbo run test --filter=@erq/worker -- sync-handler`
Expected: FAIL (modules do not exist).

- [ ] **Step 3: Implement**

In `packages/sync`: `pnpm --filter @erq/sync add zod@^3`. `packages/sync/src/job-schema.ts`:

```ts
import { z } from 'zod';
import type { SyncPageJob } from './ports';

const resource = z.enum(['products', 'locations', 'inventory', 'orders']);
const schema = z
  .object({
    orgId: z.string().uuid(),
    connectionId: z.string().uuid(),
    resource,
    syncRunId: z.string().uuid(),
    then: z
      .object({ resources: z.array(resource), mode: z.enum(['backfill', 'incremental']), since: z.string().datetime().nullable() })
      .strict()
      .optional(),
  })
  .strict();

/** Validates queue payloads. Strict: unknown keys (for example credentials) are rejected. */
export function parseSyncPageJob(data: unknown): SyncPageJob {
  return schema.parse(data) as SyncPageJob;
}
```

Append `export * from './job-schema';` to `packages/sync/src/index.ts`.

In `apps/worker`: `pnpm --filter @erq/worker add @erq/sync@workspace:* @erq/connectors@workspace:*`. `apps/worker/src/sync/bullmq-queue.ts`:

```ts
import type { Queue } from 'bullmq';
import type { JobQueue, SyncPageJob } from '@erq/sync';

export const SYNC_QUEUE = 'sync';

/** Transient failures retry 5 times with exponential backoff; a rate-limit delay is a new delayed job, not a retry. */
export class BullMqJobQueue implements JobQueue {
  constructor(private readonly queue: Queue) {}

  async enqueue(job: SyncPageJob, opts: { delayMs?: number } = {}): Promise<void> {
    await this.queue.add('page', job, {
      delay: opts.delayMs,
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    });
  }
}
```

`apps/worker/src/sync/redis-rate-limiter.ts`:

```ts
import type { Redis } from 'ioredis';
import type { RateLimitDecision, RateLimitPolicy, RateLimiter } from '@erq/sync';

// Atomic token bucket. Uses the Redis clock so worker clock skew cannot matter.
const SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = capacity; ts = now end
tokens = math.min(capacity, tokens + ((now - ts) / 1000) * refill)
local allowed = 0
local retry = 0
if tokens >= cost then tokens = tokens - cost; allowed = 1 else retry = math.ceil(((cost - tokens) / refill) * 1000) end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], 3600000)
return { allowed, retry }
`;

type WithCommand = Redis & { erqTakeTokens(key: string, capacity: number, refill: number, cost: number): Promise<[number, number]> };

export class RedisRateLimiter implements RateLimiter {
  private readonly redis: WithCommand;

  constructor(redis: Redis) {
    if (!('erqTakeTokens' in redis)) redis.defineCommand('erqTakeTokens', { numberOfKeys: 1, lua: SCRIPT });
    this.redis = redis as WithCommand;
  }

  async take(key: string, cost: number, policy: RateLimitPolicy): Promise<RateLimitDecision> {
    if (cost > policy.capacity) throw new RangeError(`cost ${cost} exceeds bucket capacity ${policy.capacity}`);
    const [allowed, retryAfterMs] = await this.redis.erqTakeTokens(`ratelimit:${key}`, policy.capacity, policy.refillPerSecond, cost);
    return allowed === 1 ? { allowed: true } : { allowed: false, retryAfterMs };
  }
}
```

`apps/worker/src/sync/handler.ts`:

```ts
import { UnrecoverableError } from 'bullmq';
import { parseSyncPageJob, processSyncPage, resumeStalledRuns, type SyncDeps } from '@erq/sync';

const STALL_AFTER_MS = 10 * 60 * 1000;

/** The queue-facing logic: validate, process one page, enqueue what comes next. */
export async function handleSyncJob(
  deps: SyncDeps,
  job: { name: string; data: unknown },
  impl: { processSyncPage: typeof processSyncPage; resumeStalledRuns: typeof resumeStalledRuns } = { processSyncPage, resumeStalledRuns },
): Promise<void> {
  if (job.name === 'resume-stalled') {
    const now = (deps.now ?? (() => new Date()))();
    await impl.resumeStalledRuns(deps, new Date(now.getTime() - STALL_AFTER_MS));
    return;
  }
  let data;
  try {
    data = parseSyncPageJob(job.data);
  } catch {
    throw new UnrecoverableError('invalid sync job payload'); // never retry, never log the payload
  }
  const result = await impl.processSyncPage(deps, data);
  switch (result.kind) {
    case 'next': await deps.queue.enqueue(result.job); break;
    case 'delayed': await deps.queue.enqueue(data, { delayMs: result.delayMs }); break;
    case 'done': if (result.followUp) await deps.queue.enqueue(result.followUp); break;
    case 'failed': break;
  }
}
```

`apps/worker/src/sync/worker.ts`:

```ts
import { UnrecoverableError, Worker, type ConnectionOptions, type Queue } from 'bullmq';
import { failSyncRun, parseSyncPageJob, type SyncDeps } from '@erq/sync';
import { SYNC_QUEUE } from './bullmq-queue';
import { handleSyncJob } from './handler';

export function createSyncWorker(deps: SyncDeps, connection: ConnectionOptions, opts: { concurrency?: number } = {}): Worker {
  const worker = new Worker(SYNC_QUEUE, (job) => handleSyncJob(deps, job), { connection, concurrency: opts.concurrency ?? 5 });
  // After the last attempt, record the failure on the run so the owner sees it.
  worker.on('failed', (job, error) => {
    if (!job || job.name !== 'page') return;
    const finalAttempt = error instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!finalAttempt) return;
    try {
      void failSyncRun(deps, parseSyncPageJob(job.data), error.message).catch(() => undefined);
    } catch {
      /* invalid payload: there is no run to mark */
    }
  });
  return worker;
}

/** Every 5 minutes, re-enqueue runs whose cursor has not moved for 10 minutes. */
export async function scheduleResumeStalled(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler('resume-stalled', { every: 300_000 }, { name: 'resume-stalled', data: {} });
}
```

In `apps/worker/src/main.ts`, after the system worker is created, add (only when `DATABASE_URL` and `ENCRYPTION_KEY` are set; otherwise log `sync worker disabled`): create `createTenantDb(DATABASE_URL)`, `EnvKeyProvider.fromEnv(process.env)`, an empty `ConnectorRegistry` (real connectors are registered in 1b-3), `new RedisRateLimiter(connection)`, `new BullMqJobQueue(new Queue(SYNC_QUEUE, { connection }))`, build `SyncDeps`, `createSyncWorker(deps, connection, { concurrency: Number(process.env.SYNC_CONCURRENCY ?? 5) })`, call `scheduleResumeStalled(syncQueue)`, and close the sync worker, its queue and the database in the existing `shutdown` function. Add `SYNC_CONCURRENCY=5` to `.env.example` as an optional variable.

- [ ] **Step 4: Run to verify pass, then commit**

Run: `pnpm turbo run test typecheck build --filter=@erq/sync --filter=@erq/worker` then `pnpm lint`
Expected: PASS; the Redis and BullMQ tests report as skipped (no Docker here). State in the report that `RedisRateLimiter`, `BullMqJobQueue` and `createSyncWorker` are unverified until a machine with Docker runs them.

```bash
git add -A && git commit -m "feat(worker): add BullMQ sync queue, Redis rate limiter and sync job handler"
```

---

### Task 14: Documentation, spec amendments and project notes

**Files:**
- Create: `docs/sync.md`
- Modify: `docs/superpowers/specs/2026-10-06-phase1b1-sync-foundations-design.md`, `docs/architecture/tenancy.md`, `docs/metrics.md`, `CLAUDE.md` (section 16 and Decisions Log only)

- [ ] **Step 1: Write `docs/sync.md`**

Real content (no outlines), verified against the source you built:
1. **Overview:** the page-job chain with a text diagram (enqueueSync, page job, commit data and cursor, enqueue next, done, follow-up).
2. **Tables:** one paragraph per table group (locations, inventory, listings, orders, refunds, cursors) with the key constraints and why (composite foreign keys, partial unique indexes, append-only movements).
3. **Writing a connector:** the `StoreConnector.fetchPage` contract, normalization rules (cents are integers, refund `amountCents` excludes tax, dates are `Date`, opaque customer id only), the typed errors and what each does, the contract test suite (`runConnectorContract`) and the fake connector, credentials (encrypt with `encryptConnectionCredentials`, AAD `connection:<id>`).
4. **Idempotency and ordering rules:** the `external_updated_at` rule, the snapshot rule (`coalesce`, `repriceOrderLines` for deliberate recomputation), movement derivation, unmapped variants.
5. **Operations:** `enqueueSync` modes, one active run per connection and resource, `resumeStalledRuns` and the limitation that the `all` chain is not persisted, rate-limit policies (generic defaults until 1b-2), the `sync` queue and retry options, `SYNC_CONCURRENCY`.
6. **Known gaps:** the Redis limiter, BullMQ queue and sync worker are unverified until CI with Docker; one currency per org; no customers table.

- [ ] **Step 2: Amend the spec and other docs**

In `docs/superpowers/specs/2026-10-06-phase1b1-sync-foundations-design.md` change only the items that this plan refines: the cost-import sentence in §6.1 (cost written only when the SKU has no `product_cost` component; later Shopify cost changes are not applied automatically), `RateLimiter.take(key, cost, policy)`, `SyncPageJob.then`, the stalled-run SECURITY DEFINER function `app_list_stalled_sync_cursors`, `NormalizedRefund.amountCents` excludes tax, org-timezone order dates, `PageResult.next` carries the job, and the compare-and-set check in §6.3. In `docs/architecture/tenancy.md` add `app_list_stalled_sync_cursors` to the SECURITY DEFINER section (the only intentional cross-tenant read, used by the stalled-run resumer) and `inventory_movements` to the append-only section. In `docs/metrics.md` add one line documenting `isCostInEffect`.

- [ ] **Step 3: Update `CLAUDE.md` (section 16 and Decisions Log only)**

Section 16 "Built": add `packages/sync` (engine and sinks), `packages/connectors` (now: page-based contract, typed errors, fake connector and contract suite), and the new tables. Add to "Rules that are easy to break": sinks must be idempotent and respect `external_updated_at`; a cursor never advances without its data (same transaction); connectors never touch the database; credentials are encrypted with AAD `connection:<id>` and never travel in job data; `app_list_stalled_sync_cursors` is the only intentional cross-tenant read. Add to "Not yet verified by running": the Redis rate limiter, BullMQ sync queue and sync worker. Append Decisions Log lines dated 2026-10-06: page-job chain with the cursor committed in the same transaction; opaque customer id only (customers table in Phase 2); one currency per org in Phase 1; Shopify cost import never overwrites existing costs; order dates for snapshots in the org timezone; stalled runs found through a SECURITY DEFINER function. Change nothing else.

- [ ] **Step 4: Verify and commit**

Run: `pnpm lint` then, one package at a time, `pnpm turbo run test typecheck build --filter=@erq/db`, `--filter=@erq/connectors`, `--filter=@erq/sync`, `--filter=@erq/worker`, `--filter=@erq/metrics`.
Expected: PASS everywhere (Redis tests skipped). Report per-package test counts.

```bash
git add -A && git commit -m "docs(sync): document the sync engine, amend the spec and update project notes"
```

---

## Self-Review Notes

- **Spec coverage:** §4 data model (Tasks 1, 2), §5 connector contract, errors, credentials, registry (Task 4), fake connector and contract suite (Task 5), §6.1 units (Tasks 6 to 10), §6.2 entry points (Task 11), §6.3 steps and §6.4 errors (Tasks 11, 12), §6.5 idempotency (Tasks 8 to 10, 12), §7 worker glue (Task 13), §8 testing (every task), docs and notes (Task 14). Out-of-scope items (real Shopify, OAuth, webhooks, API and UI, schedules beyond the stalled-run resumer, CSV, customers, FX) have no task.
- **Success criteria:** 1 (migrations, isolation suite) Tasks 1, 2; 2 (multi-page backfill, replay, crash resume) Task 12; 3 (older update never overwrites) Tasks 8 to 10; 4 (error classes) Task 11; 5 (snapshots, reprice) Tasks 7, 10; 6 (lint, typecheck, tests) every task's verification.
- **Judgement calls recorded in Global Constraints:** cost import never overwrites, `take(key, cost, policy)`, chained `all` syncs, stalled-run SECURITY DEFINER function, refund amount excludes tax, org-timezone dates. Known limitation recorded in code and docs: the `then` chain is not persisted across a resume.

