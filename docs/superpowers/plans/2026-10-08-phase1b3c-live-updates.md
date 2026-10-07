# Phase 1b-3c: Live Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a connected Shopify shop fresh without anyone pressing Sync now: expiring offline tokens with safe refresh, a scheduler that polls on a tiered cadence, webhook nudges for products and stock, an order-line link-up pass, honest per-resource "last synced" status, and retry plus alert for failed webhook events.

**Architecture:** The connector stays database-free; token refresh is driven from `@erq/sync` through a `TokenService` that refreshes under a per-connection row lock. A one-minute ticker job in the worker reads a SECURITY DEFINER due-query, re-checks it with a pure `dueResources` function and starts chains through the existing `enqueueSync`. Webhook events for `products/update` and `inventory_levels/update` only nudge a sync (they never carry data). Status is computed from the per-resource sync cursors.

**Tech Stack:** TypeScript strict, zod v3, Drizzle ORM + hand-written SQL migrations, Postgres (RLS), BullMQ, Vitest 5, NestJS 11, Next.js 15.

**Spec:** `docs/superpowers/specs/2026-10-08-phase1b3c-live-updates-design.md` (the spec is the authority; where this plan refines it, the Plan notes below say what differs and why).

## Plan notes (spec versus code, and the rulings)

Each note: what the spec said, what the code does, what this plan does and why.

1. **Sync modes.** Spec: `enqueueSync(..., mode: 'full')` for the hourly inventory pass and the daily products pass. Code: `SyncMode` is `'backfill' | 'incremental'` only (`packages/sync/src/ports.ts`), and `fetchInventory` ignores `updatedSince` (it is ALWAYS a full pass). Ruling: inventory's hourly pass is a plain `incremental` run (already full). A real `'full'` mode is added (Task 4) only for products: the run type is `'full'`, `startRun` clears the cursor's `updated_since` so the connector gets no filter, and a completed `backfill` or `full` run stamps the new `sync_cursors.last_full_pass_at`. The daily full pass is a chain `[products, inventory]` in mode `full` (inventory ignores the mode); locations and orders go in a separate incremental chain, so on that one daily tick orders may run before products finish (the link-up pass of Task 8 repairs lines that arrive early).
2. **Where `last_synced_at` lives.** Per resource it is `sync_cursors.last_synced_at`, set when that resource's run completes. `store_connections.last_synced_at` is set to `now` by any chain end (including a single-resource run), which is the behaviour the spec changes. Ruling (Task 4): the connection column becomes the oldest of the four cursor times, only when all four resources have completed, else unchanged.
3. **"Null after a completed first backfill".** Spec section 3.2. Unreachable: a completed backfill sets the time. Ruling: a connection counts as backfilled when all four cursors have a non-null `last_synced_at`; anything else is skipped by the scheduler (the first backfill belongs to connect and Sync now).
4. **Failure back-off (not in the spec).** A failed cursor keeps its old `last_synced_at`, so a cadence check alone would retry it every minute forever. Ruling: for a `failed` cursor the cadence is measured from `max(last_synced_at, updated_at)` (the last attempt), in SQL and in `dueResources`, and the same wait applies to the forced daily products pass and to nudges. Pinned in Tasks 5, 6, 7.
5. **Token expiry columns.** The expiry lives inside the encrypted blob, so SQL cannot select shops with an aging refresh token (spec 2.3 "idle shops"). Ruling: two non-secret columns `store_connections.access_token_expires_at` and `refresh_token_expires_at` (migration 0022) are written wherever credentials are written (install, refresh). A second SECURITY DEFINER function `app_list_idle_refresh_connections` (migration 0024) uses them. The idle refresh runs inline in the tick (a call to the token service), not as a separate BullMQ job type, so job payloads do not change.
6. **TokenService injection.** `SyncDeps` gains an optional `tokens?: TokenService`. When absent the engine builds a default from `deps.db` and `deps.keyProvider` with no refresh function (old-shape credentials work, an expiring set that needs refreshing fails with a `PermanentError`). The worker builds the real one with `refreshAccessToken` from `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` (the worker did not read these before). The engine hands the connector only `{ accessToken }` for an expiring set and the raw decrypted blob for anything else, so the engine stays platform neutral and the connector never sees the refresh token. A final refresh `401` reuses the existing `AuthError` path (`failRun` with `connectionError: true`), so no new failure path exists.
7. **Webhook topics in the worker.** `handler.ts` parks `products/update` and `inventory_levels/update` as `deferred` today (they sit in `DATA_TOPICS`). They move to the nudge path; the other data topics stay `deferred`. The API receiver accepts any topic and stores it with payload `{}`, so it does not change. `SHOPIFY_FUTURE_DATA_WEBHOOK_TOPICS` loses those two topics.
8. **Debounce.** Spec: "a job id bucketed per connection, resource and minute". Code: `enqueueSync` commits the run row BEFORE it enqueues, so a BullMQ `jobId` collision would silently drop the job and leave a committed ghost run until the stalled-run resumer (10 minutes). Ruling: the debounce is a database gate in the nudge handler (drop when any cursor of the connection is running, when the resource completed within 60 s, or when its last failed attempt was within 60 s). A burst of events therefore becomes at most one sync per resource per minute with no ghost runs. The trade-off (an event arriving within a minute after a run read the data waits for the next poll) is accepted because polling is the safety net.
9. **Re-registering webhooks for existing connections.** Nothing records which topics a connection registered. Ruling: no new column; `registerWebhooks` is idempotent ("already taken" counts as registered), so the scheduler re-runs it for a connection on the same tick its daily products pass is due (at most once per day per connection, inside the 50-connection cap). A rejected subscription sets the existing connection warning `Webhook setup failed. Reconnect to retry.` only when `last_error` is empty, and a later full success clears it only when `last_error` is exactly that text.
10. **Retry counter and alerts.** `webhook_events` has no usable column (only `status`, `error`, `updated_at`), and no `alerts` table exists although CLAUDE.md section 5 lists one. Ruling: migration 0025 adds `webhook_events.sweep_retries` and a proper tenant table `alerts` (composite FK to `store_connections`, partial unique index on open alerts, `app_secure_tenant_table` in 0026, a fixture in `packages/db/test/fixtures.ts`, isolation coverage). The alert message is a FIXED text per topic, not the error text, so no stored string can carry a secret. `app_list_stale_webhook_events` is replaced with `CREATE OR REPLACE` (same signature, never editing 0021). The sweep needs a `db` to bump the counter.
11. **Link-up placement.** The page transaction holds the cursor row lock, so the link-up runs AFTER the products chain end has committed, in its own bounded transactions (500 lines per batch, at most 200 batches). A failure there never fails the finished run; the pass is idempotent and the next products run repeats it.
12. **DTO.** Spec 6 lists `resources`. Spec 5 also says unmatched lines are "counted for the status page", so `ConnectionSyncDto` also gains `unlinkedLines: number`. `ConnectionDto` gains `alerts` (spec 7).
13. **Migrations.** The spec says "a new migration" for each of three concerns; the plan numbers them 0022 (token expiry columns), 0023 (`sync_cursors.last_full_pass_at`), 0024 (the two scheduler functions), 0025 (`sweep_retries`, `alerts`), 0026 (alerts RLS and the replaced sweep function). Schema changes are generated with `drizzle-kit generate`; SQL-only changes use `drizzle-kit generate --custom` (that writes the journal entry and snapshot). Never edit an existing migration.
14. **Task split.** The spec lists ten tasks. This plan has twelve: spec task 2 is split into the connector refresh function (Task 2) and the TokenService with the row lock and engine wiring (Task 3), because a reviewer could approve the pure HTTP function and reject the lock design; spec task 3 is split into the `full` mode and connection-freshness change (Task 4, a dependency of the due logic) and the due query and pure function (Task 5). Order otherwise follows the spec.
15. **Known gap closed here.** docs/sync.md lists "the connection-health row lock has no test that interleaves two writers". Task 4 adds that test because it changes the same update.
16. **Cadence arithmetic.** A resource is due when `now - reference >= cadence` (exactly at the cadence counts as due).

## Global Constraints

- Branch `phase1b3c-live-updates` (created, spec committed). Every commit message ends with the exact line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Cadences (`SYNC_CADENCE_MS` in `@erq/sync`): locations 15 min, products 15 min, orders 15 min (incremental); inventory 60 min (a full pass); `PRODUCTS_FULL_PASS_MS` 24 h. `MAX_CONNECTIONS_PER_TICK` 50. The ticker runs every 60 s (fixed scheduler id so restarts do not multiply it).
- Token refresh: refresh when the access token expires within 5 minutes (`REFRESH_WINDOW_MS`, injected `now`). Idle refresh: connections whose refresh token expires within 14 days (`IDLE_REFRESH_WINDOW_MS`) and whose access token is expired or about to be. Token lifetimes (Shopify, checked 2026-10-08 against https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens and `.../implement-token-exchange`): access token 1 hour (`expires_in` 3600), refresh token 90 days (`refresh_token_expires_in` 7776000). `expiring=1` on the code exchange. Refresh is `POST https://{shop}/admin/oauth/access_token` with `client_id`, `client_secret`, `grant_type=refresh_token`, `refresh_token`; EVERY refresh returns a NEW access token and a NEW refresh token (rotation); a final `401 {"error":"invalid_request"}` covers every terminal cause; only network errors, timeouts, 5xx and 429 are retried, with the SAME refresh token. These shapes are unverified against a real shop.
- Reconnect text (fixed, through `sanitizeMessage`): `Shopify no longer accepts this connection. Reconnect the store.`
- Webhook topics (tiered): subscribe to `app/uninstalled`, `products/update`, `inventory_levels/update` only. Order, refund and customer topics are NOT subscribed (protected customer data approval not requested), so orders stay polling-only (15 minutes). Nudges: `products/update` to products, `inventory_levels/update` to inventory. Nudge debounce 60 s.
- Webhook sweep: failed non-privacy events are re-listed after a 10-minute cool-down (`STALE_EVENT_MS`), at most 5 sweep retries per event (`sweep_retries`), then they stay `failed` and ONE `alerts` row is written (type `webhook_failed`; severity `high` for `app/uninstalled`, `medium` otherwise). Privacy topics (`customers/data_request`, `customers/redact`, `shop/redact`) keep their unlimited retry from migration 0021 and never raise this alert.
- Credentials and tokens: access token AND refresh token never appear in logs, job payloads, DTOs, audit rows, thrown messages or stored `last_error` text. Connector errors use FIXED strings; stored error text always passes through `sanitizeMessage`. Tests assert this with the actual values used in the test, not with literal prefixes.
- Shopify rejects a GraphQL query whose requested cost exceeds 1000 points. The only new query is the existing `webhookSubscriptionCreate` mutation (one tiny object, no pagination, cost about 10 points; a comment says so). No new paginated or nested query is added. Every loop added by this plan has a bound and a null/zero-progress guard, and a test pins it.
- The cursor never advances without its data (same transaction, compare-and-set). The engine's connection-health update happens only at a real chain end and never for `resumed` jobs; `failRun` never touches disconnected or demo connections. Lock order is cursor row, then connection row; any new row lock follows it (the token refresh takes ONLY the connection row lock, never while holding a cursor lock).
- New SECURITY DEFINER functions: `SET search_path = pg_catalog, public, pg_temp`, `REVOKE ALL ... FROM PUBLIC`, revoke from `anon` and `authenticated` when they exist, `GRANT EXECUTE` to `app_user` only, and a Postgres test for the hardening. They are worker-only and never exposed through an API route. New tenant tables need `app_secure_tenant_table`, a fixture and composite `(org_id, id)` foreign keys.
- Existing behaviours that must keep working: `enqueueSync` failure cleanup (`abandonRun`), the `resumed` flag, Sync now's running-cursor guard and its 409/503 semantics, the privacy sweep (0021), webhook receiver idempotency and empty payload storage, and the `describeSync` wording rules (never claim more than the oldest resource; an `error` connection shows its `lastError`).
- Redis/BullMQ, real Shopify and Playwright cannot run in this environment (no Docker): everything is tested against fakes and the embedded Postgres. The unverifiable items are listed for the first-install checklist in Task 12.
- TypeScript strict, no `any` without a comment. Prettier before every commit. ESLint rejects unused destructured variables: avoid `_x` destructuring in tests.
- Disk is tight (about 1-2 GB free): run verification one package at a time with `--concurrency=1` or a single test file; never run a web production build except in Task 12; after any test run that starts a database, check that no `postgres` process and no `%TEMP%\erq-pg-*` directory remains; delete `.turbo` and `apps/web/.next` when done.
- Windows: quote every path in bash (the repo folder name contains a space). Other packages load `@erq/db`, `@erq/connectors` and `@erq/sync` from `dist`: run `pnpm turbo run build --filter=@erq/db --filter=@erq/connectors --filter=@erq/sync --filter=@erq/shared` before running another package's tests directly, and again after changing any of those packages.

## Review Focus

Failure modes the spec implies that need explicit tests, most likely first (each pinned in the task named):

1. **Two jobs refresh the same shop at once.** A rotated refresh token cannot be reused, so a second refresh with the old token would end in a forced reconnect. Expected: the second caller waits on the row lock, re-reads, sees the rotated pair and does not call Shopify; the new pair is written in the same transaction that holds the lock; a transient failure leaves the stored pair untouched and the retry uses the SAME refresh token; a final failure shows the fixed reconnect text with no token in it. Task 3 (real concurrent transactions on the embedded Postgres) and Task 2 (fake rotation).
2. **A failing shop retried every minute.** A failed cursor keeps its old completion time, so a naive "older than 15 minutes" check re-runs it on every tick, and a running cursor or a never-backfilled connection must never be started by the ticker. Expected: failed resources wait one cadence from the last attempt, running blocks, 52 due connections need two ticks (cap 50), one failing enqueue does not stop the tick. Tasks 5 and 6.
3. **A burst of webhooks.** Hundreds of `inventory_levels/update` events in a minute, events for disconnected, errored or never-imported shops, and a Redis outage while nudging. Expected: at most one sync per resource per minute, dropped while anything runs, dropped for every non-`active` connection, payload still `{}`, and a queue failure leaves no running cursor and the event retried. Task 7.
4. **Order lines whose product arrives late.** Expected: the line gets its SKU and the unit cost in effect on the ORDER date in the org timezone (not today's cost), a line that already has a SKU or snapshot is never changed, another connection's or another org's lines with the same variant id are untouched, and the loop is bounded. Task 8.
5. **A headline that claims more than is true.** A single-resource nudge must not mark the whole connection fresh, one failed or never-imported resource must be named, and a failure must not hide behind an old good time. Expected: the connection's `last_synced_at` is the OLDEST of the four resource times and only exists when all four completed; the UI shows each resource's own line. Tasks 4, 9 and 10.

(Also pinned: exactly one alert at exhaustion of the sweep retries, Task 11.)

## File Structure

```
packages/connectors/src/shopify/credentials.ts            (create: stored credential shapes, expiry helpers)
packages/connectors/src/shopify/token.ts                  (modify: expiring exchange, refreshAccessToken)
packages/connectors/src/shopify/webhooks.ts               (modify: topics)
packages/connectors/src/sanitize.ts                       (modify: refresh token patterns)
packages/connectors/src/testing/fake-shopify.ts           (modify: expiring exchange, rotation, rejected topics)
packages/db/src/schema/{connections,orders,webhooks}.ts   (modify: columns)
packages/db/src/schema/alerts.ts                          (create)
packages/db/migrations/0022..0026 + meta                  (create)
packages/sync/src/tokens.ts                               (create: TokenService)
packages/sync/src/linkup.ts                               (create: order-line link-up)
packages/sync/src/schedule/{cadence,due,tick}.ts          (create)
packages/sync/src/engine/{deps,start,process,fail}.ts, ports.ts, job-schema.ts   (modify)
apps/worker/src/sync/{tokens,handler,worker}.ts, main.ts  (create/modify)
apps/worker/src/webhooks/{nudge,reconcile,handler,sweep}.ts (create/modify)
apps/api/src/connections/connections.service.ts           (modify)
packages/shared/src/connections.ts                        (modify: DTOs)
apps/web/src/lib/connections.ts, app/(app)/connections/page.tsx   (modify)
docs/sync.md, docs/shopify-connection.md, CLAUDE.md       (modify, Task 12)
```

---

## Part A: Tokens

### Task 1: Expiring-token exchange and the new credentials shape

**Files:**
- Create: `packages/connectors/src/shopify/credentials.ts`
- Modify: `packages/connectors/src/shopify/token.ts` (replace the whole file), `packages/connectors/src/shopify/index.ts`, `packages/connectors/src/testing/fake-shopify.ts`
- Modify: `packages/db/src/schema/connections.ts`; generated `packages/db/migrations/0022_token_expiry.sql` and `migrations/meta/*`
- Modify: `apps/api/src/connections/connections.service.ts` (`completeInstall`)
- Test: `packages/connectors/test/shopify-token.test.ts` (update one test, add four), `packages/connectors/test/shopify-credentials.test.ts` (create), `packages/db/test/token-expiry-columns.test.ts` (create), `apps/api/test/connections.test.ts` (update one test, add two)

**Interfaces:**
- Produces (connectors, exported from `@erq/connectors`):
  - `SHOPIFY_RECONNECT_MESSAGE = 'Shopify no longer accepts this connection. Reconnect the store.'`
  - `interface ShopifyTokenGrant { accessToken: string; scopes: string[]; accessTokenExpiresInSec: number | null; refreshToken: string | null; refreshTokenExpiresInSec: number | null }`
  - `interface ShopifyRefreshGrant extends ShopifyTokenGrant { accessTokenExpiresInSec: number; refreshToken: string; refreshTokenExpiresInSec: number }`
  - `exchangeCodeForToken(http: HttpClient, p: { shop: string; apiKey: string; apiSecret: string; code: string }): Promise<ShopifyTokenGrant>` (now sends `expiring=1`; the old return value `{ accessToken, scopes }` is a subset)
  - `interface StoredShopifyCredentials { accessToken: string; accessTokenExpiresAt?: string; refreshToken?: string; refreshTokenExpiresAt?: string }`
  - `credentialsFromGrant(grant: ShopifyTokenGrant, now: Date): StoredShopifyCredentials`
  - `credentialExpiry(c: StoredShopifyCredentials): { accessTokenExpiresAt: Date | null; refreshTokenExpiresAt: Date | null }`
  - `interface ExpiringCredentials { accessToken: string; accessTokenExpiresAt: Date; refreshToken: string; refreshTokenExpiresAt: Date }`
  - `readExpiringCredentials(raw: unknown): ExpiringCredentials | null` (null = not an expiring set: old shape, another platform, null; throws `AuthError('Stored credentials are unusable. Reconnect the store.')` for a partial or garbled expiring set)
- Produces (db): `storeConnections.accessTokenExpiresAt`, `storeConnections.refreshTokenExpiresAt` (`timestamptz`, nullable; columns `access_token_expires_at`, `refresh_token_expires_at`).
- Consumes: existing `HttpClient`, `AuthError`, `PermanentError`, `RateLimitedError`, `TransientError`, `isValidShopDomain`.

- [ ] **Step 1: Write the failing tests**

Replace the test `returns the token and scopes and sends the documented request` in `packages/connectors/test/shopify-token.test.ts` (its exact `toEqual({ accessToken, scopes })` and the three-key form assertion no longer hold) and add the new tests in the same `describe('exchangeCodeForToken')`:

```ts
  it('asks for an expiring offline token and returns the lifetimes and the refresh token', async () => {
    const http = new FakeShopify({
      token: 'shpat_abc',
      refreshToken: 'shprt_abc',
      scope: 'read_orders,read_products',
    });
    await expect(exchangeCodeForToken(http, p)).resolves.toEqual({
      accessToken: 'shpat_abc',
      accessTokenExpiresInSec: 3600,
      refreshToken: 'shprt_abc',
      refreshTokenExpiresInSec: 7776000,
      scopes: ['read_orders', 'read_products'],
    });
    const req = http.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://a.myshopify.com/admin/oauth/access_token');
    expect(req.headers?.['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(req.body!))).toEqual({
      client_id: 'k',
      client_secret: 's3cret',
      code: 'good-code',
      expiring: '1',
    });
  });
  it('treats a response without any expiry field as a non-expiring token', async () => {
    const http = new FakeShopify();
    http.respondNext({
      status: 200,
      body: JSON.stringify({ access_token: 'shpat_old', scope: 'read_orders' }),
    });
    await expect(exchangeCodeForToken(http, p)).resolves.toEqual({
      accessToken: 'shpat_old',
      accessTokenExpiresInSec: null,
      refreshToken: null,
      refreshTokenExpiresInSec: null,
      scopes: ['read_orders'],
    });
  });
  it.each([
    ['only a refresh token', { refresh_token: 'shprt_x' }],
    ['only a lifetime', { expires_in: 3600 }],
    ['no refresh lifetime', { expires_in: 3600, refresh_token: 'shprt_x' }],
    ['a zero lifetime', { expires_in: 0, refresh_token: 'shprt_x', refresh_token_expires_in: 10 }],
    ['a fractional lifetime', { expires_in: 1.5, refresh_token: 'shprt_x', refresh_token_expires_in: 10 }],
  ])('rejects a partial or invalid expiring set (%s) with a fixed message', async (_name, extra) => {
    const http = new FakeShopify();
    http.respondNext({
      status: 200,
      body: JSON.stringify({ access_token: 'shpat_secret_value', scope: '', ...extra }),
    });
    await expect(exchangeCodeForToken(http, p)).rejects.toMatchObject({
      name: 'PermanentError',
      message: 'Shopify returned an unreadable token response',
    });
  });
  it('never puts the secret, the code or a token in an error message', async () => {
    for (const status of [400, 401, 403, 429, 500, 503]) {
      const http = new FakeShopify({ token: 'shpat_abc', refreshToken: 'shprt_abc' });
      http.failNext(status);
      const err = (await exchangeCodeForToken(http, p).catch((e: unknown) => e)) as Error;
      for (const secret of ['s3cret', 'good-code', 'shpat_abc', 'shprt_abc']) {
        expect(err.message).not.toContain(secret);
      }
    }
  });
```
(`_name` is only for the test title; ESLint allows an unused argument that comes before a used one.)

Create `packages/connectors/test/shopify-credentials.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  AuthError,
  credentialExpiry,
  credentialsFromGrant,
  readExpiringCredentials,
  type ShopifyTokenGrant,
} from '../src';

const NOW = new Date('2026-10-08T12:00:00.000Z');
const expiring: ShopifyTokenGrant = {
  accessToken: 'shpat_a',
  scopes: ['read_orders'],
  accessTokenExpiresInSec: 3600,
  refreshToken: 'shprt_a',
  refreshTokenExpiresInSec: 7776000,
};

describe('credentialsFromGrant', () => {
  it('stores absolute ISO expiry times for an expiring grant and never the scopes', () => {
    expect(credentialsFromGrant(expiring, NOW)).toEqual({
      accessToken: 'shpat_a',
      accessTokenExpiresAt: '2026-10-08T13:00:00.000Z',
      refreshToken: 'shprt_a',
      refreshTokenExpiresAt: '2027-01-06T12:00:00.000Z',
    });
  });
  it('stores only the access token for a non-expiring grant', () => {
    const grant = { ...expiring, accessTokenExpiresInSec: null, refreshToken: null, refreshTokenExpiresInSec: null };
    expect(credentialsFromGrant(grant, NOW)).toEqual({ accessToken: 'shpat_a' });
  });
});

describe('credentialExpiry', () => {
  it('mirrors the two times as dates, and nulls for the old shape', () => {
    expect(credentialExpiry(credentialsFromGrant(expiring, NOW))).toEqual({
      accessTokenExpiresAt: new Date('2026-10-08T13:00:00.000Z'),
      refreshTokenExpiresAt: new Date('2027-01-06T12:00:00.000Z'),
    });
    expect(credentialExpiry({ accessToken: 'shpat_old' })).toEqual({
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    });
  });
});

describe('readExpiringCredentials', () => {
  it('returns null for the old shape and for values that are not credentials', () => {
    expect(readExpiringCredentials({ accessToken: 'shpat_old' })).toBeNull();
    for (const raw of [null, undefined, 'x', 5, [], {}]) expect(readExpiringCredentials(raw)).toBeNull();
  });
  it('reads a complete expiring set with real dates', () => {
    expect(readExpiringCredentials(credentialsFromGrant(expiring, NOW))).toEqual({
      accessToken: 'shpat_a',
      accessTokenExpiresAt: new Date('2026-10-08T13:00:00.000Z'),
      refreshToken: 'shprt_a',
      refreshTokenExpiresAt: new Date('2027-01-06T12:00:00.000Z'),
    });
  });
  it.each([
    ['a refresh token without times', { accessToken: 'shpat_a', refreshToken: 'shprt_secret_1' }],
    ['a time without a refresh token', { accessToken: 'shpat_a', accessTokenExpiresAt: '2026-10-08T13:00:00.000Z' }],
    ['a bad date', { accessToken: 'shpat_a', accessTokenExpiresAt: 'soon', refreshToken: 'shprt_secret_2', refreshTokenExpiresAt: '2027-01-06T12:00:00.000Z' }],
    ['a missing access token', { accessTokenExpiresAt: '2026-10-08T13:00:00.000Z', refreshToken: 'shprt_secret_3', refreshTokenExpiresAt: '2027-01-06T12:00:00.000Z' }],
  ])('throws a fixed AuthError for %s and echoes no value', (_name, raw) => {
    let caught: unknown;
    try {
      readExpiringCredentials(raw);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AuthError);
    expect((caught as Error).message).toBe('Stored credentials are unusable. Reconnect the store.');
  });
});
```

Create `packages/db/test/token-expiry-columns.test.ts`:

```ts
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTenantDb, storeConnections, type TenantDb } from '../src';
import { startTestDatabase, type TestDatabase } from '../src/testing';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let tdb: TestDatabase;
let owner: Pool;
let db: TenantDb;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  db = createTenantDb(tdb.appUrl);
  for (const org of [A, B]) {
    await owner.query(
      `insert into orgs (id, name, slug) values ($1, 'Org', 'org-' || ($1::uuid)::text)`,
      [org],
    );
    await owner.query(
      `insert into store_connections (id, org_id, platform, external_account_id, status) values ($1, $1, 'shopify', ($1::uuid)::text || '.myshopify.com', 'active')`,
      [org],
    );
  }
}, 120_000);
afterAll(async () => {
  await db?.close();
  await owner?.end();
  await tdb?.stop();
});

describe('store_connections token expiry columns', () => {
  it('are nullable, writable by the owning tenant and invisible to another tenant', async () => {
    const access = new Date('2026-10-08T13:00:00.000Z');
    const refresh = new Date('2027-01-06T12:00:00.000Z');
    const written = await db.withTenant(A, (tx) =>
      tx
        .update(storeConnections)
        .set({ accessTokenExpiresAt: access, refreshTokenExpiresAt: refresh })
        .where(eq(storeConnections.id, A))
        .returning({ a: storeConnections.accessTokenExpiresAt, r: storeConnections.refreshTokenExpiresAt }),
    );
    expect(written).toEqual([{ a: access, r: refresh }]);
    const crossTenant = await db.withTenant(B, (tx) =>
      tx.update(storeConnections).set({ accessTokenExpiresAt: null }).where(eq(storeConnections.id, A)).returning({ id: storeConnections.id }),
    );
    expect(crossTenant).toEqual([]);
    const { rows } = await owner.query(
      `select access_token_expires_at, refresh_token_expires_at from store_connections where id = $1`,
      [B],
    );
    expect(rows[0]).toEqual({ access_token_expires_at: null, refresh_token_expires_at: null });
  });
});
```

In `apps/api/test/connections.test.ts`, update the assertion in `connects the store for the user who started it` from
`.toEqual({ accessToken: 'shpat_fake_token' })` to
`.toMatchObject({ accessToken: 'shpat_fake_token', refreshToken: 'shprt_fake_refresh' })`, and add inside `describe('POST /connections/shopify/callback')`:

```ts
  it('stores an expiring token set encrypted, mirrors only the expiry times in plain columns, and keeps both tokens out of audit rows, the list and jobs', async () => {
    const { orgId, h } = await createOrg('Expiring Org');
    const state = await startInstall(orgId, h);
    fake.respondNext({
      status: 200,
      body: JSON.stringify({
        access_token: 'shpat_unique_91bb',
        scope: 'read_orders',
        expires_in: 3600,
        refresh_token: 'shprt_unique_91bb',
        refresh_token_expires_in: 7776000,
      }),
    });
    const before = Date.now();
    const res = await callbackAs(authOnly(h), rawSigned(state));
    expect(res.body).toEqual({ redirectTo: connected });
    const { rows } = await owner.query(
      `select id, encrypted_credentials, access_token_expires_at, refresh_token_expires_at from store_connections where org_id = $1`,
      [orgId],
    );
    const key = EnvKeyProvider.fromEnv({
      ENCRYPTION_KEY_ID: 'k1',
      ENCRYPTION_KEY: SHOPIFY_ENV.ENCRYPTION_KEY,
    });
    const creds = decryptConnectionCredentials(rows[0].encrypted_credentials, key, rows[0].id) as Record<string, string>;
    expect(Object.keys(creds).sort()).toEqual(['accessToken', 'accessTokenExpiresAt', 'refreshToken', 'refreshTokenExpiresAt']);
    expect([creds.accessToken, creds.refreshToken]).toEqual(['shpat_unique_91bb', 'shprt_unique_91bb']);
    const accessAt = new Date(creds.accessTokenExpiresAt!).getTime();
    expect(accessAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(accessAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
    expect(rows[0].access_token_expires_at.toISOString()).toBe(creds.accessTokenExpiresAt);
    expect(rows[0].refresh_token_expires_at.toISOString()).toBe(creds.refreshTokenExpiresAt);
    const audit = await owner.query(`select * from audit_log where org_id = $1`, [orgId]);
    const listed = await request(server()).get(`/orgs/${orgId}/connections`).set(h);
    const visible = JSON.stringify([rows, audit.rows, listed.body, syncQueue.jobs]);
    for (const secret of ['shpat_unique_91bb', 'shprt_unique_91bb']) expect(visible).not.toContain(secret);
  });

  it('stores a non-expiring response as the old shape with empty expiry columns', async () => {
    const { orgId, h } = await createOrg('Non Expiring Org');
    const state = await startInstall(orgId, h);
    fake.respondNext({
      status: 200,
      body: JSON.stringify({ access_token: 'shpat_old_77', scope: 'read_orders' }),
    });
    await callbackAs(authOnly(h), rawSigned(state));
    const { rows } = await owner.query(
      `select id, encrypted_credentials, access_token_expires_at, refresh_token_expires_at from store_connections where org_id = $1`,
      [orgId],
    );
    const key = EnvKeyProvider.fromEnv({ ENCRYPTION_KEY_ID: 'k1', ENCRYPTION_KEY: SHOPIFY_ENV.ENCRYPTION_KEY });
    expect(decryptConnectionCredentials(rows[0].encrypted_credentials, key, rows[0].id)).toEqual({ accessToken: 'shpat_old_77' });
    expect([rows[0].access_token_expires_at, rows[0].refresh_token_expires_at]).toEqual([null, null]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @erq/connectors exec vitest run test/shopify-token.test.ts test/shopify-credentials.test.ts`
Expected: FAIL (`credentialsFromGrant` and the new return shape do not exist).
Run: `pnpm --filter @erq/db exec vitest run test/token-expiry-columns.test.ts`
Expected: FAIL (TypeScript/Drizzle: `accessTokenExpiresAt` is not a column).

- [ ] **Step 3: Implement the connector side**

Replace `packages/connectors/src/shopify/token.ts`:

```ts
// https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
// https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens
//   (expiring=1 on the code exchange; refresh with grant_type=refresh_token; every refresh rotates both tokens)
// Unverified against a real shop (checked in the docs on 2026-10-08): see docs/shopify-connection.md.
import { z } from 'zod';
import { AuthError, PermanentError, RateLimitedError, TransientError } from '../errors';
import { isValidShopDomain } from './domain';
import type { HttpClient } from './http';

/** Shown to the owner when Shopify refuses to refresh the token (final: reconnecting is the only fix). */
export const SHOPIFY_RECONNECT_MESSAGE =
  'Shopify no longer accepts this connection. Reconnect the store.';

const UNREADABLE = 'Shopify returned an unreadable token response';

const tokenBody = z.object({
  access_token: z.string().min(1),
  scope: z.string().default(''),
  expires_in: z.number().int().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  refresh_token_expires_in: z.number().int().positive().optional(),
});

export interface ShopifyTokenGrant {
  accessToken: string;
  scopes: string[];
  /** Seconds the access token lives; null for a non-expiring token. */
  accessTokenExpiresInSec: number | null;
  refreshToken: string | null;
  refreshTokenExpiresInSec: number | null;
}
/** A refresh always returns a complete, rotated pair. */
export interface ShopifyRefreshGrant extends ShopifyTokenGrant {
  accessTokenExpiresInSec: number;
  refreshToken: string;
  refreshTokenExpiresInSec: number;
}

interface TokenRequest {
  shop: string;
  form: Record<string, string>;
  /** Message for a 401 or 403. */
  authMessage: string;
  /** Message for any other non-200 answer. */
  rejectedMessage: string;
  /** A refresh must return all three expiry fields. */
  requireExpiring: boolean;
}

async function requestToken(http: HttpClient, p: TokenRequest): Promise<ShopifyTokenGrant> {
  if (!isValidShopDomain(p.shop)) throw new PermanentError('Invalid shop domain');
  const res = await http.request({
    method: 'POST',
    url: `https://${p.shop}/admin/oauth/access_token`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(p.form).toString(),
  });
  if (res.status === 401 || res.status === 403) throw new AuthError(p.authMessage);
  if (res.status === 429) {
    // Blank, non-numeric or negative values count as missing (Number('') would be 0).
    const raw = res.headers['retry-after']?.trim() ?? '';
    const seconds = raw === '' ? NaN : Number(raw);
    throw new RateLimitedError(Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 2000);
  }
  if (res.status >= 500) throw new TransientError('Shopify is temporarily unavailable');
  if (res.status !== 200) throw new PermanentError(p.rejectedMessage);
  let parsed: z.infer<typeof tokenBody>;
  try {
    parsed = tokenBody.parse(JSON.parse(res.body));
  } catch {
    throw new PermanentError(UNREADABLE);
  }
  // All three expiry fields or none: a half-described token cannot be refreshed safely.
  const present = [parsed.expires_in, parsed.refresh_token, parsed.refresh_token_expires_in].filter(
    (v) => v !== undefined,
  ).length;
  if (present !== 0 && present !== 3) throw new PermanentError(UNREADABLE);
  if (p.requireExpiring && present !== 3) throw new PermanentError(UNREADABLE);
  return {
    accessToken: parsed.access_token,
    scopes: parsed.scope
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    accessTokenExpiresInSec: parsed.expires_in ?? null,
    refreshToken: parsed.refresh_token ?? null,
    refreshTokenExpiresInSec: parsed.refresh_token_expires_in ?? null,
  };
}

export function exchangeCodeForToken(
  http: HttpClient,
  p: { shop: string; apiKey: string; apiSecret: string; code: string },
): Promise<ShopifyTokenGrant> {
  return requestToken(http, {
    shop: p.shop,
    form: { client_id: p.apiKey, client_secret: p.apiSecret, code: p.code, expiring: '1' },
    authMessage: 'Shopify rejected the app credentials',
    rejectedMessage: 'Shopify rejected the authorization code',
    requireExpiring: false,
  });
}
```

Create `packages/connectors/src/shopify/credentials.ts`:

```ts
// The shape of the encrypted Shopify credentials blob (AAD `connection:<id>`). Old connections store only
// { accessToken }; those never expire and are never refreshed.
import { z } from 'zod';
import { AuthError } from '../errors';
import type { ShopifyTokenGrant } from './token';

export interface StoredShopifyCredentials {
  accessToken: string;
  accessTokenExpiresAt?: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
}

export interface ExpiringCredentials {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

const atSeconds = (now: Date, seconds: number): string =>
  new Date(now.getTime() + seconds * 1000).toISOString();

/** What to encrypt after an exchange or a refresh. Without all three expiry fields the token is stored as non-expiring. */
export function credentialsFromGrant(grant: ShopifyTokenGrant, now: Date): StoredShopifyCredentials {
  if (
    grant.accessTokenExpiresInSec === null ||
    grant.refreshToken === null ||
    grant.refreshTokenExpiresInSec === null
  ) {
    return { accessToken: grant.accessToken };
  }
  return {
    accessToken: grant.accessToken,
    accessTokenExpiresAt: atSeconds(now, grant.accessTokenExpiresInSec),
    refreshToken: grant.refreshToken,
    refreshTokenExpiresAt: atSeconds(now, grant.refreshTokenExpiresInSec),
  };
}

/** The two non-secret times that are mirrored into plain columns so SQL can find aging tokens. */
export function credentialExpiry(c: StoredShopifyCredentials): {
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
} {
  return {
    accessTokenExpiresAt: c.accessTokenExpiresAt ? new Date(c.accessTokenExpiresAt) : null,
    refreshTokenExpiresAt: c.refreshTokenExpiresAt ? new Date(c.refreshTokenExpiresAt) : null,
  };
}

const expiringSchema = z.object({
  accessToken: z.string().min(1),
  accessTokenExpiresAt: z.string().datetime(),
  refreshToken: z.string().min(1),
  refreshTokenExpiresAt: z.string().datetime(),
});
const MARKERS = ['accessTokenExpiresAt', 'refreshToken', 'refreshTokenExpiresAt'] as const;

/**
 * An expiring token set, or null when the value is not one (the old `{ accessToken }` shape, another
 * platform's blob, null). A set that is only partly there is corrupt: AuthError with a FIXED message
 * (never the values).
 */
export function readExpiringCredentials(raw: unknown): ExpiringCredentials | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!MARKERS.some((k) => k in record)) return null;
  const parsed = expiringSchema.safeParse(record);
  if (!parsed.success) throw new AuthError('Stored credentials are unusable. Reconnect the store.');
  return {
    accessToken: parsed.data.accessToken,
    accessTokenExpiresAt: new Date(parsed.data.accessTokenExpiresAt),
    refreshToken: parsed.data.refreshToken,
    refreshTokenExpiresAt: new Date(parsed.data.refreshTokenExpiresAt),
  };
}
```

Add to `packages/connectors/src/shopify/index.ts` the line `export * from './credentials';` (after `export * from './token';`).

In `packages/connectors/src/testing/fake-shopify.ts` add the refresh-token field and the expiring exchange. Add a field and constructor option, and clear it in `reset()`:

```ts
  private readonly refreshToken: string;
  /** Refresh tokens Shopify would still accept (each one is single use). */
  private readonly validRefresh = new Set<string>();
  // constructor opts: { token?: string; refreshToken?: string; scope?: string; codes?: Set<string> }
  // in the constructor body:   this.refreshToken = opts.refreshToken ?? 'shprt_fake_refresh';
  // in reset():                this.validRefresh.clear();
```
and replace the `/admin/oauth/access_token` branch of `request()` with:

```ts
    if (url.pathname === '/admin/oauth/access_token') {
      const form = new URLSearchParams(req.body ?? '');
      const code = form.get('code');
      if (!code || !this.codes.has(code)) {
        return { status: 400, headers: {}, body: '{"error":"invalid_request"}' };
      }
      const body: Record<string, unknown> = { access_token: this.token, scope: this.scope };
      // Shopify only issues an expiring token (and a refresh token) when the exchange asks for it.
      if (form.get('expiring') === '1') {
        body.expires_in = 3600;
        body.refresh_token = this.refreshToken;
        body.refresh_token_expires_in = 7_776_000;
        this.validRefresh.add(this.refreshToken);
      }
      return { status: 200, headers: {}, body: JSON.stringify(body) };
    }
```

- [ ] **Step 4: Implement the schema, the migration and the install**

In `packages/db/src/schema/connections.ts`, inside `storeConnections` after `lastSyncedAt`:

```ts
    /** Non-secret mirror of the expiry times inside the encrypted credentials, so SQL can find aging tokens. */
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
```

Generate the migration (never hand-edit generated SQL):

```bash
cd "C:/Users/OK COMPUTER/Desktop/WorkAgentic/eRetailQuery/packages/db" && pnpm exec drizzle-kit generate --name=token_expiry
```
Expected: `migrations/0022_token_expiry.sql` containing two `ALTER TABLE "store_connections" ADD COLUMN ... timestamp with time zone` statements, `migrations/meta/0022_snapshot.json`, and a journal entry with tag `0022_token_expiry`.

In `apps/api/src/connections/connections.service.ts` `completeInstall`: import `credentialExpiry`, `credentialsFromGrant` and `type ShopifyTokenGrant` from `@erq/connectors`; change `let token: { accessToken: string; scopes: string[] };` to `let token: ShopifyTokenGrant;`; compute `const stored = credentialsFromGrant(token, new Date()); const expiry = credentialExpiry(stored);` right after the exchange succeeds (before `const { orgId } = consumed;`); and replace the credentials update:

```ts
          await tx
            .update(storeConnections)
            .set({
              encryptedCredentials: encryptConnectionCredentials(stored, keyProvider, row.id),
              accessTokenExpiresAt: expiry.accessTokenExpiresAt,
              refreshTokenExpiresAt: expiry.refreshTokenExpiresAt,
            })
            .where(and(eq(storeConnections.orgId, orgId), eq(storeConnections.id, row.id)));
```
(`registerWebhooks` still receives `token.accessToken`; the audit row still records only `{ platform, shop }`.)

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd "C:/Users/OK COMPUTER/Desktop/WorkAgentic/eRetailQuery" && pnpm turbo run build --filter=@erq/db --filter=@erq/connectors --filter=@erq/shared --filter=@erq/sync --concurrency=1
pnpm --filter @erq/connectors exec vitest run test/shopify-token.test.ts test/shopify-credentials.test.ts
pnpm --filter @erq/db exec vitest run test/token-expiry-columns.test.ts
pnpm --filter @erq/api exec vitest run test/connections.test.ts
pnpm --filter @erq/connectors typecheck && pnpm --filter @erq/api typecheck
```
Expected: PASS everywhere. Then check no leftover `postgres` process and no `%TEMP%\erq-pg-*` folder.

- [ ] **Step 6: Commit**

```bash
git add packages/connectors packages/db apps/api/src/connections/connections.service.ts apps/api/test/connections.test.ts
git commit -m "feat(shopify): request expiring offline tokens and store the refresh token set

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Token refresh in the connector

**Files:**
- Modify: `packages/connectors/src/shopify/token.ts` (append), `packages/connectors/src/sanitize.ts`, `packages/connectors/src/testing/fake-shopify.ts`
- Test: `packages/connectors/test/shopify-token-refresh.test.ts` (create), `packages/connectors/test/sanitize.test.ts` (add one)

**Interfaces:**
- Consumes (Task 1): `requestToken` (module private), `SHOPIFY_RECONNECT_MESSAGE`, `ShopifyRefreshGrant`.
- Produces:
  - `refreshAccessToken(http: HttpClient, p: { shop: string; apiKey: string; apiSecret: string; refreshToken: string }): Promise<ShopifyRefreshGrant>` (exported from `@erq/connectors`). Errors: `401`/`403` becomes `AuthError(SHOPIFY_RECONNECT_MESSAGE)` (final); `429` becomes `RateLimitedError`; `5xx` and network errors `TransientError`; any other status or an unreadable or incomplete body `PermanentError` with a fixed message; an invalid shop `PermanentError('Invalid shop domain')` before any request.
  - `FakeShopify` (from `@erq/connectors/testing`): handles `grant_type=refresh_token` with rotation (a presented refresh token is valid exactly once; the answer carries `${token}_${n}` and `${refreshToken}_${n}`); `acceptRefreshToken(token: string): void`; `presentedRefreshTokens: string[]`.

- [ ] **Step 1: Write the failing tests**

Create `packages/connectors/test/shopify-token-refresh.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  AuthError,
  PermanentError,
  RateLimitedError,
  SHOPIFY_RECONNECT_MESSAGE,
  TransientError,
  refreshAccessToken,
} from '../src';
import { FakeShopify } from '../src/testing';

const p = {
  shop: 'a.myshopify.com',
  apiKey: 'k',
  apiSecret: 's3cret',
  refreshToken: 'shprt_seed_token',
};
const fakeWithSeed = () => {
  const http = new FakeShopify({ token: 'shpat_abc', refreshToken: 'shprt_abc' });
  http.acceptRefreshToken(p.refreshToken);
  return http;
};

describe('refreshAccessToken', () => {
  it('sends the documented request and returns the rotated pair', async () => {
    const http = fakeWithSeed();
    await expect(refreshAccessToken(http, p)).resolves.toEqual({
      accessToken: 'shpat_abc_1',
      accessTokenExpiresInSec: 3600,
      refreshToken: 'shprt_abc_1',
      refreshTokenExpiresInSec: 7776000,
      scopes: ['read_orders', 'read_products'],
    });
    const req = http.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://a.myshopify.com/admin/oauth/access_token');
    expect(req.headers?.['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(req.body!))).toEqual({
      client_id: 'k',
      client_secret: 's3cret',
      grant_type: 'refresh_token',
      refresh_token: 'shprt_seed_token',
    });
  });
  it('rotates: the old refresh token is dead after one use, the new one works once', async () => {
    const http = fakeWithSeed();
    const first = await refreshAccessToken(http, p);
    await expect(refreshAccessToken(http, p)).rejects.toMatchObject({
      name: 'AuthError',
      message: SHOPIFY_RECONNECT_MESSAGE,
    });
    const second = await refreshAccessToken(http, { ...p, refreshToken: first.refreshToken });
    expect(second.refreshToken).toBe('shprt_abc_2');
    expect(http.presentedRefreshTokens).toEqual([
      'shprt_seed_token',
      'shprt_seed_token',
      'shprt_abc_1',
    ]);
  });
  it('treats a 401 as final with the fixed reconnect text, and a 403 the same', async () => {
    for (const status of [401, 403]) {
      const http = fakeWithSeed();
      http.failNext(status);
      await expect(refreshAccessToken(http, p)).rejects.toMatchObject({
        name: 'AuthError',
        message: 'Shopify no longer accepts this connection. Reconnect the store.',
      });
    }
  });
  it('maps retryable failures and honours retry-after', async () => {
    const cases: [number, new (...a: never[]) => Error][] = [
      [429, RateLimitedError],
      [500, TransientError],
      [503, TransientError],
      [400, PermanentError],
      [404, PermanentError],
    ];
    for (const [status, type] of cases) {
      const http = fakeWithSeed();
      http.failNext(status);
      await expect(refreshAccessToken(http, p)).rejects.toBeInstanceOf(type);
    }
    const http = fakeWithSeed();
    http.failNext(429, { 'retry-after': '3' });
    await expect(refreshAccessToken(http, p)).rejects.toMatchObject({ retryAfterMs: 3000 });
  });
  it('a transient failure consumes nothing: the SAME refresh token still works afterwards', async () => {
    const http = fakeWithSeed();
    http.failNext(503);
    await expect(refreshAccessToken(http, p)).rejects.toBeInstanceOf(TransientError);
    await expect(refreshAccessToken(http, p)).resolves.toMatchObject({ refreshToken: 'shprt_abc_1' });
    expect(http.presentedRefreshTokens).toEqual(['shprt_seed_token']);
  });
  it.each([
    ['not JSON', 'oops'],
    ['no refresh token', JSON.stringify({ access_token: 'shpat_x', scope: '', expires_in: 3600 })],
    ['a non-expiring answer', JSON.stringify({ access_token: 'shpat_x', scope: '' })],
  ])('rejects an unreadable or incomplete answer (%s) with a fixed message', async (_name, body) => {
    const http = fakeWithSeed();
    http.respondNext({ status: 200, body });
    await expect(refreshAccessToken(http, p)).rejects.toMatchObject({
      name: 'PermanentError',
      message: 'Shopify returned an unreadable token response',
    });
  });
  it('rejects an invalid shop before any request', async () => {
    const http = fakeWithSeed();
    await expect(refreshAccessToken(http, { ...p, shop: 'evil.com' })).rejects.toBeInstanceOf(PermanentError);
    expect(http.requests).toHaveLength(0);
  });
  it('never puts the secret or any token in an error message', async () => {
    for (const status of [400, 401, 403, 429, 500, 503]) {
      const http = fakeWithSeed();
      http.failNext(status);
      const err = (await refreshAccessToken(http, p).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      for (const secret of ['s3cret', 'shprt_seed_token', 'shpat_abc', 'shprt_abc']) {
        expect(err.message).not.toContain(secret);
      }
    }
    const rotated = fakeWithSeed();
    await refreshAccessToken(rotated, p);
    const err = (await refreshAccessToken(rotated, p).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(AuthError);
    for (const secret of ['s3cret', 'shprt_seed_token', 'shprt_abc_1', 'shpat_abc_1']) {
      expect(err.message).not.toContain(secret);
    }
  });
});
```

Add to `packages/connectors/test/sanitize.test.ts`:

```ts
  it('redacts refresh tokens by prefix and by key, using the real values', () => {
    const short = 'shprt_0123456789abcdef'; // too short for the long-token rule: only the prefix rule can catch it
    const out = sanitizeMessage(
      `refresh failed ${short} refresh_token=plainvalue1 {"refresh_token":"jsonvalue2"} refresh_token: colon3`,
    );
    for (const secret of [short, 'plainvalue1', 'jsonvalue2', 'colon3']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('[redacted]');
  });
```

- [ ] **Step 2: Run to see the failures**

Run: `pnpm --filter @erq/connectors exec vitest run test/shopify-token-refresh.test.ts test/sanitize.test.ts`
Expected: FAIL (`refreshAccessToken` and `acceptRefreshToken` do not exist; the sanitize case leaks `shprt_...`).

- [ ] **Step 3: Implement**

Append to `packages/connectors/src/shopify/token.ts`:

```ts
/**
 * Exchanges a refresh token for a NEW access token AND a NEW refresh token (rotation): the presented
 * refresh token is dead afterwards, so the caller must persist the returned pair atomically and must
 * never call this twice with the same token (packages/sync/src/tokens.ts does it under a row lock).
 * A 401 is final (unknown, replaced, expired, revoked or uninstalled all look the same); network
 * errors, timeouts, 5xx and 429 are retryable with the SAME refresh token because Shopify never
 * consumed it.
 */
export async function refreshAccessToken(
  http: HttpClient,
  p: { shop: string; apiKey: string; apiSecret: string; refreshToken: string },
): Promise<ShopifyRefreshGrant> {
  const grant = await requestToken(http, {
    shop: p.shop,
    form: {
      client_id: p.apiKey,
      client_secret: p.apiSecret,
      grant_type: 'refresh_token',
      refresh_token: p.refreshToken,
    },
    authMessage: SHOPIFY_RECONNECT_MESSAGE,
    rejectedMessage: 'Shopify rejected the refresh request',
    requireExpiring: true,
  });
  // requireExpiring guarantees the three fields; checking narrows the type without a cast.
  if (
    grant.accessTokenExpiresInSec === null ||
    grant.refreshToken === null ||
    grant.refreshTokenExpiresInSec === null
  ) {
    throw new PermanentError(UNREADABLE);
  }
  return {
    ...grant,
    accessTokenExpiresInSec: grant.accessTokenExpiresInSec,
    refreshToken: grant.refreshToken,
    refreshTokenExpiresInSec: grant.refreshTokenExpiresInSec,
  };
}
```

In `packages/connectors/src/sanitize.ts` change the two patterns:

```ts
    .replace(/\bshp(?:at|ca|ss|pa|rt)_[A-Za-z0-9]+/gi, '[redacted]')
```
and add `refresh_token` to the key alternation: `\b(access_token|refresh_token|client_secret|api_secret|secret|token|password|hmac|code)["']?\s*[=:]\s*...` (leave the rest of the expression as is).

In `packages/connectors/src/testing/fake-shopify.ts` add the rotation (fields, `reset()` clearing, and a branch before the code check):

```ts
  /** Every refresh token a client presented, in order (also the ones Shopify refused). */
  readonly presentedRefreshTokens: string[] = [];
  private refreshGeneration = 0;

  /** Makes `token` a refresh token Shopify accepts once, as if an earlier exchange had issued it. */
  acceptRefreshToken(token: string): void {
    this.validRefresh.add(token);
  }

  private refresh(form: URLSearchParams): HttpResponse {
    const presented = form.get('refresh_token') ?? '';
    this.presentedRefreshTokens.push(presented);
    // Single use: a token that was already replaced (or never issued) is refused for good.
    if (!this.validRefresh.delete(presented)) {
      return { status: 401, headers: {}, body: '{"error":"invalid_request"}' };
    }
    this.refreshGeneration += 1;
    const n = this.refreshGeneration;
    const nextRefresh = `${this.refreshToken}_${n}`;
    this.validRefresh.add(nextRefresh);
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({
        access_token: `${this.token}_${n}`,
        scope: this.scope,
        expires_in: 3600,
        refresh_token: nextRefresh,
        refresh_token_expires_in: 7_776_000,
      }),
    };
  }
```
In `reset()` add `this.presentedRefreshTokens.length = 0; this.refreshGeneration = 0;` and in the `/admin/oauth/access_token` branch, right after `const form = ...`: `if (form.get('grant_type') === 'refresh_token') return this.refresh(form);`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @erq/connectors exec vitest run test/shopify-token-refresh.test.ts test/sanitize.test.ts test/shopify-token.test.ts
pnpm --filter @erq/connectors typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors
git commit -m "feat(shopify): refresh expiring access tokens with rotation

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: TokenService with the row lock, engine and worker wiring

**Files:**
- Create: `packages/sync/src/tokens.ts`, `apps/worker/src/sync/tokens.ts`
- Modify: `packages/sync/src/engine/deps.ts`, `packages/sync/src/engine/process.ts`, `packages/sync/src/index.ts`, `apps/worker/src/main.ts`
- Test: `packages/sync/test/tokens.test.ts` (create), `packages/sync/test/engine.test.ts` (add a `describe`), `apps/worker/test/worker-tokens.test.ts` (create)

**Interfaces:**
- Consumes (Tasks 1, 2): `readExpiringCredentials`, `credentialsFromGrant`, `credentialExpiry`, `ShopifyRefreshGrant`, `SHOPIFY_RECONNECT_MESSAGE`, `refreshAccessToken`, `decryptConnectionCredentials`, `encryptConnectionCredentials`, `storeConnections.accessTokenExpiresAt/refreshTokenExpiresAt`.
- Produces (`@erq/sync`):
  - `REFRESH_WINDOW_MS = 5 * 60_000`, `IDLE_REFRESH_WINDOW_MS = 14 * 24 * 60 * 60_000`
  - `interface TokenService { ensureFresh(args: { orgId: string; connectionId: string }): Promise<unknown> }` (returns the credentials to hand the connector: `{ accessToken }` for an expiring set, the raw decrypted blob for anything else, `null` for a connection without credentials)
  - `type RefreshFn = (args: { shop: string; refreshToken: string }) => Promise<ShopifyRefreshGrant>`
  - `createTokenService(deps: { db: Pick<TenantDb, 'withTenant'>; keyProvider: KeyProvider; refresh?: RefreshFn; now?: () => Date }): TokenService`
  - `SyncDeps.tokens?: TokenService`
- Produces (worker): `workerRefreshFn(env: NodeJS.ProcessEnv, http?: HttpClient): RefreshFn | undefined` and `createWorkerTokenService(env, db, keyProvider, http?): TokenService` in `apps/worker/src/sync/tokens.ts`.

Behaviour of `ensureFresh`: (1) unlocked read; (2) not an expiring set, or the access token has MORE than `REFRESH_WINDOW_MS` left: return without a lock and without a call; (3) otherwise `withTenant` + `SELECT ... FOR UPDATE` on the connection row, re-read and re-decrypt (a concurrent caller may have rotated), re-check, then refuse when the refresh token is already expired (`AuthError(SHOPIFY_RECONNECT_MESSAGE)`, no call), then call `refresh`, then write the encrypted pair and both expiry columns in the SAME transaction. The lock is held across the Shopify call (bounded by the 10 s HTTP timeout) on purpose: it is what serialises rotation. It takes only the connection row lock, never a cursor lock. A thrown error rolls the transaction back, so nothing is half written.

- [ ] **Step 1: Write the failing tests**

Create `packages/sync/test/tokens.test.ts`:

```ts
import { randomBytes } from 'node:crypto';
import {
  AuthError,
  PermanentError,
  SHOPIFY_RECONNECT_MESSAGE,
  TransientError,
  decryptConnectionCredentials,
  encryptConnectionCredentials,
  type ShopifyRefreshGrant,
} from '@erq/connectors';
import { EnvKeyProvider } from '@erq/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REFRESH_WINDOW_MS, createTokenService, type RefreshFn } from '../src/tokens';
import { CONN_A, ORG_A, ORG_B, startEnv, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env?.stop();
});

const NOW = new Date('2026-10-08T12:00:00.000Z');
const DAY = 86_400_000;
const keyProvider = new EnvKeyProvider('k1', { k1: randomBytes(32).toString('base64') });

async function seed(opts: { accessInMs: number; refreshInMs?: number; refreshToken?: string }) {
  const creds = {
    accessToken: 'shpat_seed',
    accessTokenExpiresAt: new Date(NOW.getTime() + opts.accessInMs).toISOString(),
    refreshToken: opts.refreshToken ?? 'shprt_seed',
    refreshTokenExpiresAt: new Date(NOW.getTime() + (opts.refreshInMs ?? 80 * DAY)).toISOString(),
  };
  await env.owner.query(
    `update store_connections set encrypted_credentials = $2, access_token_expires_at = $3,
       refresh_token_expires_at = $4, status = 'active', last_error = null where id = $1`,
    [
      CONN_A,
      encryptConnectionCredentials(creds, keyProvider, CONN_A),
      creds.accessTokenExpiresAt,
      creds.refreshTokenExpiresAt,
    ],
  );
}
async function stored() {
  const { rows } = await env.owner.query(
    `select encrypted_credentials, access_token_expires_at, refresh_token_expires_at, status, last_error
       from store_connections where id = $1`,
    [CONN_A],
  );
  return {
    ...rows[0],
    creds: decryptConnectionCredentials(rows[0].encrypted_credentials, keyProvider, CONN_A) as Record<string, string>,
  };
}
const grant = (n: number): ShopifyRefreshGrant => ({
  accessToken: `shpat_gen${n}`,
  scopes: [],
  accessTokenExpiresInSec: 3600,
  refreshToken: `shprt_gen${n}`,
  refreshTokenExpiresInSec: 7_776_000,
});
/** Shopify's rotation: a refresh token works exactly once. */
function rotating(delayMs = 0) {
  const calls: string[] = [];
  let generation = 0;
  const valid = new Set(['shprt_seed']);
  const fn: RefreshFn = async ({ refreshToken }) => {
    calls.push(refreshToken);
    await new Promise((r) => setTimeout(r, delayMs));
    if (!valid.delete(refreshToken)) throw new AuthError(SHOPIFY_RECONNECT_MESSAGE);
    generation += 1;
    valid.add(`shprt_gen${generation}`);
    return grant(generation);
  };
  return { fn, calls };
}
const service = (refresh?: RefreshFn) =>
  createTokenService({ db: env.db, keyProvider, refresh, now: () => NOW });
const args = { orgId: ORG_A, connectionId: CONN_A };

beforeEach(() => seed({ accessInMs: 60_000 }));

describe('createTokenService.ensureFresh', () => {
  it('does not refresh (or lock) when the access token has more than five minutes left', async () => {
    await seed({ accessInMs: REFRESH_WINDOW_MS + 1000 });
    const { fn, calls } = rotating();
    await expect(service(fn).ensureFresh(args)).resolves.toEqual({ accessToken: 'shpat_seed' });
    expect(calls).toEqual([]);
  });
  it('refreshes at exactly five minutes left and returns only the access token', async () => {
    await seed({ accessInMs: REFRESH_WINDOW_MS });
    const { fn, calls } = rotating();
    const result = await service(fn).ensureFresh(args);
    expect(result).toEqual({ accessToken: 'shpat_gen1' }); // no refreshToken key at all
    expect(calls).toEqual(['shprt_seed']);
    const row = await stored();
    expect(row.creds).toEqual({
      accessToken: 'shpat_gen1',
      accessTokenExpiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
      refreshToken: 'shprt_gen1',
      refreshTokenExpiresAt: new Date(NOW.getTime() + 7_776_000_000).toISOString(),
    });
    expect(row.access_token_expires_at.toISOString()).toBe(row.creds.accessTokenExpiresAt);
    expect(row.refresh_token_expires_at.toISOString()).toBe(row.creds.refreshTokenExpiresAt);
  });
  it('refreshes an already expired access token', async () => {
    await seed({ accessInMs: -10 * 60_000 });
    const { fn } = rotating();
    await expect(service(fn).ensureFresh(args)).resolves.toEqual({ accessToken: 'shpat_gen1' });
  });
  it('serialises concurrent callers: ONE Shopify call, everyone gets the rotated token', async () => {
    const { fn, calls } = rotating(80);
    const svc = service(fn);
    const results = await Promise.all([1, 2, 3].map(() => svc.ensureFresh(args)));
    expect(calls).toEqual(['shprt_seed']); // a second call with the dead token would have thrown
    expect(results).toEqual([
      { accessToken: 'shpat_gen1' },
      { accessToken: 'shpat_gen1' },
      { accessToken: 'shpat_gen1' },
    ]);
    expect((await stored()).creds.refreshToken).toBe('shprt_gen1');
  });
  it('holds the connection row lock while it refreshes, and commits the new pair when it lets go', async () => {
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const refresh: RefreshFn = async () => {
      entered();
      await gate;
      return grant(1);
    };
    const pending = service(refresh).ensureFresh(args);
    await inside;
    const c = await env.owner.connect();
    try {
      await c.query('begin');
      await expect(
        c.query('select id from store_connections where id = $1 for update nowait', [CONN_A]),
      ).rejects.toMatchObject({ code: '55P03' }); // lock_not_available
      await c.query('rollback');
    } finally {
      c.release();
    }
    expect((await stored()).creds.refreshToken).toBe('shprt_seed'); // nothing visible before commit
    release();
    await expect(pending).resolves.toEqual({ accessToken: 'shpat_gen1' });
    expect((await stored()).creds.refreshToken).toBe('shprt_gen1');
  });
  it('a transient failure leaves the stored pair untouched, and the retry uses the SAME refresh token', async () => {
    const calls: string[] = [];
    let failures = 1;
    const refresh: RefreshFn = async ({ refreshToken }) => {
      calls.push(refreshToken);
      if (failures-- > 0) throw new TransientError('Shopify is temporarily unavailable');
      return grant(1);
    };
    const svc = service(refresh);
    await expect(svc.ensureFresh(args)).rejects.toBeInstanceOf(TransientError);
    expect((await stored()).creds.refreshToken).toBe('shprt_seed');
    await expect(svc.ensureFresh(args)).resolves.toEqual({ accessToken: 'shpat_gen1' });
    expect(calls).toEqual(['shprt_seed', 'shprt_seed']);
  });
  it('a final refusal throws the fixed reconnect text and changes nothing', async () => {
    const refresh: RefreshFn = async () => {
      throw new AuthError(SHOPIFY_RECONNECT_MESSAGE);
    };
    const err = (await service(refresh).ensureFresh(args).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).toBe('Shopify no longer accepts this connection. Reconnect the store.');
    for (const secret of ['shprt_seed', 'shpat_seed']) expect(err.message).not.toContain(secret);
    expect((await stored()).creds.refreshToken).toBe('shprt_seed');
  });
  it('does not call Shopify when the refresh token itself has expired', async () => {
    await seed({ accessInMs: -1000, refreshInMs: -1000 });
    const { fn, calls } = rotating();
    await expect(service(fn).ensureFresh(args)).rejects.toMatchObject({
      name: 'AuthError',
      message: SHOPIFY_RECONNECT_MESSAGE,
    });
    expect(calls).toEqual([]);
  });
  it('never refreshes the old shape, whatever the clock says', async () => {
    await env.owner.query(
      `update store_connections set encrypted_credentials = $2, access_token_expires_at = null, refresh_token_expires_at = null where id = $1`,
      [CONN_A, encryptConnectionCredentials({ accessToken: 'shpat_old' }, keyProvider, CONN_A)],
    );
    const { fn, calls } = rotating();
    await expect(service(fn).ensureFresh(args)).resolves.toEqual({ accessToken: 'shpat_old' });
    expect(calls).toEqual([]);
  });
  it('returns null for a connection without credentials and fails closed when refreshing is not configured', async () => {
    await expect(service(undefined).ensureFresh(args)).rejects.toMatchObject({
      name: 'PermanentError',
      message: 'Token refresh is not configured on this server.',
    });
    await env.owner.query(`update store_connections set encrypted_credentials = null where id = $1`, [CONN_A]);
    await expect(service(undefined).ensureFresh(args)).resolves.toBeNull();
  });
  it("cannot reach another org's connection", async () => {
    await expect(service(rotating().fn).ensureFresh({ orgId: ORG_B, connectionId: CONN_A })).rejects.toBeInstanceOf(
      PermanentError,
    );
    expect((await stored()).creds.refreshToken).toBe('shprt_seed');
  });
});
```

Add to `packages/sync/test/engine.test.ts` (imports: `createTokenService` from `'../src/tokens'`, `SHOPIFY_RECONNECT_MESSAGE` and `type ShopifyRefreshGrant` from `'@erq/connectors'`, `afterEach` from vitest):

```ts
describe('token refresh in the engine', () => {
  const NOWMS = Date.parse('2026-10-06T12:00:00Z');
  const SEED_RT = 'shprt_seed_0123456789';
  const seedExpiring = (h: ReturnType<typeof makeHarness>, accessInMs: number) =>
    env.owner.query(
      `update store_connections set encrypted_credentials = $1, status = 'active', last_error = null where id = $2`,
      [
        encryptConnectionCredentials(
          {
            accessToken: 'shpat_old_0123456789',
            accessTokenExpiresAt: new Date(NOWMS + accessInMs).toISOString(),
            refreshToken: SEED_RT,
            refreshTokenExpiresAt: new Date(NOWMS + 80 * 86_400_000).toISOString(),
          },
          h.keyProvider,
          CONN_A,
        ),
        CONN_A,
      ],
    );
  const grant: ShopifyRefreshGrant = {
    accessToken: 'shpat_new_0123456789',
    scopes: [],
    accessTokenExpiresInSec: 3600,
    refreshToken: 'shprt_new_0123456789',
    refreshTokenExpiresInSec: 7_776_000,
  };
  const row = async () =>
    (await env.owner.query(`select status, last_error, encrypted_credentials from store_connections where id = $1`, [CONN_A])).rows[0];
  afterEach(() =>
    env.owner.query(`update store_connections set encrypted_credentials = null, status = 'active', last_error = null where id = $1`, [CONN_A]),
  );

  it('refreshes before the fetch, hands the connector ONLY the access token, and keeps every token out of job and run', async () => {
    const h = makeHarness(env);
    await seedExpiring(h, 60_000);
    const presented: string[] = [];
    h.deps.tokens = createTokenService({
      db: env.db,
      keyProvider: h.keyProvider,
      now: h.clock.now,
      refresh: async ({ refreshToken }) => {
        presented.push(refreshToken);
        return grant;
      },
    });
    const job = await start(h, 'locations');
    expect(await processSyncPage(h.deps, job)).toEqual({ kind: 'done' });
    expect(presented).toEqual([SEED_RT]);
    expect(h.connector.calls[0]!.credentials).toEqual({ accessToken: 'shpat_new_0123456789' });
    const visible = JSON.stringify([job, await runRow(job.syncRunId), await cursorRow('locations')]);
    for (const secret of ['shpat_new_0123456789', 'shprt_new_0123456789', SEED_RT, 'shpat_old_0123456789']) {
      expect(visible).not.toContain(secret);
    }
  });
  it('does not refresh a token that is far from expiry', async () => {
    const h = makeHarness(env);
    await seedExpiring(h, 3_600_000);
    let called = 0;
    h.deps.tokens = createTokenService({
      db: env.db, keyProvider: h.keyProvider, now: h.clock.now,
      refresh: async () => { called += 1; return grant; },
    });
    await processSyncPage(h.deps, await start(h, 'locations'));
    expect(called).toBe(0);
    expect(h.connector.calls[0]!.credentials).toEqual({ accessToken: 'shpat_old_0123456789' });
  });
  it('a final refresh failure errors the connection with the fixed reconnect text, fails the run and sends no further job', async () => {
    const h = makeHarness(env);
    await seedExpiring(h, 60_000);
    h.deps.tokens = createTokenService({
      db: env.db, keyProvider: h.keyProvider, now: h.clock.now,
      refresh: async () => { throw new AuthError(SHOPIFY_RECONNECT_MESSAGE); },
    });
    await enqueueSync(h.deps, { orgId: ORG_A, connectionId: CONN_A, resources: 'all', mode: 'backfill', since });
    const first = h.queue.take()!.job;
    expect(await processSyncPage(h.deps, first)).toEqual({ kind: 'failed', reason: SHOPIFY_RECONNECT_MESSAGE });
    const c = await row();
    expect([c.status, c.last_error]).toEqual(['error', SHOPIFY_RECONNECT_MESSAGE]);
    expect((await cursorRow('locations')).status).toBe('failed');
    expect(h.queue.size).toBe(0);
    expect(JSON.stringify(c)).not.toContain(SEED_RT);
  });
  it('rethrows a transient refresh failure for the queue to retry, leaving the run and the stored pair alone', async () => {
    const h = makeHarness(env);
    await seedExpiring(h, 60_000);
    const before = (await row()).encrypted_credentials;
    h.deps.tokens = createTokenService({
      db: env.db, keyProvider: h.keyProvider, now: h.clock.now,
      refresh: async () => { throw new TransientError('Shopify is temporarily unavailable'); },
    });
    const job = await start(h, 'locations');
    await expect(processSyncPage(h.deps, job)).rejects.toBeInstanceOf(TransientError);
    expect((await cursorRow('locations')).status).toBe('running');
    expect((await row()).encrypted_credentials).toBe(before);
  });
  it('turns a rate-limited refresh into a delayed job', async () => {
    const h = makeHarness(env);
    await seedExpiring(h, 60_000);
    h.deps.tokens = createTokenService({
      db: env.db, keyProvider: h.keyProvider, now: h.clock.now,
      refresh: async () => { throw new RateLimitedError(3000); },
    });
    expect(await processSyncPage(h.deps, await start(h, 'locations'))).toEqual({ kind: 'delayed', delayMs: 3000 });
  });
  it('sanitizes a stored failure that carries a refresh token', async () => {
    const h = makeHarness(env);
    const job = await start(h, 'locations');
    await failSyncRun(h.deps, job, `refresh failed for ${SEED_RT} with client_secret=topsecretvalue`);
    const stored = JSON.stringify(await cursorRow('locations'));
    expect(stored).not.toContain(SEED_RT);
    expect(stored).not.toContain('topsecretvalue');
  });
});
```
(`afterEach` must be added to the vitest import in that file; `since`, `start`, `cursorRow`, `runRow` already exist there.)

Create `apps/worker/test/worker-tokens.test.ts`:

```ts
import { FakeShopify } from '@erq/connectors/testing';
import { describe, expect, it } from 'vitest';
import { workerRefreshFn } from '../src/sync/tokens';

describe('workerRefreshFn', () => {
  it('is undefined without the app key and secret (refresh is not configured)', () => {
    expect(workerRefreshFn({})).toBeUndefined();
    expect(workerRefreshFn({ SHOPIFY_API_KEY: 'k' })).toBeUndefined();
    expect(workerRefreshFn({ SHOPIFY_API_KEY: ' ', SHOPIFY_API_SECRET: 's' })).toBeUndefined();
  });
  it('refreshes with the app key and secret from the environment', async () => {
    const http = new FakeShopify({ refreshToken: 'shprt_w' });
    http.acceptRefreshToken('shprt_w_old');
    const refresh = workerRefreshFn({ SHOPIFY_API_KEY: 'k', SHOPIFY_API_SECRET: 's3cret' }, http)!;
    const grant = await refresh({ shop: 'a.myshopify.com', refreshToken: 'shprt_w_old' });
    expect(grant.refreshToken).toBe('shprt_w_1');
    expect(Object.fromEntries(new URLSearchParams(http.requests[0]!.body!))).toEqual({
      client_id: 'k',
      client_secret: 's3cret',
      grant_type: 'refresh_token',
      refresh_token: 'shprt_w_old',
    });
  });
});
```

- [ ] **Step 2: Run to see the failures**

Run: `pnpm --filter @erq/sync exec vitest run test/tokens.test.ts` and `pnpm --filter @erq/worker exec vitest run test/worker-tokens.test.ts`
Expected: FAIL (module `../src/tokens` / `../src/sync/tokens` not found).

- [ ] **Step 3: Implement the service**

Create `packages/sync/src/tokens.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import {
  AuthError,
  PermanentError,
  SHOPIFY_RECONNECT_MESSAGE,
  credentialExpiry,
  credentialsFromGrant,
  decryptConnectionCredentials,
  encryptConnectionCredentials,
  readExpiringCredentials,
  type ExpiringCredentials,
  type ShopifyRefreshGrant,
} from '@erq/connectors';
import { storeConnections, type TenantDb } from '@erq/db';
import type { KeyProvider } from '@erq/shared';

/** An access token with this much life left (or less) is refreshed before the next request. */
export const REFRESH_WINDOW_MS = 5 * 60_000;
/** The scheduler refreshes idle shops whose refresh token has this much life left (or less). */
export const IDLE_REFRESH_WINDOW_MS = 14 * 24 * 60 * 60_000;

export type RefreshFn = (args: { shop: string; refreshToken: string }) => Promise<ShopifyRefreshGrant>;

export interface TokenService {
  /**
   * The credentials to hand the connector for the next request, refreshed first when they are about to
   * expire. An expiring Shopify set returns `{ accessToken }` only (the refresh token never leaves this
   * module); any other stored value is returned as decrypted; a connection without credentials gives null.
   */
  ensureFresh(args: { orgId: string; connectionId: string }): Promise<unknown>;
}

export interface TokenServiceDeps {
  db: Pick<TenantDb, 'withTenant'>;
  keyProvider: KeyProvider;
  /** Absent means "cannot refresh": an expiring token that needs it fails with a PermanentError. */
  refresh?: RefreshFn;
  now?: () => Date;
}

const needsRefresh = (c: ExpiringCredentials, now: Date): boolean =>
  c.accessTokenExpiresAt.getTime() - now.getTime() <= REFRESH_WINDOW_MS;

/**
 * Rotation makes a refresh token single use, so two jobs must never refresh the same shop at once. The
 * refresh therefore runs inside one transaction that holds `SELECT ... FOR UPDATE` on the connection row:
 * a second caller blocks, then re-reads the (already rotated) credentials and does not call Shopify. The new
 * pair is written in that same transaction. The lock is held across the Shopify call on purpose (bounded by
 * the HTTP client's 10 s timeout). It takes the connection row lock ONLY, never a cursor lock, so it cannot
 * invert the cursor-then-connection order used by the engine.
 * Residual risk: if Shopify answered but the commit then fails, the old token is dead and the new one is lost;
 * the next call gets a final 401 and the shop must be reconnected (docs/sync.md).
 */
export function createTokenService(deps: TokenServiceDeps): TokenService {
  const now = (): Date => (deps.now ?? (() => new Date()))();
  const read = (encrypted: string | null, connectionId: string): unknown =>
    decryptConnectionCredentials(encrypted, deps.keyProvider, connectionId);
  return {
    async ensureFresh({ orgId, connectionId }) {
      const first = await deps.db.withTenant(orgId, async (tx) => {
        const [row] = await tx
          .select({ encrypted: storeConnections.encryptedCredentials })
          .from(storeConnections)
          .where(eq(storeConnections.id, connectionId));
        return row ?? null;
      });
      if (!first) throw new PermanentError('store connection not found');
      const raw = read(first.encrypted, connectionId);
      const expiring = readExpiringCredentials(raw);
      if (!expiring) return raw;
      if (!needsRefresh(expiring, now())) return { accessToken: expiring.accessToken };

      return deps.db.withTenant(orgId, async (tx) => {
        const [row] = await tx
          .select({
            encrypted: storeConnections.encryptedCredentials,
            shop: storeConnections.externalAccountId,
          })
          .from(storeConnections)
          .where(eq(storeConnections.id, connectionId))
          .for('update');
        if (!row) throw new PermanentError('store connection not found');
        // Re-read after the lock: another job may have rotated the pair while we waited.
        const locked = readExpiringCredentials(read(row.encrypted, connectionId));
        if (!locked) throw new AuthError('Stored credentials could not be read. Reconnect the store.');
        const at = now();
        if (!needsRefresh(locked, at)) return { accessToken: locked.accessToken };
        if (locked.refreshTokenExpiresAt.getTime() <= at.getTime()) {
          throw new AuthError(SHOPIFY_RECONNECT_MESSAGE);
        }
        if (!deps.refresh) throw new PermanentError('Token refresh is not configured on this server.');
        const grant = await deps.refresh({ shop: row.shop, refreshToken: locked.refreshToken });
        const next = credentialsFromGrant(grant, at);
        const expiry = credentialExpiry(next);
        await tx
          .update(storeConnections)
          .set({
            encryptedCredentials: encryptConnectionCredentials(next, deps.keyProvider, connectionId),
            accessTokenExpiresAt: expiry.accessTokenExpiresAt,
            refreshTokenExpiresAt: expiry.refreshTokenExpiresAt,
          })
          .where(and(eq(storeConnections.orgId, orgId), eq(storeConnections.id, connectionId)));
        return { accessToken: next.accessToken };
      });
    },
  };
}
```

In `packages/sync/src/engine/deps.ts` add `import type { TokenService } from '../tokens';` and the field in `SyncDeps`:

```ts
  /** Keeps expiring access tokens fresh. Optional: the engine builds a service without a refresh function when absent. */
  tokens?: TokenService;
```
In `packages/sync/src/index.ts` add `export * from './tokens';`.

In `packages/sync/src/engine/process.ts`: remove `decryptConnectionCredentials` from the `@erq/connectors` import; add `import { createTokenService } from '../tokens';`; at the top of `processSyncPage` add

```ts
  const tokens =
    deps.tokens ?? createTokenService({ db: deps.db, keyProvider: deps.keyProvider, now: deps.now });
```
remove `encryptedCredentials: storeConnections.encryptedCredentials,` from the first `select`, and replace the credentials block in the fetch `try`:

```ts
    const connector = deps.connectors.get(connection.platform);
    // Refreshes an expiring Shopify token first, under the connection row lock. The connector only ever
    // receives { accessToken }, and an AuthError or PermanentError here fails the run through the catch below.
    const credentials = await tokens.ensureFresh({
      orgId: job.orgId,
      connectionId: connection.id,
    });
```

- [ ] **Step 4: Implement the worker wiring**

Create `apps/worker/src/sync/tokens.ts`:

```ts
import { createFetchHttpClient, refreshAccessToken, type HttpClient } from '@erq/connectors';
import type { TenantDb } from '@erq/db';
import type { KeyProvider } from '@erq/shared';
import { createTokenService, type RefreshFn, type TokenService } from '@erq/sync';

/** The refresh function, or undefined when the app key and secret are not configured on this worker. */
export function workerRefreshFn(
  env: NodeJS.ProcessEnv,
  http: HttpClient = createFetchHttpClient(),
): RefreshFn | undefined {
  const apiKey = (env.SHOPIFY_API_KEY ?? '').trim();
  const apiSecret = (env.SHOPIFY_API_SECRET ?? '').trim();
  if (apiKey === '' || apiSecret === '') return undefined;
  return ({ shop, refreshToken }) =>
    refreshAccessToken(http, { shop, apiKey, apiSecret, refreshToken });
}

export function createWorkerTokenService(
  env: NodeJS.ProcessEnv,
  db: TenantDb,
  keyProvider: KeyProvider,
  http: HttpClient = createFetchHttpClient(),
): TokenService {
  return createTokenService({ db, keyProvider, refresh: workerRefreshFn(env, http) });
}
```
In `apps/worker/src/main.ts`: import `createWorkerTokenService`; build `const keyProvider = EnvKeyProvider.fromEnv(process.env);` once inside the `if (db && process.env.ENCRYPTION_KEY)` block and use it in `deps` (`keyProvider`, `tokens: createWorkerTokenService(process.env, db, keyProvider)`); and log once:

```ts
    if (!process.env.SHOPIFY_API_KEY || !process.env.SHOPIFY_API_SECRET) {
      log.warn('SHOPIFY_API_KEY or SHOPIFY_API_SECRET is missing: expiring Shopify tokens cannot be refreshed');
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd "C:/Users/OK COMPUTER/Desktop/WorkAgentic/eRetailQuery" && pnpm turbo run build --filter=@erq/db --filter=@erq/connectors --filter=@erq/shared --filter=@erq/sync --concurrency=1
pnpm --filter @erq/sync exec vitest run test/tokens.test.ts
pnpm --filter @erq/sync exec vitest run test/engine.test.ts
pnpm --filter @erq/worker exec vitest run test/worker-tokens.test.ts
pnpm --filter @erq/sync typecheck && pnpm --filter @erq/worker typecheck
```
Expected: PASS (existing engine tests still pass: the engine hands the connector `{ accessToken: 'shpat_x' }` exactly as before). Check for leftover `postgres` processes and `erq-pg-*` folders.

- [ ] **Step 6: Commit**

```bash
git add packages/sync apps/worker
git commit -m "feat(sync): refresh expiring tokens under the connection row lock

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---
## Part B: Scheduler

### Task 4: The `full` sync mode, `last_full_pass_at` and the oldest-resource connection time

Dependency note: the due logic (Task 5) needs a way to ask for a pass that reads everything, and the scheduler makes single-resource runs frequent, so the connection-level `last_synced_at` must stop meaning "some chain ended just now" before the ticker exists. Both belong to the engine, so they come first.

**Files:**
- Modify: `packages/sync/src/ports.ts`, `packages/sync/src/job-schema.ts`, `packages/sync/src/engine/start.ts`, `packages/sync/src/engine/process.ts`
- Modify: `packages/db/src/schema/orders.ts` (`syncCursors`); generated `packages/db/migrations/0023_cursor_full_pass.sql` and `migrations/meta/*`
- Test: `packages/sync/test/job-schema.test.ts` (add), `packages/sync/test/engine.test.ts` (add, and rewrite two tests), `packages/sync/test/shopify-engine-e2e.test.ts` (check two assertions)

**Interfaces:**
- Produces:
  - `type SyncMode = 'backfill' | 'incremental' | 'full'` (`@erq/sync`); `EnqueueSyncArgs.mode: SyncMode`; `SyncChain.mode: SyncMode`. A `full` run needs no `since`; its `sync_runs.type` is `'full'`.
  - `startRun` for mode `full` sets the cursor's `updated_since` to NULL (the connector then receives no change filter). On completion of a run whose type is `backfill` or `full`, the cursor's `last_full_pass_at` is set to `now`.
  - `syncCursors.lastFullPassAt` (`timestamptz`, nullable, column `last_full_pass_at`).
  - At a real chain end `store_connections.last_synced_at` becomes `coalesce(<oldest sync_cursors.last_synced_at of the connection when all four resources have one>, <its current value>)` instead of `now`.
- Consumes: existing `processSyncPage`, `startRun`, `enqueueSync`.

- [ ] **Step 1: Write the failing tests**

In `packages/sync/test/job-schema.test.ts` add (use the file's existing `base` job object):

```ts
  it('accepts a full chain without since and still rejects an unknown mode', () => {
    expect(
      parseSyncPageJob({ ...base, then: { resources: ['inventory'], mode: 'full', since: null } }).then,
    ).toEqual({ resources: ['inventory'], mode: 'full', since: null });
    expect(() =>
      parseSyncPageJob({ ...base, then: { resources: ['inventory'], mode: 'weekly', since: null } }),
    ).toThrow();
    expect(() =>
      parseSyncPageJob({ ...base, then: { resources: ['inventory'], mode: 'backfill', since: null } }),
    ).toThrow();
  });
```

In `packages/sync/test/engine.test.ts` add a helper next to `start` and a new `describe` (imports needed: `sampleData` is already imported; add `type SyncResource` from `@erq/connectors`):

```ts
const runMode = async (
  h: ReturnType<typeof makeHarness>,
  resources: SyncResource[],
  mode: 'backfill' | 'incremental' | 'full',
) => {
  await enqueueSync(h.deps, {
    orgId: ORG_A,
    connectionId: CONN_A,
    resources,
    mode,
    since: mode === 'backfill' ? since : undefined,
  });
  await drain(h);
};
const latestRun = async () =>
  (
    await env.owner.query(
      `select type from sync_runs where connection_id = $1 order by started_at desc limit 1`,
      [CONN_A],
    )
  ).rows[0];

describe('full passes', () => {
  it('a full run reads without a filter and stamps last_full_pass_at; an incremental run filters and does not', async () => {
    const h = makeHarness(env);
    await runMode(h, ['products'], 'backfill');
    expect((await cursorRow('products')).last_full_pass_at.toISOString()).toBe('2026-10-06T12:00:00.000Z');

    h.clock.advance(3_600_000);
    await runMode(h, ['products'], 'incremental');
    const incremental = h.connector.calls.at(-1)!;
    expect(incremental.options.updatedSince).toBeInstanceOf(Date);
    expect((await cursorRow('products')).last_full_pass_at.toISOString()).toBe('2026-10-06T12:00:00.000Z');

    h.clock.advance(3_600_000);
    const callsBefore = h.connector.calls.length;
    await runMode(h, ['products'], 'full');
    const fullCalls = h.connector.calls.slice(callsBefore);
    expect(fullCalls.length).toBeGreaterThan(0);
    for (const call of fullCalls) {
      expect(call.options.updatedSince).toBeUndefined();
      expect(call.options.since).toBeUndefined();
    }
    expect((await latestRun()).type).toBe('full');
    const cursor = await cursorRow('products');
    expect(cursor.last_full_pass_at.toISOString()).toBe('2026-10-06T14:00:00.000Z');
    expect(cursor.updated_since.toISOString()).toBe('2026-10-06T14:00:00.000Z'); // the watermark is back after the pass
  });
  it('a full run needs no since, and a backfill still does', async () => {
    const h = makeHarness(env);
    await expect(
      enqueueSync(h.deps, { orgId: ORG_A, connectionId: CONN_A, resources: ['products'], mode: 'full' }),
    ).resolves.toMatchObject({ resource: 'products', started: true });
    await resetSync(env);
    await expect(
      enqueueSync(h.deps, { orgId: ORG_A, connectionId: CONN_A, resources: ['products'], mode: 'backfill' }),
    ).rejects.toThrow(RangeError);
  });
  it('a failed full run leaves the watermark cleared, so the next incremental reads everything (more data, never less)', async () => {
    const h = makeHarness(env);
    await runMode(h, ['products'], 'backfill');
    h.clock.advance(60_000);
    h.connector.failNext(new PermanentError('boom'));
    await runMode(h, ['products'], 'full');
    const failed = await cursorRow('products');
    expect([failed.status, failed.updated_since]).toEqual(['failed', null]);
    h.clock.advance(60_000);
    const callsBefore = h.connector.calls.length;
    await runMode(h, ['products'], 'incremental');
    expect(h.connector.calls[callsBefore]!.options.updatedSince).toBeUndefined();
  });
  it('a full chain keeps its mode for every resource it carries', async () => {
    const h = makeHarness(env);
    await enqueueSync(h.deps, { orgId: ORG_A, connectionId: CONN_A, resources: ['products', 'inventory'], mode: 'full' });
    const first = h.queue.take()!.job;
    expect(first.then).toEqual({ resources: ['inventory'], mode: 'full', since: null });
  });
});

describe('connection freshness is the oldest resource', () => {
  const connRow = async () =>
    (await env.owner.query(`select last_synced_at from store_connections where id = $1`, [CONN_A])).rows[0];
  beforeEach(() =>
    env.owner.query(`update store_connections set status = 'active', last_error = null, last_synced_at = null where id = $1`, [CONN_A]),
  );
  it('a single-resource run does not mark the connection fresh', async () => {
    const h = makeHarness(env);
    await runMode(h, ['locations'], 'backfill');
    expect((await cursorRow('locations')).last_synced_at.toISOString()).toBe('2026-10-06T12:00:00.000Z');
    expect((await connRow()).last_synced_at).toBeNull();
  });
  it('is the OLDEST of the four resource times once all four have completed, and later runs of one resource do not move it', async () => {
    const h = makeHarness(env);
    await runMode(h, ['locations', 'products', 'inventory', 'orders'], 'backfill');
    expect((await connRow()).last_synced_at.toISOString()).toBe('2026-10-06T12:00:00.000Z');
    h.clock.advance(3_600_000);
    await runMode(h, ['locations'], 'incremental'); // locations now 13:00, the other three still 12:00
    expect((await connRow()).last_synced_at.toISOString()).toBe('2026-10-06T12:00:00.000Z');
    h.clock.advance(3_600_000);
    await runMode(h, ['products', 'inventory', 'orders'], 'incremental'); // now locations (13:00) is the oldest
    expect((await connRow()).last_synced_at.toISOString()).toBe('2026-10-06T13:00:00.000Z');
  });
});
```

Rewrite the two existing tests in `describe('connection health')` that assume a single-resource run sets the connection time:

```ts
  it('a single-resource run keeps the connection status and does not claim the connection is fresh', async () => {
    const h = makeHarness(env);
    await processSyncPage(h.deps, await start(h, 'locations'));
    const c = await conn();
    expect(c.status).toBe('active');
    expect(c.last_synced_at).toBeNull();
  });
```
(replaces `records last_synced_at when a single-resource run completes and keeps the status`) and

```ts
  it('is not changed again by a duplicated final job', async () => {
    const h = makeHarness(env);
    await runAll(h);
    const first = h.queue.take()!.job; // the locations job
    await h.queue.enqueue(first);
    await drain(h);
    const before = (await conn()).last_synced_at.toISOString();
    h.clock.advance(3_600_000);
    expect(await processSyncPage(h.deps, first)).toEqual({ kind: 'done' }); // stale: its run finished
    expect((await conn()).last_synced_at.toISOString()).toBe(before);
  });
```
(replaces the test of the same name that started from one resource).

Add the interleaving test (this closes the known gap "the connection-health row lock has no test that interleaves two writers") inside `describe('connection health')`:

```ts
  it('does not recover an errored connection when another job fails a cursor while this chain ends (row lock)', async () => {
    await setConn('error', 'token revoked');
    // No orders in the page: the sink then takes no foreign-key lock, so the ONLY thing that can make the
    // chain end wait is the explicit connection row lock.
    const h = makeHarness(env, { data: { ...sampleData(), orders: [] } });
    const job = await start(h, 'orders');
    const blocker = await env.owner.connect();
    try {
      await blocker.query('begin');
      await blocker.query('select id from store_connections where id = $1 for update', [CONN_A]);
      const ending = processSyncPage(h.deps, job);
      await waitUntilBlocked();
      await blocker.query(
        `insert into sync_cursors (org_id, store_connection_id, resource, status, last_error)
         values ($1, $2, 'inventory', 'failed', 'boom')`,
        [ORG_A, CONN_A],
      );
      await blocker.query('commit');
      await ending;
    } finally {
      blocker.release();
    }
    const c = await conn();
    expect([c.status, c.last_error]).toEqual(['error', 'token revoked']); // the failed cursor was seen after the lock
  });
```
with this helper at file level (bounded: 100 tries of 50 ms):

```ts
async function waitUntilBlocked(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const { rows } = await env.owner.query(
      `select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
    );
    if (rows.length > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the chain end never waited for the connection row lock');
}
```

- [ ] **Step 2: Run to see the failures**

Run: `pnpm --filter @erq/sync exec vitest run test/job-schema.test.ts test/engine.test.ts`
Expected: FAIL (`mode: 'full'` rejected by the schema, `last_full_pass_at` is not a column, the single-resource run still sets `last_synced_at`).

- [ ] **Step 3: Implement**

`packages/sync/src/ports.ts`: `export type SyncMode = 'backfill' | 'incremental' | 'full';`

`packages/sync/src/job-schema.ts`: `mode: z.enum(['backfill', 'incremental', 'full']),` (the refine that a backfill needs `since` stays as it is).

`packages/db/src/schema/orders.ts`, in `syncCursors` after `updatedSince`:

```ts
    /** When the last run that read EVERYTHING (a backfill or a full pass) completed. The scheduler uses it for the daily products pass. */
    lastFullPassAt: timestamp('last_full_pass_at', { withTimezone: true }),
```
Generate: `cd "C:/Users/OK COMPUTER/Desktop/WorkAgentic/eRetailQuery/packages/db" && pnpm exec drizzle-kit generate --name=cursor_full_pass` (expected `0023_cursor_full_pass.sql` with one `ALTER TABLE "sync_cursors" ADD COLUMN "last_full_pass_at" timestamp with time zone;`).

`packages/sync/src/engine/start.ts`, in `startRun`'s cursor reset `.set({...})` add after `backfillSince`:

```ts
      // A full pass reads everything: forget the watermark so the connector receives no change filter.
      // (A failed pass leaves it cleared, so the next incremental also reads everything: more data, never less.)
      ...(args.mode === 'full' ? { updatedSince: null } : {}),
```
(`type: args.mode` in the run insert already records `'full'`.)

`packages/sync/src/engine/process.ts`:
- In the first `withTenant` load, select the run's type too: `const [run] = await tx.select({ startedAt: syncRuns.startedAt, type: syncRuns.type }).from(syncRuns).where(eq(syncRuns.id, job.syncRunId));` and return `runType: run?.type ?? 'incremental'` next to `runStartedAt`; destructure `runType` with `runStartedAt`.
- In the `done` branch of the cursor update add `...(runType === 'backfill' || runType === 'full' ? { lastFullPassAt: now } : {}),` (a backfill and a full pass both read everything).
- In the connection-health update replace `lastSyncedAt: now,` with:

```ts
            // The OLDEST resource time, and only once all four resources have completed: a single-resource run
            // or a nudge must never make the whole connection look fresh. Reads this transaction's own cursor write.
            lastSyncedAt: sql`coalesce((
              select case when count(${syncCursors.lastSyncedAt}) = ${SYNC_RESOURCES.length}
                          then min(${syncCursors.lastSyncedAt}) end
              from ${syncCursors}
              where ${syncCursors.storeConnectionId} = ${storeConnections.id}), ${storeConnections.lastSyncedAt})`,
```
and import `SYNC_RESOURCES` from `@erq/connectors`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd "C:/Users/OK COMPUTER/Desktop/WorkAgentic/eRetailQuery" && pnpm turbo run build --filter=@erq/db --filter=@erq/connectors --filter=@erq/shared --concurrency=1
pnpm --filter @erq/sync exec vitest run test/job-schema.test.ts test/engine.test.ts
pnpm --filter @erq/sync exec vitest run test/shopify-engine-e2e.test.ts
pnpm --filter @erq/sync typecheck
```
Expected: PASS. In `shopify-engine-e2e.test.ts` the assertions on `conn().last_synced_at` after a complete chain (`RUN_TIME`, two places) hold because every resource completes at the harness clock. If the throttled-chain case advanced the clock and now reads an earlier time, the correct expectation is the oldest cursor time: replace `RUN_TIME` there with the result of `select min(last_synced_at) from sync_cursors where store_connection_id = $1` and say so in the commit body.

- [ ] **Step 5: Commit**

```bash
git add packages/sync packages/db
git commit -m "feat(sync): add a full pass mode and make connection freshness the oldest resource

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Cadence constants, the due query and `dueResources`

**Files:**
- Create: `packages/sync/src/schedule/cadence.ts`, `packages/sync/src/schedule/due.ts`; generated empty `packages/db/migrations/0024_schedule_functions.sql` (filled by hand, it is a custom migration) and `migrations/meta/*`
- Modify: `packages/sync/src/index.ts`
- Test: `packages/sync/test/schedule-due.test.ts` (create), `packages/db/test/schedule-functions.test.ts` (create), `packages/db/test/hardening.test.ts` (extend the Supabase simulation lists)

**Interfaces:**
- Produces (`@erq/sync`):
  - `SYNC_CADENCE_MS: Record<SyncResource, number>` = `{ locations: 900_000, products: 900_000, orders: 900_000, inventory: 3_600_000 }`; `PRODUCTS_FULL_PASS_MS = 86_400_000`; `MAX_CONNECTIONS_PER_TICK = 50`.
  - `interface CursorSnapshot { resource: SyncResource; status: 'idle' | 'running' | 'failed' | 'complete'; lastSyncedAt: Date | null; lastFullPassAt: Date | null; updatedAt: Date }`
  - `interface DueResource { resource: SyncResource; mode: 'incremental' | 'full' }`
  - `dueResources(cursors: readonly CursorSnapshot[], now: Date): DueResource[]`
  - `planChains(due: readonly DueResource[]): { incremental: SyncResource[]; full: SyncResource[] }`
- Produces (SQL, worker-only, never through a route): `app_list_due_sync_resources(p_now timestamptz, p_limit integer) returns table (o_org_id uuid, o_connection_id uuid, o_resource sync_resource, o_status cursor_status, o_last_synced_at timestamptz, o_last_full_pass_at timestamptz, o_updated_at timestamptz)` and `app_list_idle_refresh_connections(p_now timestamptz, p_limit integer) returns table (o_org_id uuid, o_connection_id uuid)`.
- Rules: a connection is listed only when it is a Shopify connection with status `active` and credentials, all four of its resources have a cursor row with a non-null `last_synced_at` (the first backfill finished), and NO cursor is `running`. A cursor's reference time is `last_synced_at`, or `max(last_synced_at, updated_at)` while it is `failed` (back-off from the last attempt). The SQL only pre-filters (some reference older than 15 minutes, or the products full pass due); `dueResources` makes the real decision. Connections come oldest first and at most `least(greatest(p_limit, 1), 200)`.

- [ ] **Step 1: Write the failing tests**

Create `packages/sync/test/schedule-due.test.ts`:

```ts
import { SYNC_RESOURCES, type SyncResource } from '@erq/connectors';
import { describe, expect, it } from 'vitest';
import {
  MAX_CONNECTIONS_PER_TICK,
  PRODUCTS_FULL_PASS_MS,
  SYNC_CADENCE_MS,
} from '../src/schedule/cadence';
import { dueResources, planChains, type CursorSnapshot } from '../src/schedule/due';

const NOW = new Date('2026-10-08T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;

function cursors(
  over: Partial<Record<SyncResource, Partial<CursorSnapshot>>> = {},
  syncedAgoMs = 5 * MIN,
): CursorSnapshot[] {
  return SYNC_RESOURCES.map((resource): CursorSnapshot => ({
    resource,
    status: 'complete',
    lastSyncedAt: ago(syncedAgoMs),
    lastFullPassAt: ago(60 * MIN),
    updatedAt: ago(syncedAgoMs),
    ...over[resource],
  }));
}

describe('constants (copied from the spec)', () => {
  it('has the agreed cadences', () => {
    expect(SYNC_CADENCE_MS).toEqual({
      locations: 15 * MIN,
      products: 15 * MIN,
      orders: 15 * MIN,
      inventory: 60 * MIN,
    });
    expect(PRODUCTS_FULL_PASS_MS).toBe(24 * 60 * MIN);
    expect(MAX_CONNECTIONS_PER_TICK).toBe(50);
  });
});

describe('dueResources', () => {
  it('has nothing due when everything is fresh', () => {
    expect(dueResources(cursors(), NOW)).toEqual([]);
  });
  it.each(SYNC_RESOURCES.map((r) => [r, SYNC_CADENCE_MS[r]] as const))(
    '%s is not due one millisecond before its cadence and is due exactly at it',
    (resource, cadence) => {
      expect(dueResources(cursors({ [resource]: { lastSyncedAt: ago(cadence - 1) } }), NOW)).toEqual([]);
      expect(dueResources(cursors({ [resource]: { lastSyncedAt: ago(cadence) } }), NOW)).toEqual([
        { resource, mode: 'incremental' },
      ]);
    },
  );
  it('returns the due resources in dependency order', () => {
    const due = dueResources(
      cursors({
        orders: { lastSyncedAt: ago(20 * MIN) },
        locations: { lastSyncedAt: ago(20 * MIN) },
        inventory: { lastSyncedAt: ago(61 * MIN) },
      }),
      NOW,
    );
    expect(due.map((d) => d.resource)).toEqual(['locations', 'inventory', 'orders']);
  });
  it('asks for the products full pass at exactly 24 hours, or when there is no record, and it replaces the incremental', () => {
    const justUnder = cursors({ products: { lastFullPassAt: ago(PRODUCTS_FULL_PASS_MS - 1) } });
    expect(dueResources(justUnder, NOW)).toEqual([]);
    expect(dueResources(cursors({ products: { lastFullPassAt: ago(PRODUCTS_FULL_PASS_MS) } }), NOW)).toEqual([
      { resource: 'products', mode: 'full' },
    ]);
    expect(dueResources(cursors({ products: { lastFullPassAt: null } }), NOW)).toEqual([
      { resource: 'products', mode: 'full' },
    ]);
    const both = cursors({ products: { lastFullPassAt: null, lastSyncedAt: ago(30 * MIN) } });
    expect(dueResources(both, NOW).filter((d) => d.resource === 'products')).toEqual([
      { resource: 'products', mode: 'full' },
    ]);
  });
  it('is blocked by ANY running cursor, even when other resources are long overdue', () => {
    const c = cursors({ orders: { status: 'running' }, locations: { lastSyncedAt: ago(5 * 60 * MIN) } });
    expect(dueResources(c, NOW)).toEqual([]);
  });
  it('skips a connection that never finished its first backfill', () => {
    const overdue = 5 * 60 * MIN;
    expect(dueResources(cursors({ orders: { lastSyncedAt: null } }, overdue), NOW)).toEqual([]);
    expect(dueResources(cursors({}, overdue).slice(0, 3), NOW)).toEqual([]); // a missing cursor row
    expect(dueResources([], NOW)).toEqual([]);
  });
  it('waits one cadence after a FAILED attempt instead of retrying every tick', () => {
    const failedRecently = cursors({
      orders: { status: 'failed', lastSyncedAt: ago(3 * 60 * MIN), updatedAt: ago(MIN) },
    });
    expect(dueResources(failedRecently, NOW)).toEqual([]);
    const failedLongAgo = cursors({
      orders: { status: 'failed', lastSyncedAt: ago(3 * 60 * MIN), updatedAt: ago(15 * MIN) },
    });
    expect(dueResources(failedLongAgo, NOW)).toEqual([{ resource: 'orders', mode: 'incremental' }]);
  });
  it('also waits after a failed products full pass', () => {
    const c = cursors({
      products: { status: 'failed', lastFullPassAt: null, lastSyncedAt: ago(3 * 60 * MIN), updatedAt: ago(2 * MIN) },
    });
    expect(dueResources(c, NOW)).toEqual([]);
  });
});

describe('planChains', () => {
  it('uses one incremental chain when no full pass is due', () => {
    expect(
      planChains([
        { resource: 'locations', mode: 'incremental' },
        { resource: 'orders', mode: 'incremental' },
      ]),
    ).toEqual({ incremental: ['locations', 'orders'], full: [] });
  });
  it('splits the daily pass off with the inventory that follows it, keeping the rest incremental', () => {
    expect(
      planChains([
        { resource: 'locations', mode: 'incremental' },
        { resource: 'products', mode: 'full' },
        { resource: 'inventory', mode: 'incremental' },
        { resource: 'orders', mode: 'incremental' },
      ]),
    ).toEqual({ incremental: ['locations', 'orders'], full: ['products', 'inventory'] });
    expect(planChains([{ resource: 'products', mode: 'full' }])).toEqual({
      incremental: [],
      full: ['products'],
    });
  });
});
```

Create `packages/db/test/schedule-functions.test.ts`:

```ts
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../src/testing';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const C2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const C3 = 'bbbbbbbb-0000-4000-8000-000000000003';
const RESOURCES = ['locations', 'products', 'inventory', 'orders'] as const;
let tdb: TestDatabase;
let owner: Pool;
let app: Pool;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  app = new Pool({ connectionString: tdb.appUrl });
  for (const org of [A, B]) {
    await owner.query(
      `insert into orgs (id, name, slug) values ($1, 'Org', 'org-' || ($1::uuid)::text)`,
      [org],
    );
  }
}, 120_000);
afterAll(async () => {
  await app?.end();
  await owner?.end();
  await tdb?.stop();
});
beforeEach(() => owner.query('delete from store_connections'));

async function addConnection(
  id: string,
  org: string,
  o: { status?: string; creds?: string | null; platform?: string; accessInMin?: number | null; refreshInDays?: number | null } = {},
) {
  await owner.query(
    `insert into store_connections (id, org_id, platform, external_account_id, status, encrypted_credentials,
       access_token_expires_at, refresh_token_expires_at)
     values ($1, $2, $3, ($1::uuid)::text || '.myshopify.com', $4, $5,
       now() + make_interval(mins => $6), now() + make_interval(days => $7))`,
    [
      id, org, o.platform ?? 'shopify', o.status ?? 'active',
      o.creds === undefined ? 'ciphertext' : o.creds,
      o.accessInMin === undefined ? null : o.accessInMin,
      o.refreshInDays === undefined ? null : o.refreshInDays,
    ],
  );
}
/** `syncedMinAgo` null means never completed. updated_at is set on INSERT because the trigger only fires on UPDATE. */
async function addCursors(
  id: string,
  org: string,
  o: {
    syncedMinAgo?: number | null;
    fullPassMinAgo?: number | null;
    status?: string;
    updatedMinAgo?: number;
    only?: readonly string[];
    per?: Record<string, { status?: string; syncedMinAgo?: number | null; updatedMinAgo?: number }>;
  } = {},
) {
  for (const resource of o.only ?? RESOURCES) {
    const p = o.per?.[resource] ?? {};
    const synced = p.syncedMinAgo === undefined ? (o.syncedMinAgo === undefined ? 120 : o.syncedMinAgo) : p.syncedMinAgo;
    await owner.query(
      `insert into sync_cursors (org_id, store_connection_id, resource, status, last_synced_at, last_full_pass_at, updated_at)
       values ($1, $2, $3, $4, now() - make_interval(mins => $5), now() - make_interval(mins => $6), now() - make_interval(mins => $7))`,
      [
        org, id, resource, p.status ?? o.status ?? 'complete', synced,
        o.fullPassMinAgo === undefined ? 10 : o.fullPassMinAgo,
        p.updatedMinAgo ?? o.updatedMinAgo ?? synced ?? 0,
      ],
    );
  }
}
const due = async (limit = 50) =>
  (await app.query('select * from app_list_due_sync_resources(now(), $1)', [limit])).rows;
const connectionsOf = (rows: { o_connection_id: string }[]) => [...new Set(rows.map((r) => r.o_connection_id))];

describe('app_list_due_sync_resources', () => {
  it('lists the four cursors of every due connection across tenants, for app_user', async () => {
    await addConnection(C1, A);
    await addCursors(C1, A);
    await addConnection(C3, B);
    await addCursors(C3, B);
    const rows = await due();
    expect(connectionsOf(rows).sort()).toEqual([C1, C3]);
    expect(rows).toHaveLength(8);
    expect(rows.find((r) => r.o_connection_id === C1)).toMatchObject({ o_org_id: A, o_status: 'complete' });
    expect(rows.find((r) => r.o_connection_id === C3)).toMatchObject({ o_org_id: B });
  });
  it('skips a connection with ANY running cursor', async () => {
    await addConnection(C1, A);
    await addCursors(C1, A, { per: { orders: { status: 'running' } } });
    expect(await due()).toEqual([]);
  });
  it('skips a connection that has not finished its first backfill (a missing row or a null time)', async () => {
    await addConnection(C1, A);
    await addCursors(C1, A, { only: ['locations', 'products', 'inventory'] });
    await addConnection(C2, A);
    await addCursors(C2, A, { per: { orders: { syncedMinAgo: null } } });
    expect(await due()).toEqual([]);
  });
  it.each(['error', 'disconnected', 'pending', 'demo'])('skips a %s connection', async (status) => {
    await addConnection(C1, A, { status });
    await addCursors(C1, A);
    expect(await due()).toEqual([]);
  });
  it('skips a connection without credentials and a platform other than shopify', async () => {
    await addConnection(C1, A, { creds: null });
    await addCursors(C1, A);
    await addConnection(C2, A, { platform: 'woocommerce' });
    await addCursors(C2, A);
    expect(await due()).toEqual([]);
  });
  it('lists nothing while everything is fresh, but lists a connection whose products full pass is due', async () => {
    await addConnection(C1, A);
    await addCursors(C1, A, { syncedMinAgo: 5, fullPassMinAgo: 60 });
    expect(await due()).toEqual([]);
    await owner.query(`update sync_cursors set last_full_pass_at = now() - interval '25 hours' where resource = 'products'`);
    expect(connectionsOf(await due())).toEqual([C1]);
    await owner.query(`update sync_cursors set last_full_pass_at = null where resource = 'products'`);
    expect(connectionsOf(await due())).toEqual([C1]);
  });
  it('backs off a failed cursor from its last attempt, not from its old completion time', async () => {
    await addConnection(C1, A);
    await addCursors(C1, A, { syncedMinAgo: 5, fullPassMinAgo: 60, per: { orders: { status: 'failed', syncedMinAgo: 180, updatedMinAgo: 1 } } });
    expect(await due()).toEqual([]);
    // The updated_at trigger fires on UPDATE, so back-date the attempt by inserting the cursors again.
    await owner.query('delete from sync_cursors');
    await addCursors(C1, A, { syncedMinAgo: 5, fullPassMinAgo: 60, per: { orders: { status: 'failed', syncedMinAgo: 180, updatedMinAgo: 16 } } });
    expect(connectionsOf(await due())).toEqual([C1]);
  });
  it('returns the oldest connections first and honours the limit', async () => {
    await addConnection(C1, A);
    await addCursors(C1, A, { syncedMinAgo: 30 });
    await addConnection(C2, A);
    await addCursors(C2, A, { syncedMinAgo: 300 });
    await addConnection(C3, B);
    await addCursors(C3, B, { syncedMinAgo: 90 });
    expect(connectionsOf(await due())).toEqual([C2, C3, C1]);
    expect(connectionsOf(await due(2))).toEqual([C2, C3]);
    expect(connectionsOf(await due(0))).toEqual([C2]); // a limit below 1 still returns one connection
  });
});

describe('app_list_idle_refresh_connections', () => {
  const idle = async () =>
    (await app.query('select * from app_list_idle_refresh_connections(now(), 50)')).rows.map((r) => r.o_connection_id);
  it('lists active connections whose refresh token is within 14 days and whose access token is expired or about to be', async () => {
    await addConnection(C1, A, { accessInMin: -60, refreshInDays: 10 });
    await addConnection(C2, A, { accessInMin: 4, refreshInDays: 13 });
    await addConnection(C3, B, { accessInMin: -60, refreshInDays: 10 });
    expect((await idle()).sort()).toEqual([C1, C2, C3]);
  });
  it('skips a refresh token with more than 14 days left, an access token with more than 5 minutes left, no expiry data, and every non-active connection', async () => {
    await addConnection(C1, A, { accessInMin: -60, refreshInDays: 20 });
    await addConnection(C2, A, { accessInMin: 6, refreshInDays: 10 });
    await addConnection(C3, B, { accessInMin: null, refreshInDays: null });
    expect(await idle()).toEqual([]);
    for (const [i, status] of ['error', 'disconnected', 'pending', 'demo'].entries()) {
      const id = `cccccccc-0000-4000-8000-00000000000${i}`;
      await addConnection(id, A, { status, accessInMin: -60, refreshInDays: 10 });
    }
    expect(await idle()).toEqual([]);
  });
});

describe.each([
  'app_list_due_sync_resources(timestamptz, integer)',
  'app_list_idle_refresh_connections(timestamptz, integer)',
])('%s hardening', (fn) => {
  it('is SECURITY DEFINER with a pinned search_path, and executable by app_user only', async () => {
    const { rows } = await owner.query(`select prosecdef, proconfig from pg_proc where oid = $1::regprocedure`, [fn]);
    expect(rows[0].prosecdef).toBe(true);
    expect(rows[0].proconfig).toContain('search_path=pg_catalog, public, pg_temp');
    const priv = async (role: string) =>
      (await owner.query(`select has_function_privilege($1, $2::regprocedure, 'execute') as ok`, [role, fn])).rows[0].ok;
    expect(await priv('public')).toBe(false);
    expect(await priv('app_user')).toBe(true);
  });
});
```

In `packages/db/test/hardening.test.ts` add a list `const SCHEDULE_FNS = ['app_list_due_sync_resources(timestamptz, integer)', 'app_list_idle_refresh_connections(timestamptz, integer)'];` next to `HELPER_FNS`, include it in the two Supabase-simulation loops (`for (const fn of [...ACCOUNT_FNS, ...HELPER_FNS, ...SCHEDULE_FNS])` for anon/authenticated having no execute) and add a separate assertion that `app_user` still executes `SCHEDULE_FNS` (copy the `app_user still executes the account functions` test with that list).

- [ ] **Step 2: Run to see the failures**

Run: `pnpm --filter @erq/sync exec vitest run test/schedule-due.test.ts` and `pnpm --filter @erq/db exec vitest run test/schedule-functions.test.ts`
Expected: FAIL (modules and functions do not exist).

- [ ] **Step 3: Implement the pure part**

`packages/sync/src/schedule/cadence.ts`:

```ts
import type { SyncResource } from '@erq/connectors';

/** How often each resource is polled. Inventory is a full pass every time (the connector ignores updatedSince for it). */
export const SYNC_CADENCE_MS: Record<SyncResource, number> = {
  locations: 15 * 60_000,
  products: 15 * 60_000,
  orders: 15 * 60_000,
  inventory: 60 * 60_000,
};
/** A products pass without the updated_at filter, daily: an edit of only a variant's cost does not bump the product's updated_at. */
export const PRODUCTS_FULL_PASS_MS = 24 * 60 * 60_000;
/** The scheduler starts at most this many connections per tick (oldest due first). */
export const MAX_CONNECTIONS_PER_TICK = 50;
/** The ticker job runs this often. */
export const SYNC_TICK_EVERY_MS = 60_000;
```

`packages/sync/src/schedule/due.ts`:

```ts
import { SYNC_RESOURCES, type SyncResource } from '@erq/connectors';
import { PRODUCTS_FULL_PASS_MS, SYNC_CADENCE_MS } from './cadence';

export interface CursorSnapshot {
  resource: SyncResource;
  status: 'idle' | 'running' | 'failed' | 'complete';
  lastSyncedAt: Date | null;
  lastFullPassAt: Date | null;
  updatedAt: Date;
}
export interface DueResource {
  resource: SyncResource;
  mode: 'incremental' | 'full';
}

/** The cadence is measured from the last completion, or from the last ATTEMPT while the cursor is failed (back-off). */
function referenceMs(c: CursorSnapshot): number {
  const done = (c.lastSyncedAt as Date).getTime();
  return c.status === 'failed' ? Math.max(done, c.updatedAt.getTime()) : done;
}

/**
 * Which resources of ONE connection should start now. Pure: the database function only pre-filters, this decides.
 * Nothing is due while any cursor is running, and a connection whose first backfill has not finished (a missing
 * cursor row or a null completion time) is left to connect and Sync now.
 */
export function dueResources(cursors: readonly CursorSnapshot[], now: Date): DueResource[] {
  if (cursors.some((c) => c.status === 'running')) return [];
  const byResource = new Map(cursors.map((c) => [c.resource, c]));
  for (const resource of SYNC_RESOURCES) {
    if (byResource.get(resource)?.lastSyncedAt == null) return [];
  }
  const due: DueResource[] = [];
  for (const resource of SYNC_RESOURCES) {
    const c = byResource.get(resource) as CursorSnapshot;
    const waited = now.getTime() - referenceMs(c);
    // A failed attempt (any mode) waits one cadence before the next one.
    const attemptAllowed = c.status !== 'failed' || waited >= SYNC_CADENCE_MS[resource];
    const fullDue =
      resource === 'products' &&
      attemptAllowed &&
      (c.lastFullPassAt === null || now.getTime() - c.lastFullPassAt.getTime() >= PRODUCTS_FULL_PASS_MS);
    if (fullDue) due.push({ resource, mode: 'full' });
    else if (waited >= SYNC_CADENCE_MS[resource]) due.push({ resource, mode: 'incremental' });
  }
  return due;
}

/**
 * One incremental chain, plus (when the products full pass is due) a separate `full` chain of products and the
 * inventory that follows it. Orders and locations stay incremental: a full pass of them would re-read history.
 */
export function planChains(due: readonly DueResource[]): {
  incremental: SyncResource[];
  full: SyncResource[];
} {
  const all = due.map((d) => d.resource);
  if (!due.some((d) => d.resource === 'products' && d.mode === 'full')) {
    return { incremental: all, full: [] };
  }
  const full = all.filter((r) => r === 'products' || r === 'inventory');
  return { incremental: all.filter((r) => !full.includes(r)), full };
}
```
Add to `packages/sync/src/index.ts`: `export * from './schedule/cadence';` and `export * from './schedule/due';`.

- [ ] **Step 4: Implement the SQL**

Run: `cd "C:/Users/OK COMPUTER/Desktop/WorkAgentic/eRetailQuery/packages/db" && pnpm exec drizzle-kit generate --custom --name=schedule_functions` (creates an empty `0024_schedule_functions.sql`, its snapshot and the journal entry), then fill the SQL file:

```sql
-- The scheduler's two cross-tenant reads (worker only, never exposed through an API route). They return ids and
-- timestamps only. app_list_due_sync_resources PRE-FILTERS; packages/sync/src/schedule/due.ts makes the real
-- decision, so the cadence numbers below (15 minutes, 24 hours) must stay in line with SYNC_CADENCE_MS and
-- PRODUCTS_FULL_PASS_MS.
CREATE OR REPLACE FUNCTION app_list_due_sync_resources(p_now timestamptz, p_limit integer)
RETURNS TABLE (
  o_org_id uuid, o_connection_id uuid, o_resource sync_resource, o_status cursor_status,
  o_last_synced_at timestamptz, o_last_full_pass_at timestamptz, o_updated_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH ref AS (
    SELECT c.store_connection_id AS connection_id,
           min(CASE WHEN c.status = 'failed' THEN greatest(c.last_synced_at, c.updated_at) ELSE c.last_synced_at END) AS oldest
    FROM sync_cursors c
    GROUP BY c.store_connection_id
  ), eligible AS (
    SELECT sc.id, r.oldest
    FROM store_connections sc
    JOIN ref r ON r.connection_id = sc.id
    WHERE sc.platform = 'shopify' AND sc.status = 'active' AND sc.encrypted_credentials IS NOT NULL
      AND (SELECT count(c.last_synced_at) FROM sync_cursors c WHERE c.store_connection_id = sc.id) = 4
      AND NOT EXISTS (SELECT 1 FROM sync_cursors c WHERE c.store_connection_id = sc.id AND c.status = 'running')
      AND (r.oldest <= p_now - interval '15 minutes'
           OR EXISTS (SELECT 1 FROM sync_cursors c
                      WHERE c.store_connection_id = sc.id AND c.resource = 'products'
                        AND (c.last_full_pass_at IS NULL OR c.last_full_pass_at <= p_now - interval '24 hours')))
    ORDER BY r.oldest, sc.id
    LIMIT least(greatest(p_limit, 1), 200)
  )
  SELECT c.org_id, c.store_connection_id, c.resource, c.status, c.last_synced_at, c.last_full_pass_at, c.updated_at
  FROM sync_cursors c
  JOIN eligible e ON e.id = c.store_connection_id
  ORDER BY e.oldest, e.id, c.resource
$$;
--> statement-breakpoint
-- Shops that have nothing to sync (for example the first backfill never finished) still need their refresh token
-- renewed before the 90 day limit. The expiry times are mirrored in plain columns wherever credentials are written.
CREATE OR REPLACE FUNCTION app_list_idle_refresh_connections(p_now timestamptz, p_limit integer)
RETURNS TABLE (o_org_id uuid, o_connection_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT org_id, id FROM store_connections
  WHERE platform = 'shopify' AND status = 'active' AND encrypted_credentials IS NOT NULL
    AND refresh_token_expires_at IS NOT NULL AND refresh_token_expires_at <= p_now + interval '14 days'
    AND access_token_expires_at IS NOT NULL AND access_token_expires_at <= p_now + interval '5 minutes'
  ORDER BY refresh_token_expires_at, id
  LIMIT least(greatest(p_limit, 1), 200)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_list_due_sync_resources(timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_list_idle_refresh_connections(timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_list_due_sync_resources(timestamptz, integer) TO app_user;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_list_idle_refresh_connections(timestamptz, integer) TO app_user;
--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION app_list_due_sync_resources(timestamptz, integer) FROM %I', r);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION app_list_idle_refresh_connections(timestamptz, integer) FROM %I', r);
  END LOOP;
END $$;
```
(The `ORDER BY r.oldest, sc.id` puts the oldest due connection first; the idle test with `limit 0` returning one connection comes from `greatest(p_limit, 1)`.)

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd "C:/Users/OK COMPUTER/Desktop/WorkAgentic/eRetailQuery" && pnpm turbo run build --filter=@erq/db --filter=@erq/connectors --filter=@erq/shared --concurrency=1
pnpm --filter @erq/sync exec vitest run test/schedule-due.test.ts
pnpm --filter @erq/db exec vitest run test/schedule-functions.test.ts
pnpm --filter @erq/db exec vitest run test/hardening.test.ts
pnpm --filter @erq/sync typecheck
```
Expected: PASS. If the `failed` back-off test shows the first `due()` assertion not empty, check that `addCursors` inserted `updated_at` (INSERT keeps it; the trigger only fires on UPDATE).

- [ ] **Step 6: Commit**

```bash
git add packages/sync packages/db
git commit -m "feat(sync): add the scheduler due queries and the pure due logic

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The ticker, the cadence loop and idle refresh

**Files:**
- Create: `packages/sync/src/schedule/tick.ts`
- Modify: `packages/sync/src/engine/fail.ts` (add `markConnectionError`, reuse it in `failRun`), `packages/sync/src/index.ts`
- Modify: `apps/worker/src/sync/handler.ts`, `apps/worker/src/sync/worker.ts`, `apps/worker/src/main.ts`
- Test: `packages/sync/test/schedule-tick.test.ts` (create), `apps/worker/test/sync-handler.test.ts` (add), `apps/worker/test/schedule.test.ts` (create)

**Interfaces:**
- Consumes (Tasks 3-5): `TokenService`, `createTokenService`, `dueResources`, `planChains`, `MAX_CONNECTIONS_PER_TICK`, `SYNC_TICK_EVERY_MS`, `enqueueSync`, `app_list_due_sync_resources`, `app_list_idle_refresh_connections`.
- Produces:
  - `markConnectionError(tx: Tx, connectionId: string, message: string): Promise<void>` (`@erq/sync`; only `active`, `pending` and `error` connections change, exactly as `failRun`)
  - `interface SchedulerDeps extends SyncDeps { onError?: (message: string) => void }` and `interface TickSummary { connections: number; enqueued: number; failed: number; refreshed: number }`
  - `runSchedulerTick(deps: SchedulerDeps): Promise<TickSummary>`
  - worker: `handleSyncJob(deps: SchedulerDeps, job, impl?)` handles the job name `schedule-tick`; `scheduleSyncTick(queue: Queue): Promise<void>` (scheduler id `sync-tick`, every 60 000 ms, job name `schedule-tick`).
- Behaviour of one tick: (1) read at most 50 due connections; group their cursor rows; for each (oldest first) `dueResources`, `planChains`, then `enqueueSync(deps, { orgId, connectionId, resources, mode })` for the incremental chain and for the full chain; an error for one chain is sanitized, counted and reported through `onError`, and never stops the loop; (2) read at most 50 idle-refresh connections and call `tokens.ensureFresh` for each; a final `AuthError` marks the connection `error` with the fixed text; other errors are counted and reported.

- [ ] **Step 1: Write the failing tests**

Create `packages/sync/test/schedule-tick.test.ts`:

```ts
import {
  AuthError,
  SHOPIFY_RECONNECT_MESSAGE,
  decryptConnectionCredentials,
  encryptConnectionCredentials,
  type ShopifyRefreshGrant,
  type SyncResource,
} from '@erq/connectors';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runSchedulerTick } from '../src/schedule/tick';
import { createTokenService } from '../src/tokens';
import type { SyncPageJob } from '../src/ports';
import { makeHarness, resetSync } from './engine-helpers';
import { CONN_A, CONN_B, ORG_A, ORG_B, startEnv, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env?.stop();
});

const MIN = 60_000;
const T0 = Date.parse('2026-10-06T12:00:00Z'); // the harness clock
const at = (minAgo: number) => new Date(T0 - minAgo * MIN);

beforeEach(async () => {
  await resetSync(env);
  await env.owner.query(`delete from store_connections where external_account_id like 'cap-%'`);
  await env.owner.query(
    `update store_connections set status = 'active', last_error = null, encrypted_credentials = 'ciphertext',
       access_token_expires_at = null, refresh_token_expires_at = null`,
  );
});
afterEach(() => env.owner.query(`delete from store_connections where external_account_id like 'cap-%'`));

type PerResource = Partial<Record<SyncResource, { agoMin?: number | null; status?: string; updatedAgoMin?: number }>>;
async function seed(
  connectionId: string,
  orgId: string,
  o: { agoMin?: number; fullPassAgoMin?: number | null; per?: PerResource; only?: SyncResource[] } = {},
) {
  const all: SyncResource[] = ['locations', 'products', 'inventory', 'orders'];
  for (const resource of o.only ?? all) {
    const p = o.per?.[resource] ?? {};
    const ago = p.agoMin === undefined ? (o.agoMin ?? 120) : p.agoMin;
    await env.owner.query(
      `insert into sync_cursors (org_id, store_connection_id, resource, status, last_synced_at, last_full_pass_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        orgId, connectionId, resource, p.status ?? 'complete',
        ago === null ? null : at(ago),
        o.fullPassAgoMin === undefined ? at(10) : o.fullPassAgoMin === null ? null : at(o.fullPassAgoMin),
        at(p.updatedAgoMin ?? ago ?? 0),
      ],
    );
  }
}
const drainJobs = (h: ReturnType<typeof makeHarness>): SyncPageJob[] => {
  const jobs: SyncPageJob[] = [];
  for (let j = h.queue.take(); j; j = h.queue.take()) jobs.push(j.job);
  return jobs;
};
const runs = async () =>
  (await env.owner.query(`select connection_id, type, status from sync_runs order by started_at, id`)).rows;

describe('runSchedulerTick', () => {
  it('starts ONE incremental chain of the due resources in dependency order', async () => {
    const h = makeHarness(env);
    await seed(CONN_A, ORG_A, { agoMin: 5, per: { locations: { agoMin: 20 }, orders: { agoMin: 20 }, inventory: { agoMin: 30 } } });
    const summary = await runSchedulerTick(h.deps);
    expect(summary).toMatchObject({ connections: 1, enqueued: 1, failed: 0 });
    const jobs = drainJobs(h);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ orgId: ORG_A, connectionId: CONN_A, resource: 'locations' });
    expect(jobs[0]!.then).toEqual({ resources: ['orders'], mode: 'incremental', since: null }); // inventory (30 min) is not due
    expect((await runs()).map((r) => r.type)).toEqual(['incremental']);
  });
  it('includes inventory once 60 minutes have passed', async () => {
    const h = makeHarness(env);
    await seed(CONN_A, ORG_A, { agoMin: 5, per: { inventory: { agoMin: 61 } } });
    await runSchedulerTick(h.deps);
    expect(drainJobs(h)[0]).toMatchObject({ resource: 'inventory' });
  });
  it('splits the daily products pass into a full chain with the inventory that follows it', async () => {
    const h = makeHarness(env);
    await seed(CONN_A, ORG_A, { agoMin: 20, fullPassAgoMin: null, per: { inventory: { agoMin: 61 } } });
    const summary = await runSchedulerTick(h.deps);
    expect(summary).toMatchObject({ connections: 1, enqueued: 2 });
    const jobs = drainJobs(h);
    const incremental = jobs.find((j) => j.then?.mode === 'incremental')!;
    const full = jobs.find((j) => j.then?.mode === 'full' || j.resource === 'products')!;
    expect([incremental.resource, incremental.then?.resources]).toEqual(['locations', ['orders']]);
    expect([full.resource, full.then]).toEqual(['products', { resources: ['inventory'], mode: 'full', since: null }]);
    expect((await runs()).map((r) => r.type).sort()).toEqual(['full', 'incremental']);
  });
  it('does nothing for a connection with a running cursor, one that never finished its backfill, or one that is fresh', async () => {
    const h = makeHarness(env);
    await seed(CONN_A, ORG_A, { agoMin: 120, per: { orders: { status: 'running' } } });
    await seed(CONN_B, ORG_B, { agoMin: 120, only: ['locations', 'products', 'inventory'] });
    const summary = await runSchedulerTick(h.deps);
    expect(summary).toMatchObject({ connections: 0, enqueued: 0, failed: 0 });
    expect(h.queue.size).toBe(0);
    expect(await runs()).toEqual([]);
  });
  it('is idempotent: a second tick right after finds the cursors running and starts nothing', async () => {
    const h = makeHarness(env);
    await seed(CONN_A, ORG_A);
    await runSchedulerTick(h.deps);
    expect(h.queue.size).toBeGreaterThan(0);
    const before = (await runs()).length;
    expect(await runSchedulerTick(h.deps)).toMatchObject({ connections: 0, enqueued: 0 });
    expect((await runs()).length).toBe(before);
  });
  it('waits after a failed attempt instead of retrying every tick', async () => {
    const h = makeHarness(env);
    await seed(CONN_A, ORG_A, { agoMin: 5, per: { orders: { status: 'failed', agoMin: 180, updatedAgoMin: 1 } } });
    expect(await runSchedulerTick(h.deps)).toMatchObject({ connections: 0, enqueued: 0 });
    await env.owner.query('delete from sync_cursors');
    await seed(CONN_A, ORG_A, { agoMin: 5, per: { orders: { status: 'failed', agoMin: 180, updatedAgoMin: 16 } } });
    expect(await runSchedulerTick(h.deps)).toMatchObject({ connections: 1, enqueued: 1 });
    expect(drainJobs(h)[0]).toMatchObject({ resource: 'orders' });
  });
  it('starts the oldest connection first', async () => {
    const h = makeHarness(env);
    await seed(CONN_A, ORG_A, { agoMin: 30 });
    await seed(CONN_B, ORG_B, { agoMin: 200 });
    await runSchedulerTick(h.deps);
    expect(drainJobs(h).map((j) => j.connectionId)).toEqual([CONN_B, CONN_A]);
  });
  it('starts at most 50 connections per tick; the rest follow on the next tick', async () => {
    const h = makeHarness(env);
    await env.owner.query(
      `insert into store_connections (id, org_id, platform, external_account_id, status, encrypted_credentials)
       select gen_random_uuid(), $1, 'shopify', 'cap-' || g || '.myshopify.com', 'active', 'ciphertext' from generate_series(1, 52) g`,
      [ORG_A],
    );
    await env.owner.query(
      `insert into sync_cursors (org_id, store_connection_id, resource, status, last_synced_at, last_full_pass_at, updated_at)
       select $1, c.id, r.resource, 'complete', $2, $3, $2
       from store_connections c cross join (values ('locations'::sync_resource), ('products'), ('inventory'), ('orders')) r(resource)
       where c.external_account_id like 'cap-%'`,
      [ORG_A, at(120), at(10)],
    );
    const first = await runSchedulerTick(h.deps);
    expect(first).toMatchObject({ connections: 50, enqueued: 50 });
    expect(h.queue.size).toBe(50);
    const second = await runSchedulerTick(h.deps);
    expect(second).toMatchObject({ connections: 2, enqueued: 2 });
    expect(h.queue.size).toBe(52);
  });
  it('one failing enqueue is counted and reported (sanitized) and does not stop the other connections', async () => {
    const h = makeHarness(env);
    await seed(CONN_A, ORG_A, { agoMin: 200 });
    await seed(CONN_B, ORG_B, { agoMin: 100 });
    const messages: string[] = [];
    const inner = h.deps.queue;
    h.deps.queue = {
      enqueue: async (job, opts) => {
        if (job.connectionId === CONN_A) throw new Error('redis down shpat_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE');
        return inner.enqueue(job, opts);
      },
    };
    const summary = await runSchedulerTick({ ...h.deps, onError: (m) => messages.push(m) });
    expect(summary).toMatchObject({ connections: 2, enqueued: 1, failed: 1 });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(CONN_A);
    expect(messages[0]).not.toContain('shpat_');
    const cursor = (await env.owner.query(`select status from sync_cursors where store_connection_id = $1 and resource = 'locations'`, [CONN_A])).rows[0];
    expect(cursor.status).toBe('failed'); // enqueueSync freed the cursor instead of leaving a ghost run
    expect((inner as unknown as { size: number }).size).toBe(1);
  });
  it("fails closed when a row's org does not own the connection (tenant isolation of the follow-up)", async () => {
    const h = makeHarness(env);
    await seed(CONN_A, ORG_A);
    const forged = ['locations', 'products', 'inventory', 'orders'].map((o_resource) => ({
      o_org_id: ORG_B,
      o_connection_id: CONN_A,
      o_resource,
      o_status: 'complete',
      o_last_synced_at: at(120),
      o_last_full_pass_at: at(10),
      o_updated_at: at(120),
    }));
    const messages: string[] = [];
    const deps = {
      ...h.deps,
      // Only the due query returns the forged rows; the idle-refresh query finds nothing.
      db: {
        ...env.db,
        pool: { query: async (text: string) => ({ rows: text.includes('app_list_due') ? forged : [] }) },
      } as unknown as typeof env.db,
      onError: (m: string) => messages.push(m),
    };
    const summary = await runSchedulerTick(deps);
    expect(summary).toMatchObject({ enqueued: 0, failed: 1 });
    expect(h.queue.size).toBe(0);
    expect(await runs()).toEqual([]);
  });
});

describe('idle refresh', () => {
  const grant: ShopifyRefreshGrant = {
    accessToken: 'shpat_idle_new_0123',
    scopes: [],
    accessTokenExpiresInSec: 3600,
    refreshToken: 'shprt_idle_new_0123456789',
    refreshTokenExpiresInSec: 7_776_000,
  };
  const SEED_RT = 'shprt_idle_seed_0123456789';
  async function seedIdle(h: ReturnType<typeof makeHarness>, refreshInDays: number) {
    const creds = {
      accessToken: 'shpat_idle_old_0123',
      accessTokenExpiresAt: new Date(T0 - 3 * 3_600_000).toISOString(),
      refreshToken: SEED_RT,
      refreshTokenExpiresAt: new Date(T0 + refreshInDays * 86_400_000).toISOString(),
    };
    await env.owner.query(
      `update store_connections set encrypted_credentials = $2, access_token_expires_at = $3, refresh_token_expires_at = $4 where id = $1`,
      [CONN_A, encryptConnectionCredentials(creds, h.keyProvider, CONN_A), creds.accessTokenExpiresAt, creds.refreshTokenExpiresAt],
    );
  }
  it('renews the pair of a shop that has nothing to sync but a refresh token expiring within 14 days', async () => {
    const h = makeHarness(env);
    await seedIdle(h, 10);
    const presented: string[] = [];
    h.deps.tokens = createTokenService({
      db: env.db, keyProvider: h.keyProvider, now: h.clock.now,
      refresh: async ({ refreshToken }) => { presented.push(refreshToken); return grant; },
    });
    const messages: string[] = [];
    const summary = await runSchedulerTick({ ...h.deps, onError: (m) => messages.push(m) });
    expect(summary).toMatchObject({ refreshed: 1, failed: 0 });
    expect(presented).toEqual([SEED_RT]);
    const { rows } = await env.owner.query(`select encrypted_credentials from store_connections where id = $1`, [CONN_A]);
    expect((decryptConnectionCredentials(rows[0].encrypted_credentials, h.keyProvider, CONN_A) as Record<string, string>).refreshToken).toBe(grant.refreshToken);
    expect(JSON.stringify(messages)).not.toContain(SEED_RT);
  });
  it('leaves a shop with more than 14 days on its refresh token alone', async () => {
    const h = makeHarness(env);
    await seedIdle(h, 60);
    let called = 0;
    h.deps.tokens = createTokenService({
      db: env.db, keyProvider: h.keyProvider, now: h.clock.now,
      refresh: async () => { called += 1; return grant; },
    });
    expect(await runSchedulerTick(h.deps)).toMatchObject({ refreshed: 0 });
    expect(called).toBe(0);
  });
  it('a final refusal marks the connection errored with the fixed reconnect text and no token in it', async () => {
    const h = makeHarness(env);
    await seedIdle(h, 10);
    h.deps.tokens = createTokenService({
      db: env.db, keyProvider: h.keyProvider, now: h.clock.now,
      refresh: async () => { throw new AuthError(SHOPIFY_RECONNECT_MESSAGE); },
    });
    expect(await runSchedulerTick(h.deps)).toMatchObject({ refreshed: 0, failed: 1 });
    const { rows } = await env.owner.query(`select status, last_error from store_connections where id = $1`, [CONN_A]);
    expect(rows[0]).toEqual({ status: 'error', last_error: 'Shopify no longer accepts this connection. Reconnect the store.' });
    // an errored connection is not picked again on the next tick
    expect(await runSchedulerTick(h.deps)).toMatchObject({ refreshed: 0, failed: 0 });
  });
});
```
(Where a test file already has these imports, keep one copy. `h.deps.queue` is assignable because `SyncDeps.queue` is a plain property.)

Add to `apps/worker/test/sync-handler.test.ts` (inside `describe('handleSyncJob')`; add `vi` is already imported):

```ts
  it('runs the scheduler tick for the schedule-tick job and never treats it as a page payload', async () => {
    const { deps, impl } = setup({ kind: 'done' });
    const tick = vi.fn(async () => ({ connections: 0, enqueued: 0, failed: 0, refreshed: 0 }));
    await handleSyncJob(deps, { name: 'schedule-tick', data: {} }, { ...impl, runSchedulerTick: tick });
    expect(tick).toHaveBeenCalledWith(deps);
    expect(impl.processSyncPage).not.toHaveBeenCalled();
  });
  it('lets a failing tick reject so BullMQ records the failure', async () => {
    const { deps, impl } = setup({ kind: 'done' });
    const tick = vi.fn(async () => {
      throw new Error('db down');
    });
    await expect(
      handleSyncJob(deps, { name: 'schedule-tick', data: {} }, { ...impl, runSchedulerTick: tick }),
    ).rejects.toThrow('db down');
  });
```
Create `apps/worker/test/schedule.test.ts`:

```ts
import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { scheduleSyncTick } from '../src/sync/worker';

describe('scheduleSyncTick', () => {
  it('upserts ONE scheduler with a fixed id every 60 seconds, so restarts do not multiply it', async () => {
    const upsert = vi.fn(async () => undefined);
    const queue = { upsertJobScheduler: upsert } as unknown as Queue;
    await scheduleSyncTick(queue);
    await scheduleSyncTick(queue); // a restart
    expect(upsert).toHaveBeenCalledTimes(2);
    for (const call of upsert.mock.calls) {
      expect(call).toEqual(['sync-tick', { every: 60_000 }, { name: 'schedule-tick', data: {} }]);
    }
  });
});
```

- [ ] **Step 2: Run to see the failures**

Run: `pnpm --filter @erq/sync exec vitest run test/schedule-tick.test.ts` and `pnpm --filter @erq/worker exec vitest run test/sync-handler.test.ts test/schedule.test.ts`
Expected: FAIL (`runSchedulerTick`, `scheduleSyncTick`, `markConnectionError` do not exist).

- [ ] **Step 3: Implement**

In `packages/sync/src/engine/fail.ts` add `markConnectionError` and use it in `failRun` (replace the `if (opts.connectionError) {...}` block):

```ts
/** Flags a connection as errored. Only active, pending and error connections change: a disconnected or demo connection must never become `error` (it would escape the active-shop unique index). */
export async function markConnectionError(
  tx: Tx,
  connectionId: string,
  message: string,
): Promise<void> {
  await tx
    .update(storeConnections)
    .set({ status: 'error', lastError: message })
    .where(
      and(
        eq(storeConnections.id, connectionId),
        inArray(storeConnections.status, ['active', 'pending', 'error']),
      ),
    );
}
```
and in `failRun`: `if (opts.connectionError) await markConnectionError(tx, job.connectionId, message);`.

Create `packages/sync/src/schedule/tick.ts`:

```ts
import { AuthError, type SyncResource } from '@erq/connectors';
import { nowOf, type SyncDeps } from '../engine/deps';
import { markConnectionError, safeMessage } from '../engine/fail';
import { enqueueSync } from '../engine/start';
import { createTokenService } from '../tokens';
import { MAX_CONNECTIONS_PER_TICK } from './cadence';
import { dueResources, planChains, type CursorSnapshot } from './due';

export interface SchedulerDeps extends SyncDeps {
  /** Receives a sanitized message for every failure the tick survived (the worker logs it). */
  onError?: (message: string) => void;
}
export interface TickSummary {
  connections: number;
  enqueued: number;
  failed: number;
  refreshed: number;
}

interface DueRow {
  o_org_id: string;
  o_connection_id: string;
  o_resource: SyncResource;
  o_status: CursorSnapshot['status'];
  o_last_synced_at: Date | null;
  o_last_full_pass_at: Date | null;
  o_updated_at: Date;
}

/**
 * One scheduler tick: start what is due (at most MAX_CONNECTIONS_PER_TICK connections, oldest first) and renew
 * the tokens of idle shops. The duplicate-tick safety net is the cursor lock inside enqueueSync: a second tick
 * finds the cursors running and starts nothing. Never throws for one connection's failure.
 */
export async function runSchedulerTick(deps: SchedulerDeps): Promise<TickSummary> {
  const now = nowOf(deps);
  const summary: TickSummary = { connections: 0, enqueued: 0, failed: 0, refreshed: 0 };
  const report = (connectionId: string, err: unknown): void => {
    summary.failed += 1;
    deps.onError?.(`${connectionId}: ${safeMessage(err)}`);
  };

  const { rows } = await deps.db.pool.query<DueRow>(
    'select * from app_list_due_sync_resources($1, $2)',
    [now, MAX_CONNECTIONS_PER_TICK],
  );
  const groups = new Map<string, { orgId: string; connectionId: string; cursors: CursorSnapshot[] }>();
  for (const r of rows) {
    const group = groups.get(r.o_connection_id) ?? {
      orgId: r.o_org_id,
      connectionId: r.o_connection_id,
      cursors: [],
    };
    group.cursors.push({
      resource: r.o_resource,
      status: r.o_status,
      lastSyncedAt: r.o_last_synced_at,
      lastFullPassAt: r.o_last_full_pass_at,
      updatedAt: r.o_updated_at,
    });
    groups.set(r.o_connection_id, group);
  }
  for (const group of groups.values()) {
    if (summary.connections >= MAX_CONNECTIONS_PER_TICK) break; // the cap holds even if the function returned more
    const due = dueResources(group.cursors, now);
    if (due.length === 0) continue;
    summary.connections += 1;
    const plan = planChains(due);
    for (const [resources, mode] of [
      [plan.incremental, 'incremental'],
      [plan.full, 'full'],
    ] as const) {
      if (resources.length === 0) continue;
      try {
        const started = await enqueueSync(deps, {
          orgId: group.orgId,
          connectionId: group.connectionId,
          resources,
          mode,
        });
        if (started.started) summary.enqueued += 1;
      } catch (err) {
        report(group.connectionId, err);
      }
    }
  }

  const tokens =
    deps.tokens ?? createTokenService({ db: deps.db, keyProvider: deps.keyProvider, now: deps.now });
  const idle = await deps.db.pool.query<{ o_org_id: string; o_connection_id: string }>(
    'select * from app_list_idle_refresh_connections($1, $2)',
    [now, MAX_CONNECTIONS_PER_TICK],
  );
  for (const r of idle.rows.slice(0, MAX_CONNECTIONS_PER_TICK)) {
    try {
      await tokens.ensureFresh({ orgId: r.o_org_id, connectionId: r.o_connection_id });
      summary.refreshed += 1;
    } catch (err) {
      if (err instanceof AuthError) {
        // Final: only a reconnect helps. The fixed text goes through safeMessage like every stored error.
        const message = safeMessage(err);
        try {
          await deps.db.withTenant(r.o_org_id, (tx) =>
            markConnectionError(tx, r.o_connection_id, message),
          );
        } catch (markErr) {
          report(r.o_connection_id, markErr);
          continue;
        }
      }
      report(r.o_connection_id, err);
    }
  }
  return summary;
}
```
(Export from `packages/sync/src/index.ts`: `export * from './schedule/tick';`.)

`apps/worker/src/sync/handler.ts` (whole file after the change):

```ts
import { UnrecoverableError } from 'bullmq';
import {
  parseSyncPageJob,
  processSyncPage,
  resumeStalledRuns,
  runSchedulerTick,
  type SchedulerDeps,
} from '@erq/sync';

const STALL_AFTER_MS = 10 * 60 * 1000;

/** The queue-facing logic: validate, process one page, enqueue what comes next; or run a scheduled job. */
export async function handleSyncJob(
  deps: SchedulerDeps,
  job: { name: string; data: unknown },
  impl: {
    processSyncPage: typeof processSyncPage;
    resumeStalledRuns: typeof resumeStalledRuns;
    runSchedulerTick?: typeof runSchedulerTick;
  } = { processSyncPage, resumeStalledRuns },
): Promise<void> {
  if (job.name === 'schedule-tick') {
    await (impl.runSchedulerTick ?? runSchedulerTick)(deps);
    return;
  }
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
    case 'next':
      await deps.queue.enqueue(result.job);
      break;
    case 'delayed':
      await deps.queue.enqueue(data, { delayMs: result.delayMs });
      break;
    case 'done':
      if (result.followUp) await deps.queue.enqueue(result.followUp);
      break;
    case 'failed':
      break;
  }
}
```

`apps/worker/src/sync/worker.ts`: change `deps: SyncDeps` to `SchedulerDeps` in `createSyncWorker` and add

```ts
/** Every 60 seconds the ticker starts what is due. The fixed scheduler id keeps restarts from multiplying it. */
export async function scheduleSyncTick(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    'sync-tick',
    { every: SYNC_TICK_EVERY_MS },
    { name: 'schedule-tick', data: {} },
  );
}
```
(import `SYNC_TICK_EVERY_MS` and `type SchedulerDeps` from `@erq/sync`). The `failed` listener already ignores jobs whose name is not `page`.

`apps/worker/src/main.ts`: type the deps `const deps: SchedulerDeps = { ..., onError: (message) => log.warn({ err: message }, 'sync tick problem') }` and call `await scheduleSyncTick(syncQueue);` right after `await scheduleResumeStalled(syncQueue);`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd "C:/Users/OK COMPUTER/Desktop/WorkAgentic/eRetailQuery" && pnpm turbo run build --filter=@erq/db --filter=@erq/connectors --filter=@erq/shared --filter=@erq/sync --concurrency=1
pnpm --filter @erq/sync exec vitest run test/schedule-tick.test.ts
pnpm --filter @erq/sync exec vitest run test/engine.test.ts
pnpm --filter @erq/worker exec vitest run test/sync-handler.test.ts test/schedule.test.ts
pnpm --filter @erq/sync typecheck && pnpm --filter @erq/worker typecheck
```
Expected: PASS. Not run here (no Redis): `scheduleSyncTick` against a real BullMQ queue and the tick job running inside a real worker; listed in the first-install checklist.

- [ ] **Step 5: Commit**

```bash
git add packages/sync apps/worker
git commit -m "feat(sync): poll connected shops on a tiered cadence with a one-minute ticker

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---
## Part C: Webhook nudges, link-up and status

### Task 7: Webhook subscriptions, nudges and the daily re-register

**Files:**
- Modify: `packages/connectors/src/shopify/webhooks.ts`, `packages/connectors/src/testing/fake-shopify.ts`
- Modify: `packages/sync/src/engine/fail.ts` (constant), `packages/sync/src/schedule/tick.ts`
- Create: `apps/worker/src/webhooks/nudge.ts`, `apps/worker/src/webhooks/reconcile.ts`
- Modify: `apps/worker/src/webhooks/handler.ts`, `apps/worker/src/sync/connectors.ts` (export `shopifyApiVersion`), `apps/worker/src/main.ts`, `apps/api/src/connections/connections.service.ts` (use the shared constant)
- Test: `packages/connectors/test/shopify-webhooks.test.ts` (update, add), `apps/worker/test/webhook-handler.test.ts` (update two), `apps/worker/test/webhook-nudge.test.ts` (create), `apps/worker/test/webhook-reconcile.test.ts` (create), `packages/sync/test/schedule-tick.test.ts` (add), `apps/api/test/connections.test.ts` (update one)

**Interfaces:**
- Consumes (Tasks 3, 5, 6): `TokenService`, `enqueueSync`, `JobQueue`, `runSchedulerTick`, `SchedulerDeps`.
- Produces:
  - `SHOPIFY_WEBHOOK_TOPICS = ['app/uninstalled', 'products/update', 'inventory_levels/update'] as const`; `SHOPIFY_FUTURE_DATA_WEBHOOK_TOPICS` without those two.
  - `WEBHOOK_SETUP_FAILED_MESSAGE = 'Webhook setup failed. Reconnect to retry.'` (`@erq/sync`, next to `IMPORT_NOT_STARTED_MESSAGE`).
  - `FakeShopify({ rejectTopics?: Set<string> })`: a rejected topic answers `userErrors` (not "already taken") and is not stored.
  - worker `nudge.ts`: `NUDGE_DEBOUNCE_MS = 60_000`; `nudgeResourceFor(topic: string): SyncResource | null`; `type NudgeResult = 'started' | 'dropped'`; `nudgeSync(deps: { db: TenantDb; queue: JobQueue; now: () => Date }, args: { orgId: string; connectionId: string; resource: SyncResource }): Promise<NudgeResult>`.
  - worker `reconcile.ts`: `createWebhookReconciler(deps: { db: TenantDb; tokens: TokenService; http: HttpClient; callbackUrl: string; apiVersion: string }): (args: { orgId: string; connectionId: string }) => Promise<void>`.
  - `WebhookHandlerDeps.sync?: { queue: JobQueue }` (without it a nudge topic ends `ignored`).
  - `SchedulerDeps.reconcileWebhooks?: (args: { orgId: string; connectionId: string }) => Promise<void>`, called once per connection on the tick that starts its daily products full pass.
- Rules: a nudge is dropped (event still ends `processed`) unless the connection is `active`, all four resources have completed once, no cursor of the connection is running, the nudged resource did not complete within the last 60 s, and (when it failed) its last attempt was at least 60 s ago. Otherwise it calls `enqueueSync(..., { resources: [resource], mode: 'incremental' })` (inventory is already a full pass). The event payload is `{}` before and after.

- [ ] **Step 1: Write the failing tests**

Update `packages/connectors/test/shopify-webhooks.test.ts`: replace the first test (`registers only app/uninstalled by default...`) and add the others in the same `describe('registerWebhooks')`:

```ts
  it('registers the three subscribed topics by default, once each, and is idempotent on a second call', async () => {
    const http = new FakeShopify();
    const first = await registerWebhooks(http, p);
    const topics = ['app/uninstalled', 'products/update', 'inventory_levels/update'];
    expect(first.failed).toEqual([]);
    expect(first.registered).toEqual(topics);
    expect([...SHOPIFY_WEBHOOK_TOPICS]).toEqual(topics);
    expect([...http.subscriptions.keys()]).toEqual(topics);
    expect(http.subscriptions.get('products/update')).toBe(p.callbackUrl);
    expect(http.requests).toHaveLength(3);
    const second = await registerWebhooks(http, p);
    expect(second.failed).toEqual([]);
    expect(second.registered).toEqual(topics); // "already taken" counts as registered
  });
  it('never subscribes to order, refund or customer topics by default (protected customer data)', () => {
    for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
      expect(topic).not.toMatch(/^(orders|refunds|customers)\//);
    }
    for (const topic of SHOPIFY_FUTURE_DATA_WEBHOOK_TOPICS) {
      expect(SHOPIFY_WEBHOOK_TOPICS as readonly string[]).not.toContain(topic);
    }
  });
  it('reports a rejected subscription as failed and still registers the others', async () => {
    const http = new FakeShopify({ rejectTopics: new Set(['products/update']) });
    const res = await registerWebhooks(http, p);
    expect(res.failed).toEqual(['products/update']);
    expect(res.registered).toEqual(['app/uninstalled', 'inventory_levels/update']);
    expect([...http.subscriptions.keys()]).toEqual(['app/uninstalled', 'inventory_levels/update']);
  });
  it('keeps the subscription mutation tiny: one object, no connection, no pagination', async () => {
    const http = new FakeShopify();
    await registerWebhooks(http, { ...p, topics: ['products/update'] });
    const { query } = JSON.parse(http.requests[0]!.body!) as { query: string };
    expect(query).not.toMatch(/\bfirst\b|nodes|edges|pageInfo/);
    expect(query.length).toBeLessThan(400);
  });
```

In `apps/api/test/connections.test.ts`, change the subscription assertions in the first callback test to:

```ts
      expect(fake.subscriptions.get('app/uninstalled')).toBe('http://api.test/webhooks/shopify');
      // Only non-customer topics; order, refund and customer topics wait for protected customer data approval.
      expect([...fake.subscriptions.keys()]).toEqual([
        'app/uninstalled',
        'products/update',
        'inventory_levels/update',
      ]);
```

In `apps/worker/test/webhook-handler.test.ts`: in `defers data topics for 1b-3 without keeping their payload...` remove `'products/update'` and `'inventory_levels/update'` from the list (keep the other six), and in `reclaims an event stuck in processing for over 10 minutes but not a fresh one` use the topic `'orders/updated'` instead of `'products/update'` (the intent is the claim rule, and that topic is still deferred).

Create `apps/worker/test/webhook-nudge.test.ts`:

```ts
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConnectionsApi, createTenantDb, type ConnectionsApi, type TenantDb } from '@erq/db';
import { startTestDatabase, type TestDatabase } from '@erq/db/testing';
import { InMemoryJobQueue, type JobQueue, type SyncPageJob } from '@erq/sync';
import { processWebhookEvent } from '../src/webhooks/handler';
import { NUDGE_DEBOUNCE_MS, nudgeResourceFor } from '../src/webhooks/nudge';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-08T12:00:00.000Z');
const RESOURCES = ['locations', 'products', 'inventory', 'orders'];
let tdb: TestDatabase;
let owner: Pool;
let app: Pool;
let db: TenantDb;
let connections: ConnectionsApi;
let queue: InMemoryJobQueue;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  app = new Pool({ connectionString: tdb.appUrl });
  db = createTenantDb(tdb.appUrl);
  connections = createConnectionsApi(app);
}, 120_000);
afterAll(async () => {
  await db?.close();
  await app?.end();
  await owner?.end();
  await tdb?.stop();
});

let seq = 0;
beforeEach(async () => {
  queue = new InMemoryJobQueue();
  await owner.query(`truncate orgs cascade`);
  await owner.query(`insert into orgs (id, name, slug) values ($1, 'Org', 'org')`, [ORG]);
  for (const [id, shop] of [[ORG, 'main.myshopify.com'], [OTHER, 'other.myshopify.com']]) {
    await owner.query(
      `insert into store_connections (id, org_id, platform, external_account_id, status, encrypted_credentials) values ($1, $2, 'shopify', $3, 'active', 'ciphertext')`,
      [id, ORG, shop],
    );
  }
});

type Per = Record<string, { status?: string; agoSec?: number | null; updatedAgoSec?: number }>;
async function seedCursors(connection: string, o: { agoSec?: number; per?: Per; only?: string[] } = {}) {
  for (const resource of o.only ?? RESOURCES) {
    const p = o.per?.[resource] ?? {};
    const ago = p.agoSec === undefined ? (o.agoSec ?? 3600) : p.agoSec;
    await owner.query(
      `insert into sync_cursors (org_id, store_connection_id, resource, status, last_synced_at, updated_at) values ($1, $2, $3, $4, $5, $6)`,
      [
        ORG, connection, resource, p.status ?? 'complete',
        ago === null ? null : new Date(NOW.getTime() - ago * 1000),
        new Date(NOW.getTime() - (p.updatedAgoSec ?? ago ?? 0) * 1000),
      ],
    );
  }
}
async function addEvent(topic: string, connection = ORG) {
  const { rows } = await owner.query(
    `insert into webhook_events (org_id, store_connection_id, topic, external_event_id, payload, status) values ($1, $2, $3, $4, '{"secret":"payload"}', 'received') returning id`,
    [ORG, connection, topic, `evt-${++seq}`],
  );
  return rows[0].id as string;
}
const handle = (eventId: string, sync: { queue: JobQueue } | undefined = { queue }) =>
  processWebhookEvent({ db, connections, sync, now: () => NOW }, { orgId: ORG, eventId });
const event = async (id: string) =>
  (await owner.query(`select status, payload, error from webhook_events where id = $1`, [id])).rows[0];
const jobs = (): SyncPageJob[] => {
  const out: SyncPageJob[] = [];
  for (let j = queue.take(); j; j = queue.take()) out.push(j.job);
  return out;
};
const runs = async () => (await owner.query(`select connection_id, type from sync_runs`)).rows;

describe('nudgeResourceFor', () => {
  it('maps only the two subscribed topics, and never reads the prototype', () => {
    expect(nudgeResourceFor('products/update')).toBe('products');
    expect(nudgeResourceFor('inventory_levels/update')).toBe('inventory');
    for (const topic of ['orders/updated', 'app/uninstalled', 'products/create', 'toString', '__proto__', '']) {
      expect(nudgeResourceFor(topic)).toBeNull();
    }
  });
});

describe('a nudge', () => {
  it('starts an incremental sync of exactly the nudged resource, closes the event and scrubs its payload', async () => {
    await seedCursors(ORG);
    const id = await addEvent('products/update');
    expect(await handle(id)).toBe('processed');
    const [job, ...rest] = jobs();
    expect(rest).toEqual([]);
    expect(job).toMatchObject({ orgId: ORG, connectionId: ORG, resource: 'products' });
    expect(job!.then).toBeUndefined();
    expect(await runs()).toEqual([{ connection_id: ORG, type: 'incremental' }]);
    expect(await event(id)).toMatchObject({ status: 'processed', payload: {} });
  });
  it('maps inventory_levels/update to the inventory resource', async () => {
    await seedCursors(ORG);
    expect(await handle(await addEvent('inventory_levels/update'))).toBe('processed');
    expect(jobs()[0]).toMatchObject({ resource: 'inventory' });
  });
  it('turns a burst of 20 events into ONE sync', async () => {
    await seedCursors(ORG);
    const outcomes: string[] = [];
    for (let i = 0; i < 20; i += 1) outcomes.push(await handle(await addEvent('inventory_levels/update')));
    expect(new Set(outcomes)).toEqual(new Set(['processed']));
    expect(jobs()).toHaveLength(1);
    expect(await runs()).toHaveLength(1);
  });
  it('is debounced for 60 seconds after the resource last completed, starting again at exactly 60 s', async () => {
    expect(NUDGE_DEBOUNCE_MS).toBe(60_000);
    await seedCursors(ORG, { per: { products: { agoSec: 59 } } });
    expect(await handle(await addEvent('products/update'))).toBe('processed');
    expect(jobs()).toEqual([]);
    await owner.query('delete from sync_cursors');
    await seedCursors(ORG, { per: { products: { agoSec: 60 } } });
    await handle(await addEvent('products/update'));
    expect(jobs()).toHaveLength(1);
  });
  it('is dropped while ANY cursor of the connection is running', async () => {
    await seedCursors(ORG, { per: { orders: { status: 'running' } } });
    expect(await handle(await addEvent('products/update'))).toBe('processed');
    expect(jobs()).toEqual([]);
    expect(await runs()).toEqual([]);
  });
  it.each(['pending', 'error', 'disconnected', 'demo'])('is dropped for a %s connection', async (status) => {
    await seedCursors(ORG);
    await owner.query(`update store_connections set status = $2 where id = $1`, [ORG, status]);
    const id = await addEvent('products/update');
    expect(await handle(id)).toBe('processed');
    expect(jobs()).toEqual([]);
    expect((await event(id)).status).toBe('processed');
  });
  it('is dropped for a connection that never finished its first import (a nudge never starts a backfill)', async () => {
    await handle(await addEvent('products/update')); // no cursors at all
    await seedCursors(ORG, { only: ['locations', 'products', 'inventory'] });
    await handle(await addEvent('products/update'));
    expect(jobs()).toEqual([]);
    expect(await runs()).toEqual([]);
  });
  it('waits 60 s after a FAILED attempt of the nudged resource', async () => {
    await seedCursors(ORG, { per: { products: { status: 'failed', agoSec: 7200, updatedAgoSec: 30 } } });
    await handle(await addEvent('products/update'));
    expect(jobs()).toEqual([]);
    await owner.query('delete from sync_cursors');
    await seedCursors(ORG, { per: { products: { status: 'failed', agoSec: 7200, updatedAgoSec: 61 } } });
    await handle(await addEvent('products/update'));
    expect(jobs()).toHaveLength(1);
  });
  it("only touches the event's own connection", async () => {
    await seedCursors(ORG);
    await seedCursors(OTHER);
    await handle(await addEvent('products/update', OTHER));
    expect(jobs()[0]).toMatchObject({ connectionId: OTHER });
    expect(await runs()).toEqual([{ connection_id: OTHER, type: 'incremental' }]);
  });
  it('ends ignored (never throws) when no sync queue is configured', async () => {
    await seedCursors(ORG);
    const id = await addEvent('products/update');
    expect(await handle(id, undefined)).toBe('ignored');
    expect((await event(id)).status).toBe('ignored');
    expect(await runs()).toEqual([]);
  });
  it('a queue failure fails the event with a sanitized message, leaves no running cursor, and the retry works', async () => {
    await seedCursors(ORG);
    const broken: JobQueue = {
      enqueue: async () => {
        throw new Error('redis down shpat_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE');
      },
    };
    const id = await addEvent('products/update');
    await expect(handle(id, { queue: broken })).rejects.toThrow('redis down');
    const failed = await event(id);
    expect(failed.status).toBe('failed');
    expect(failed.error).not.toMatch(/shpat_/);
    const cursor = (await owner.query(`select status from sync_cursors where store_connection_id = $1 and resource = 'products'`, [ORG])).rows[0];
    expect(cursor.status).toBe('failed'); // not 'running': enqueueSync freed it
    await owner.query(`delete from sync_cursors`);
    await seedCursors(ORG);
    expect(await handle(id)).toBe('processed'); // the failed event is claimable again
    expect(jobs()).toHaveLength(1);
  });
  it('still parks the other data topics as deferred, with no job', async () => {
    await seedCursors(ORG);
    for (const topic of ['orders/updated', 'orders/create', 'refunds/create', 'products/create', 'products/delete']) {
      expect(await handle(await addEvent(topic))).toBe('deferred');
    }
    expect(jobs()).toEqual([]);
  });
});
```

Create `apps/worker/test/webhook-reconcile.test.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encryptConnectionCredentials } from '@erq/connectors';
import { FakeShopify } from '@erq/connectors/testing';
import { createTenantDb, type TenantDb } from '@erq/db';
import { startTestDatabase, type TestDatabase } from '@erq/db/testing';
import { EnvKeyProvider } from '@erq/shared';
import { WEBHOOK_SETUP_FAILED_MESSAGE, createTokenService } from '@erq/sync';
import { createWebhookReconciler } from '../src/webhooks/reconcile';

const ORG = '11111111-1111-4111-8111-111111111111';
const URL_ = 'http://api.test/webhooks/shopify';
const TOPICS = ['app/uninstalled', 'products/update', 'inventory_levels/update'];
let tdb: TestDatabase;
let owner: Pool;
let db: TenantDb;
const keyProvider = new EnvKeyProvider('k1', { k1: randomBytes(32).toString('base64') });

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  db = createTenantDb(tdb.appUrl);
}, 120_000);
afterAll(async () => {
  await db?.close();
  await owner?.end();
  await tdb?.stop();
});
beforeEach(async () => {
  await owner.query(`truncate orgs cascade`);
  await owner.query(`insert into orgs (id, name, slug) values ($1, 'Org', 'org')`, [ORG]);
  await owner.query(
    `insert into store_connections (id, org_id, platform, external_account_id, status, encrypted_credentials) values ($1, $1, 'shopify', 'main.myshopify.com', 'active', $2)`,
    [ORG, encryptConnectionCredentials({ accessToken: 'shpat_reconcile_1' }, keyProvider, ORG)],
  );
});
const reconciler = (http: FakeShopify) =>
  createWebhookReconciler({
    db,
    tokens: createTokenService({ db, keyProvider }),
    http,
    callbackUrl: URL_,
    apiVersion: '2025-07',
  });
const lastError = async () =>
  (await owner.query(`select last_error from store_connections where id = $1`, [ORG])).rows[0].last_error;

describe('createWebhookReconciler', () => {
  it('registers the subscribed topics with the stored token (in a header, never the body) and is idempotent', async () => {
    const http = new FakeShopify();
    await reconciler(http)({ orgId: ORG, connectionId: ORG });
    await reconciler(http)({ orgId: ORG, connectionId: ORG });
    expect([...http.subscriptions.keys()]).toEqual(TOPICS);
    expect(http.requests[0]!.headers?.['X-Shopify-Access-Token']).toBe('shpat_reconcile_1');
    expect(http.requests.map((r) => r.body).join('')).not.toContain('shpat_reconcile_1');
    expect(await lastError()).toBeNull();
  });
  it('records a rejected subscription on the connection, keeps polling, and never overwrites another warning', async () => {
    const rejecting = new FakeShopify({ rejectTopics: new Set(['products/update']) });
    await reconciler(rejecting)({ orgId: ORG, connectionId: ORG });
    expect(await lastError()).toBe(WEBHOOK_SETUP_FAILED_MESSAGE);
    await owner.query(`update store_connections set last_error = 'Something else' where id = $1`, [ORG]);
    await reconciler(rejecting)({ orgId: ORG, connectionId: ORG });
    expect(await lastError()).toBe('Something else');
  });
  it('clears only its own warning once every topic is registered', async () => {
    await owner.query(`update store_connections set last_error = $2 where id = $1`, [ORG, WEBHOOK_SETUP_FAILED_MESSAGE]);
    await reconciler(new FakeShopify())({ orgId: ORG, connectionId: ORG });
    expect(await lastError()).toBeNull();
    await owner.query(`update store_connections set last_error = 'Something else' where id = $1`, [ORG]);
    await reconciler(new FakeShopify())({ orgId: ORG, connectionId: ORG });
    expect(await lastError()).toBe('Something else');
  });
  it('does nothing for a connection that is not active or has no credentials', async () => {
    const http = new FakeShopify();
    await owner.query(`update store_connections set status = 'error' where id = $1`, [ORG]);
    await reconciler(http)({ orgId: ORG, connectionId: ORG });
    await owner.query(`update store_connections set status = 'active', encrypted_credentials = null where id = $1`, [ORG]);
    await reconciler(http)({ orgId: ORG, connectionId: ORG });
    expect(http.requests).toEqual([]);
  });
});
```

Add to `packages/sync/test/schedule-tick.test.ts` inside `describe('runSchedulerTick')`:

```ts
  it('re-registers webhooks only on the tick that starts the daily products pass, and a failure there does not stop the sync', async () => {
    const h = makeHarness(env);
    const calls: { orgId: string; connectionId: string }[] = [];
    await seed(CONN_A, ORG_A, { agoMin: 20, fullPassAgoMin: 60 }); // incremental only
    await runSchedulerTick({ ...h.deps, reconcileWebhooks: async (a) => void calls.push(a) });
    expect(calls).toEqual([]);

    await resetSync(env);
    await seed(CONN_A, ORG_A, { agoMin: 20, fullPassAgoMin: null }); // the daily pass is due
    const messages: string[] = [];
    const summary = await runSchedulerTick({
      ...h.deps,
      reconcileWebhooks: async (a) => {
        calls.push(a);
        throw new Error('shopify down shpat_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE');
      },
      onError: (m) => messages.push(m),
    });
    expect(calls).toEqual([{ orgId: ORG_A, connectionId: CONN_A }]);
    expect(summary).toMatchObject({ failed: 1, enqueued: 2 }); // the sync chains still started
    expect(messages[0]).not.toContain('shpat_');
  });
```

- [ ] **Step 2: Run to see the failures**

Run: `pnpm --filter @erq/connectors exec vitest run test/shopify-webhooks.test.ts`, `pnpm --filter @erq/worker exec vitest run test/webhook-nudge.test.ts test/webhook-reconcile.test.ts test/webhook-handler.test.ts`, `pnpm --filter @erq/sync exec vitest run test/schedule-tick.test.ts`
Expected: FAIL (topics, `rejectTopics`, `nudge.ts`, `reconcile.ts`, `reconcileWebhooks` do not exist).

- [ ] **Step 3: Implement the connector side and the constant**

`packages/connectors/src/shopify/webhooks.ts`: replace the two topic lists and add the cost note above `MUTATION`:

```ts
/**
 * Topics subscribed on connect and by the scheduler's daily re-register. Only topics whose payload carries no
 * customer data: a product edit and a stock change only NUDGE a sync (the worker never reads their payload).
 * Order, refund and customer topics need Shopify's protected customer data approval and are not subscribed, so
 * orders are polled every 15 minutes instead.
 */
export const SHOPIFY_WEBHOOK_TOPICS = [
  'app/uninstalled',
  'products/update',
  'inventory_levels/update',
] as const;

/** Order, refund and other product topics: NOT subscribed (see above). */
export const SHOPIFY_FUTURE_DATA_WEBHOOK_TOPICS = [
  'orders/create',
  'orders/updated',
  'orders/cancelled',
  'refunds/create',
  'products/create',
  'products/delete',
] as const;
```
and above `const MUTATION`: `// Query cost note: one mutation with one input object and a two-field userErrors list, no connection and no pagination, so its requested cost is about 10 points, far under Shopify's 1000-point cap. Sent once per topic (three per call).`

`packages/connectors/src/testing/fake-shopify.ts`: add `private readonly rejectTopics: Set<string>;` with constructor option `rejectTopics?: Set<string>` (`this.rejectTopics = opts.rejectTopics ?? new Set()`), and in the graphql branch right after `const topic = ...`:

```ts
      if (this.rejectTopics.has(topic)) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            data: {
              webhookSubscriptionCreate: {
                userErrors: [{ field: ['topic'], message: 'This topic requires approval' }],
              },
            },
          }),
        };
      }
```
`packages/sync/src/engine/fail.ts`: add

```ts
/** Stored on a connection whose webhook subscriptions were rejected (connect and the daily re-register); polling still covers it. */
export const WEBHOOK_SETUP_FAILED_MESSAGE = 'Webhook setup failed. Reconnect to retry.';
```
and in `apps/api/src/connections/connections.service.ts` import it from `@erq/sync` and use it in place of the literal in `completeInstall` (`const lastError = !webhooksOk ? WEBHOOK_SETUP_FAILED_MESSAGE : IMPORT_NOT_STARTED_MESSAGE;`).

`packages/sync/src/schedule/tick.ts`: add to `SchedulerDeps`

```ts
  /** Re-registers the webhook subscriptions of one connection (idempotent). Called once per connection per daily products pass. */
  reconcileWebhooks?: (args: { orgId: string; connectionId: string }) => Promise<void>;
```
and in the group loop, right after `const plan = planChains(due);`:

```ts
    if (plan.full.length > 0 && deps.reconcileWebhooks) {
      // Nothing records which topics a connection registered; registering is idempotent, so doing it on the
      // daily pass heals shops connected before a topic existed, at most once a day per connection.
      try {
        await deps.reconcileWebhooks({ orgId: group.orgId, connectionId: group.connectionId });
      } catch (err) {
        report(group.connectionId, err);
      }
    }
```

- [ ] **Step 4: Implement the worker side**

`apps/worker/src/webhooks/nudge.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import { SYNC_RESOURCES, type SyncResource } from '@erq/connectors';
import { storeConnections, syncCursors, type TenantDb } from '@erq/db';
import { enqueueSync, type JobQueue } from '@erq/sync';

/** A burst of events becomes at most one sync per resource per minute. */
export const NUDGE_DEBOUNCE_MS = 60_000;

const NUDGE_TOPICS: Readonly<Record<string, SyncResource>> = {
  'products/update': 'products',
  'inventory_levels/update': 'inventory',
};

export function nudgeResourceFor(topic: string): SyncResource | null {
  return Object.hasOwn(NUDGE_TOPICS, topic) ? (NUDGE_TOPICS[topic] as SyncResource) : null;
}

export type NudgeResult = 'started' | 'dropped';

/**
 * Starts an incremental sync of one resource because Shopify said it changed. The webhook carries no data we
 * use: the sync re-reads from Shopify. The gate is a database check, not a queue job id: enqueueSync commits the
 * run BEFORE it enqueues, so a duplicate job id would drop the job and leave a committed run with no job.
 * Polling is the safety net, so every "dropped" costs a delay, never wrong data.
 */
export async function nudgeSync(
  deps: { db: TenantDb; queue: JobQueue; now: () => Date },
  args: { orgId: string; connectionId: string; resource: SyncResource },
): Promise<NudgeResult> {
  const now = deps.now();
  const go = await deps.db.withTenant(args.orgId, async (tx) => {
    const [connection] = await tx
      .select({ status: storeConnections.status })
      .from(storeConnections)
      .where(eq(storeConnections.id, args.connectionId));
    if (!connection || connection.status !== 'active') return false;
    const cursors = await tx
      .select({
        resource: syncCursors.resource,
        status: syncCursors.status,
        lastSyncedAt: syncCursors.lastSyncedAt,
        updatedAt: syncCursors.updatedAt,
      })
      .from(syncCursors)
      .where(and(eq(syncCursors.storeConnectionId, args.connectionId)));
    if (cursors.some((c) => c.status === 'running')) return false;
    // The first import belongs to connect and Sync now, never to a nudge.
    const complete = SYNC_RESOURCES.every((r) =>
      cursors.some((c) => c.resource === r && c.lastSyncedAt !== null),
    );
    if (!complete) return false;
    const own = cursors.find((c) => c.resource === args.resource);
    if (!own || own.lastSyncedAt === null) return false;
    // A failed resource counts from its last attempt, so a flood of events cannot hammer it.
    const reference =
      own.status === 'failed'
        ? Math.max(own.lastSyncedAt.getTime(), own.updatedAt.getTime())
        : own.lastSyncedAt.getTime();
    return now.getTime() - reference >= NUDGE_DEBOUNCE_MS;
  });
  if (!go) return 'dropped';
  const started = await enqueueSync(
    { db: deps.db, queue: deps.queue, now: deps.now },
    {
      orgId: args.orgId,
      connectionId: args.connectionId,
      resources: [args.resource],
      mode: 'incremental', // inventory is already a full pass: the connector ignores the filter
    },
  );
  return started.started ? 'started' : 'dropped';
}
```

`apps/worker/src/webhooks/reconcile.ts`:

```ts
import { and, eq, isNull } from 'drizzle-orm';
import { registerWebhooks, type HttpClient } from '@erq/connectors';
import { storeConnections, type TenantDb } from '@erq/db';
import { WEBHOOK_SETUP_FAILED_MESSAGE, type TokenService } from '@erq/sync';

export interface WebhookReconcilerDeps {
  db: TenantDb;
  tokens: TokenService;
  http: HttpClient;
  callbackUrl: string;
  apiVersion: string;
}

/**
 * Registers the subscribed topics for one active connection (idempotent: "already taken" counts as registered).
 * A rejected topic stores the existing connection warning, only when nothing else is stored, and the connection
 * keeps polling. A full success clears the warning only when it is exactly that text. Errors propagate to the
 * ticker, which reports them without stopping the tick.
 */
export function createWebhookReconciler(
  deps: WebhookReconcilerDeps,
): (args: { orgId: string; connectionId: string }) => Promise<void> {
  return async ({ orgId, connectionId }) => {
    const connection = await deps.db.withTenant(orgId, async (tx) => {
      const [row] = await tx
        .select({ shop: storeConnections.externalAccountId, status: storeConnections.status })
        .from(storeConnections)
        .where(eq(storeConnections.id, connectionId));
      return row ?? null;
    });
    if (!connection || connection.status !== 'active') return;
    const credentials = (await deps.tokens.ensureFresh({ orgId, connectionId })) as {
      accessToken?: unknown;
    } | null;
    if (!credentials || typeof credentials.accessToken !== 'string') return;
    const result = await registerWebhooks(deps.http, {
      shop: connection.shop,
      accessToken: credentials.accessToken,
      callbackUrl: deps.callbackUrl,
      apiVersion: deps.apiVersion,
    });
    await deps.db.withTenant(orgId, async (tx) => {
      if (result.failed.length > 0) {
        await tx
          .update(storeConnections)
          .set({ lastError: WEBHOOK_SETUP_FAILED_MESSAGE })
          .where(and(eq(storeConnections.id, connectionId), isNull(storeConnections.lastError)));
      } else {
        await tx
          .update(storeConnections)
          .set({ lastError: null })
          .where(
            and(
              eq(storeConnections.id, connectionId),
              eq(storeConnections.lastError, WEBHOOK_SETUP_FAILED_MESSAGE),
            ),
          );
      }
    });
  };
}
```

`apps/worker/src/webhooks/handler.ts`: import `type JobQueue` from `@erq/sync` and `nudgeResourceFor, nudgeSync` from `./nudge`; add `sync?: { queue: JobQueue }` to `WebhookHandlerDeps`; remove `'products/update'` and `'inventory_levels/update'` from `DATA_TOPICS` (and update its comment: those two are nudges); give `setStatus` an optional trailing `scrub = false` parameter with `...(status === 'deferred' || scrub ? { payload: {} } : {})`; and add, immediately after the `shop/redact` block and before `return await deps.db.withTenant(...)`:

```ts
    const nudgeResource = nudgeResourceFor(topic);
    if (nudgeResource !== null) {
      // A product edit or a stock change only starts a sync; nothing from the payload is used or kept.
      if (!deps.sync) {
        await deps.db.withTenant(orgId, (tx) => setStatus(tx, orgId, eventId, 'ignored', now(), null, true));
        return 'ignored';
      }
      await nudgeSync(
        { db: deps.db, queue: deps.sync.queue, now },
        { orgId, connectionId: storeConnectionId, resource: nudgeResource },
      );
      await deps.db.withTenant(orgId, (tx) => setStatus(tx, orgId, eventId, 'processed', now(), null, true));
      return 'processed';
    }
```
(If `nudgeSync` throws, the existing `catch` marks the event `failed` with a sanitized message and rethrows, so BullMQ retries.)

`apps/worker/src/sync/connectors.ts`: `export function shopifyApiVersion(...)` (add `export`).

`apps/worker/src/main.ts`: in the sync block build `const tokens = createWorkerTokenService(...)` once, and (when `API_PUBLIC_URL` is set)

```ts
    const callbackUrl = process.env.API_PUBLIC_URL
      ? `${process.env.API_PUBLIC_URL.replace(/\/+$/, '')}/webhooks/shopify`
      : undefined;
    // deps: add
    //   reconcileWebhooks: callbackUrl
    //     ? createWebhookReconciler({ db, tokens, http: createFetchHttpClient(), callbackUrl,
    //         apiVersion: shopifyApiVersion(process.env) ?? SHOPIFY_API_VERSION })
    //     : undefined,
```
and in the webhook block pass the sync queue to the handler:
`handle: (job) => processWebhookEvent({ db, connections, sync: syncQueue ? { queue: new BullMqJobQueue(syncQueue) } : undefined }, job),`
(import `createFetchHttpClient`, `SHOPIFY_API_VERSION` from `@erq/connectors`, `createWebhookReconciler`, `shopifyApiVersion`).

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd "C:/Users/OK COMPUTER/Desktop/WorkAgentic/eRetailQuery" && pnpm turbo run build --filter=@erq/db --filter=@erq/connectors --filter=@erq/shared --filter=@erq/sync --concurrency=1
pnpm --filter @erq/connectors exec vitest run test/shopify-webhooks.test.ts
pnpm --filter @erq/sync exec vitest run test/schedule-tick.test.ts
pnpm --filter @erq/worker exec vitest run test/webhook-nudge.test.ts test/webhook-reconcile.test.ts test/webhook-handler.test.ts
pnpm --filter @erq/api exec vitest run test/connections.test.ts
pnpm --filter @erq/worker typecheck && pnpm --filter @erq/api typecheck
```
Expected: PASS. Not run here: the BullMQ webhook queue with the nudge and a real Shopify accepting the two new subscriptions (checklist).

- [ ] **Step 6: Commit**

```bash
git add packages apps
git commit -m "feat(webhooks): subscribe to product and stock updates and use them to nudge syncs

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Order-line link-up pass

**Files:**
- Create: `packages/sync/src/linkup.ts`
- Modify: `packages/sync/src/engine/process.ts`, `packages/sync/src/index.ts`
- Test: `packages/sync/test/linkup.test.ts` (create), `packages/sync/test/engine.test.ts` (add one `describe`)

**Interfaces:**
- Consumes: `loadCostRows`, `snapshotUnitCogs`, `toOrgDate` (`packages/sync/src/cogs.ts`), `skuChannelListings`, `orderLines`, `orders`, `orgs`.
- Produces: `LINKUP_BATCH_SIZE = 500`, `LINKUP_MAX_BATCHES = 200`, `linkOrderLines(db: Pick<TenantDb, 'withTenant'>, args: { orgId: string; connectionId: string }, opts?: { batchSize?: number; maxBatches?: number }): Promise<{ linked: number }>`.
- Rules: candidates are lines of THIS connection's orders with `sku_id IS NULL` whose `external_variant_id` has a channel listing of the same connection. For each: set `sku_id`, and set the cost snapshot to `existing ?? snapshotUnitCogs(costs of that SKU, order date in the org timezone, order currency)`. A line that already has a SKU is never selected, and an existing snapshot is never replaced. Each batch is its own tenant transaction; the loop ends when a batch is not full (which includes a batch that made no progress) or after `maxBatches`. The engine runs it after the products chain end has COMMITTED; a failure there never fails the run.

- [ ] **Step 1: Write the failing tests**

Create `packages/sync/test/linkup.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { linkOrderLines } from '../src/linkup';
import { CONN_A, CONN_B, ORG_A, ORG_B, seedCost, seedListing, seedOrder, seedSku, startEnv, type TestEnv } from './helpers';

let env: TestEnv;
const CONN_A2 = 'aaaaaaaa-0000-4aaa-8aaa-000000000002'; // a second connection of org A
beforeAll(async () => {
  env = await startEnv();
  await env.owner.query(
    `insert into store_connections (id, org_id, platform, external_account_id, status) values ($1, $2, 'shopify', 'shop-a2', 'active')`,
    [CONN_A2, ORG_A],
  );
});
afterAll(async () => {
  await env?.stop();
});
beforeEach(async () => {
  for (const t of ['order_lines', 'orders', 'sku_cost_components', 'sku_channel_listings', 'skus', 'products']) {
    await env.owner.query(`delete from ${t}`);
  }
});

const line = async (orderId: string) =>
  (await env.owner.query(`select sku_id, unit_cogs_cents_snapshot as cogs from order_lines where order_id = $1 order by external_line_id`, [orderId])).rows;
async function orderWithLines(
  orgId: string,
  connectionId: string,
  externalId: string,
  placedAt: string,
  variants: (string | null)[],
  skuId: string | null = null,
) {
  const orderId = await seedOrder(env.owner, {
    orgId,
    connectionId,
    externalId,
    placedAt,
    lines: variants.map((_v, i) => ({ skuId, qty: 1, externalLineId: `l-${i + 1}` })),
  });
  for (const [i, v] of variants.entries()) {
    await env.owner.query(`update order_lines set external_variant_id = $2 where order_id = $1 and external_line_id = $3`, [orderId, v, `l-${i + 1}`]);
  }
  return orderId;
}
const args = { orgId: ORG_A, connectionId: CONN_A };

describe('linkOrderLines', () => {
  it('links the line and fills the cost in effect on the ORDER date in the org timezone', async () => {
    const sku = await seedSku(env.owner, ORG_A, 'LATE');
    await seedCost(env.owner, ORG_A, sku, 700, { from: '2026-01-01', to: '2026-02-28' });
    await seedCost(env.owner, ORG_A, sku, 900, { from: '2026-03-01' });
    await seedListing(env.owner, ORG_A, CONN_A, sku, 'v-9');
    // 03:30 UTC on 2 March is still 1 March in New York (org A): the 900 cost applies, and today's cost never does.
    const march = await orderWithLines(ORG_A, CONN_A, 'o-march', '2026-03-02T03:30:00Z', ['v-9']);
    const february = await orderWithLines(ORG_A, CONN_A, 'o-feb', '2026-02-10T15:00:00Z', ['v-9']);
    expect(await linkOrderLines(env.db, args)).toEqual({ linked: 2 });
    expect(await line(march)).toEqual([{ sku_id: sku, cogs: '900' }]);
    expect(await line(february)).toEqual([{ sku_id: sku, cogs: '700' }]);
  });
  it('is idempotent, and a later cost change never rewrites a snapshot', async () => {
    const sku = await seedSku(env.owner, ORG_A, 'IDEM');
    await seedCost(env.owner, ORG_A, sku, 500, { from: '2026-01-01' });
    await seedListing(env.owner, ORG_A, CONN_A, sku, 'v-1');
    const order = await orderWithLines(ORG_A, CONN_A, 'o-1', '2026-03-05T12:00:00Z', ['v-1']);
    expect(await linkOrderLines(env.db, args)).toEqual({ linked: 1 });
    await seedCost(env.owner, ORG_A, sku, 999, { from: '2026-02-01', type: 'packaging' });
    expect(await linkOrderLines(env.db, args)).toEqual({ linked: 0 });
    expect(await line(order)).toEqual([{ sku_id: sku, cogs: '500' }]);
  });
  it('leaves a snapshot that is already set, and a line that already has a SKU, alone', async () => {
    const sku = await seedSku(env.owner, ORG_A, 'NEW');
    const other = await seedSku(env.owner, ORG_A, 'OLD');
    await seedCost(env.owner, ORG_A, sku, 500, { from: '2026-01-01' });
    await seedListing(env.owner, ORG_A, CONN_A, sku, 'v-1');
    const kept = await orderWithLines(ORG_A, CONN_A, 'o-kept', '2026-03-05T12:00:00Z', ['v-1']);
    await env.owner.query(`update order_lines set unit_cogs_cents_snapshot = 123 where order_id = $1`, [kept]);
    const linked = await orderWithLines(ORG_A, CONN_A, 'o-linked', '2026-03-05T12:00:00Z', ['v-1'], other);
    await linkOrderLines(env.db, args);
    expect(await line(kept)).toEqual([{ sku_id: sku, cogs: '123' }]);
    expect(await line(linked)).toEqual([{ sku_id: other, cogs: null }]); // never relinked
  });
  it('leaves unmatched lines unlinked: an unknown variant and a line with no variant', async () => {
    const sku = await seedSku(env.owner, ORG_A, 'ONE');
    await seedListing(env.owner, ORG_A, CONN_A, sku, 'v-1');
    const order = await orderWithLines(ORG_A, CONN_A, 'o-1', '2026-03-05T12:00:00Z', ['v-unknown', null, 'v-1']);
    expect(await linkOrderLines(env.db, args)).toEqual({ linked: 1 });
    expect((await line(order)).map((r) => r.sku_id)).toEqual([null, null, sku]);
  });
  it("never touches another connection's lines, or another org's lines with the same variant id", async () => {
    const skuA = await seedSku(env.owner, ORG_A, 'A');
    const skuB = await seedSku(env.owner, ORG_B, 'B');
    await seedListing(env.owner, ORG_A, CONN_A, skuA, 'v-shared');
    await seedListing(env.owner, ORG_B, CONN_B, skuB, 'v-shared');
    const mine = await orderWithLines(ORG_A, CONN_A, 'o-a', '2026-03-05T12:00:00Z', ['v-shared']);
    const sibling = await orderWithLines(ORG_A, CONN_A2, 'o-a2', '2026-03-05T12:00:00Z', ['v-shared']); // no listing on CONN_A2
    const theirs = await orderWithLines(ORG_B, CONN_B, 'o-b', '2026-03-05T12:00:00Z', ['v-shared']);
    expect(await linkOrderLines(env.db, args)).toEqual({ linked: 1 });
    expect((await line(mine))[0]!.sku_id).toBe(skuA);
    expect((await line(sibling))[0]!.sku_id).toBeNull();
    expect((await line(theirs))[0]!.sku_id).toBeNull();
  });
  it('is bounded: batches of the given size, at most maxBatches batches, finishing on the next call', async () => {
    const sku = await seedSku(env.owner, ORG_A, 'MANY');
    await seedListing(env.owner, ORG_A, CONN_A, sku, 'v-1');
    await orderWithLines(ORG_A, CONN_A, 'o-many', '2026-03-05T12:00:00Z', Array.from({ length: 7 }, () => 'v-1'));
    expect(await linkOrderLines(env.db, args, { batchSize: 3, maxBatches: 2 })).toEqual({ linked: 6 });
    expect(await linkOrderLines(env.db, args, { batchSize: 3, maxBatches: 2 })).toEqual({ linked: 1 });
    expect(await linkOrderLines(env.db, args, { batchSize: 3, maxBatches: 2 })).toEqual({ linked: 0 });
  });
  it('does nothing when there is nothing to link', async () => {
    expect(await linkOrderLines(env.db, args)).toEqual({ linked: 0 });
  });
});
```

Add to `packages/sync/test/engine.test.ts` (imports: `seedOrder` from `./helpers`, `type SyncPageJob` already imported):

```ts
describe('order-line link-up after products', () => {
  const lateOrder = async () => {
    const orderId = await seedOrder(env.owner, {
      orgId: ORG_A,
      connectionId: CONN_A,
      externalId: 'o-late',
      placedAt: '2026-09-15T12:00:00Z',
      lines: [{ skuId: null, qty: 1 }],
    });
    await env.owner.query(`update order_lines set external_variant_id = 'v-1' where order_id = $1`, [orderId]);
    return orderId;
  };
  const lineOf = async (orderId: string) =>
    (await env.owner.query(`select sku_id, unit_cogs_cents_snapshot as cogs from order_lines where order_id = $1`, [orderId])).rows[0];

  it('links a line to the product the sync just imported and fills the cost in effect on the order date', async () => {
    await env.owner.query(`delete from order_lines`);
    await env.owner.query(`delete from orders`);
    const h = makeHarness(env);
    const orderId = await lateOrder();
    await runMode(h, ['locations', 'products'], 'backfill'); // the sample product has variant v-1 with cost 800 from 2026-01-01
    const row = await lineOf(orderId);
    expect(row.sku_id).not.toBeNull();
    expect(row.cogs).toBe('800');
  });
  it('a failure in the link-up never fails the finished products run, and the next run repeats it', async () => {
    await env.owner.query(`delete from order_lines`);
    await env.owner.query(`delete from orders`);
    const h = makeHarness(env);
    const orderId = await lateOrder();
    const job = await start(h, 'products');
    const first = await processSyncPage(h.deps, job); // page 1 of 2
    if (first.kind !== 'next') throw new Error('expected a second page');
    const realDb = h.deps.db;
    let calls = 0;
    // load (1), page transaction (2), then the link-up transaction (3) fails
    h.deps.db = {
      ...realDb,
      withTenant: (org: string, fn: Parameters<typeof realDb.withTenant>[1]) =>
        ++calls >= 3 ? Promise.reject(new Error('link-up db down')) : realDb.withTenant(org, fn),
    } as typeof realDb;
    expect(await processSyncPage(h.deps, first.job)).toEqual({ kind: 'done' });
    h.deps.db = realDb;
    expect((await cursorRow('products')).status).toBe('complete');
    expect((await lineOf(orderId)).sku_id).toBeNull();
    h.clock.advance(60_000);
    await runMode(h, ['products'], 'incremental');
    expect((await lineOf(orderId)).sku_id).not.toBeNull();
  });
});
```
(The second run is incremental, so the connector only returns products changed since the watermark; the link-up does not need them to be returned again because the listing already exists from the first pass.)

- [ ] **Step 2: Run to see the failures**

Run: `pnpm --filter @erq/sync exec vitest run test/linkup.test.ts`
Expected: FAIL (`../src/linkup` not found).

- [ ] **Step 3: Implement**

`packages/sync/src/linkup.ts`:

```ts
import { and, eq, isNull } from 'drizzle-orm';
import { orderLines, orders, orgs, skuChannelListings, type TenantDb, type Tx } from '@erq/db';
import { loadCostRows, snapshotUnitCogs, toOrgDate } from './cogs';

export const LINKUP_BATCH_SIZE = 500;
/** 200 batches of 500 lines is 100 000 lines per call; the rest waits for the next products run. */
export const LINKUP_MAX_BATCHES = 200;

async function linkBatch(
  tx: Tx,
  args: { orgId: string; connectionId: string },
  batchSize: number,
): Promise<number> {
  const [org] = await tx.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, args.orgId));
  if (!org) return 0;
  const candidates = await tx
    .select({
      lineId: orderLines.id,
      skuId: skuChannelListings.skuId,
      snapshot: orderLines.unitCogsCentsSnapshot,
      placedAt: orders.placedAt,
      currency: orders.currency,
    })
    .from(orderLines)
    .innerJoin(orders, and(eq(orders.orgId, orderLines.orgId), eq(orders.id, orderLines.orderId)))
    .innerJoin(
      skuChannelListings,
      and(
        eq(skuChannelListings.orgId, orders.orgId),
        eq(skuChannelListings.storeConnectionId, orders.storeConnectionId),
        eq(skuChannelListings.externalVariantId, orderLines.externalVariantId),
      ),
    )
    .where(
      and(
        eq(orders.orgId, args.orgId),
        eq(orders.storeConnectionId, args.connectionId),
        isNull(orderLines.skuId),
      ),
    )
    .orderBy(orderLines.id)
    .limit(batchSize);
  if (candidates.length === 0) return 0;
  const costRows = await loadCostRows(tx, [...new Set(candidates.map((c) => c.skuId))]);
  let linked = 0;
  for (const c of candidates) {
    // The snapshot is historical: an existing one wins; otherwise the cost in effect on the ORDER date.
    const snapshot =
      c.snapshot ??
      snapshotUnitCogs(costRows.get(c.skuId), toOrgDate(c.placedAt, org.timezone), c.currency.trim());
    const updated = await tx
      .update(orderLines)
      .set({ skuId: c.skuId, unitCogsCentsSnapshot: snapshot })
      // The sku_id IS NULL guard makes a concurrent writer's link win instead of being overwritten.
      .where(and(eq(orderLines.orgId, args.orgId), eq(orderLines.id, c.lineId), isNull(orderLines.skuId)))
      .returning({ id: orderLines.id });
    linked += updated.length;
  }
  return linked;
}

/**
 * Links order lines that were imported before their variant existed. Set-based and idempotent; each batch is
 * its own tenant transaction so no long transaction holds locks; ends when a batch is not full (which also
 * ends a call that makes no progress) or after `maxBatches`.
 */
export async function linkOrderLines(
  db: Pick<TenantDb, 'withTenant'>,
  args: { orgId: string; connectionId: string },
  opts: { batchSize?: number; maxBatches?: number } = {},
): Promise<{ linked: number }> {
  const batchSize = opts.batchSize ?? LINKUP_BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? LINKUP_MAX_BATCHES;
  let linked = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const n = await db.withTenant(args.orgId, (tx) => linkBatch(tx, args, batchSize));
    linked += n;
    if (n < batchSize) break;
  }
  return { linked };
}
```
`packages/sync/src/index.ts`: `export * from './linkup';`.

`packages/sync/src/engine/process.ts`: add `import { linkOrderLines } from '../linkup';`; before the final `try`, declare `const outcome = { productsCompleted: false };`; change `return await deps.db.withTenant(job.orgId, async (tx): Promise<PageResult> => {` to `const result = await deps.db.withTenant(job.orgId, async (tx): Promise<PageResult> => {`; right after the line `if (!done) return { kind: 'next', job };` add `if (job.resource === 'products') outcome.productsCompleted = true;`; and after the closing `});` of that call (still inside the `try`):

```ts
    // The page transaction holds the cursor lock, so the link-up runs only after the products chain end has
    // COMMITTED, in its own bounded transactions. It is idempotent and best effort: a failure here never fails the
    // finished run, and the next products run repeats it (unmatched lines are counted on the Connections page).
    if (outcome.productsCompleted) {
      try {
        await linkOrderLines(deps.db, { orgId: job.orgId, connectionId: job.connectionId });
      } catch {
        /* retried by the next products run */
      }
    }
    return result;
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd "C:/Users/OK COMPUTER/Desktop/WorkAgentic/eRetailQuery" && pnpm turbo run build --filter=@erq/db --filter=@erq/connectors --filter=@erq/shared --concurrency=1
pnpm --filter @erq/sync exec vitest run test/linkup.test.ts
pnpm --filter @erq/sync exec vitest run test/engine.test.ts
pnpm --filter @erq/sync typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sync
git commit -m "feat(sync): link order lines to products that arrive after the order

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Part D: Status and alerts

### Task 9: Per-resource sync status in the DTO and API

**Files:**
- Modify: `packages/shared/src/connections.ts`, `apps/api/src/connections/connections.service.ts` (`list`, `summarize`)
- Test: `apps/api/test/connections.test.ts` (update one exact assertion, add a `describe`)

**Interfaces:**
- Produces (`@erq/shared`):
  - `type ConnectionResourceName = 'locations' | 'products' | 'inventory' | 'orders'`
  - `interface ConnectionResourceDto { resource: ConnectionResourceName; state: 'never' | 'running' | 'failed' | 'idle'; lastCompletedAt: string | null; error: string | null }`
  - `ConnectionSyncDto` gains `resources: ConnectionResourceDto[]` (always four entries, in import order locations, products, inventory, orders) and `unlinkedLines: number`. The existing fields (`state`, `resource`, `recordsProcessed`, `coveredFrom`, `historyLimited`, `error`, `canStart`) are unchanged.
- Rules: `state` is `running` when the cursor is running, `failed` when it failed (`error` is the stored, already sanitized text and `lastCompletedAt` is its last good time), `idle` when it completed at least once, otherwise `never` (also when there is no cursor row). `unlinkedLines` counts lines of this connection's non-test orders with no SKU and a variant id. `ConnectionDto.lastSyncedAt` stays the `store_connections.last_synced_at` column, which is now the oldest of the four resource times (Task 4).

- [ ] **Step 1: Write the failing tests**

In `apps/api/test/connections.test.ts`, update the exact list expectation in `lists connections without any credential fields...` (the `sync` object) to:

```ts
        sync: {
          state: 'never',
          resource: null,
          recordsProcessed: 0,
          coveredFrom: null,
          historyLimited: true,
          error: null,
          canStart: true,
          resources: [
            { resource: 'locations', state: 'never', lastCompletedAt: null, error: null },
            { resource: 'products', state: 'never', lastCompletedAt: null, error: null },
            { resource: 'inventory', state: 'never', lastCompletedAt: null, error: null },
            { resource: 'orders', state: 'never', lastCompletedAt: null, error: null },
          ],
          unlinkedLines: 0,
        },
```
and add a new `describe` at the end of the file:

```ts
describe('per-resource sync status', () => {
  async function connection(orgId: string, shop: string, lastSyncedAt: string | null = null) {
    const { rows } = await owner.query(
      `insert into store_connections (org_id, platform, external_account_id, status, encrypted_credentials, last_synced_at)
       values ($1, 'shopify', $2, 'active', 'ciphertext', $3) returning id`,
      [orgId, shop, lastSyncedAt],
    );
    return rows[0].id as string;
  }
  const cursor = (org: string, conn: string, resource: string, status: string, syncedAt: string | null, error: string | null = null) =>
    owner.query(
      `insert into sync_cursors (org_id, store_connection_id, resource, status, last_synced_at, last_error) values ($1, $2, $3, $4, $5, $6)`,
      [org, conn, resource, status, syncedAt, error],
    );
  const first = async (orgId: string, h: Record<string, string>) =>
    (await request(server()).get(`/orgs/${orgId}/connections`).set(h)).body[0];
  async function lineOn(org: string, conn: string, ext: string, opts: { variant: string | null; test?: boolean; sku?: string | null }) {
    const { rows } = await owner.query(
      `insert into orders (org_id, store_connection_id, external_order_id, channel, status, placed_at, currency, gross_cents,
         discount_cents, shipping_charged_cents, tax_cents, refund_cents, net_cents, is_test, external_updated_at)
       values ($1, $2, $3, 'shopify_online', 'closed', now(), 'USD', 0, 0, 0, 0, 0, 0, $4, now()) returning id`,
      [org, conn, ext, opts.test ?? false],
    );
    await owner.query(
      `insert into order_lines (org_id, order_id, sku_id, external_line_id, external_variant_id, title, quantity, unit_price_cents)
       values ($1, $2, $3, 'l-1', $4, 'Line', 1, 100)`,
      [org, rows[0].id, opts.sku ?? null, opts.variant],
    );
  }

  it('reports each resource with its own state, completion time and error, in import order', async () => {
    const { orgId, h } = await createOrg('Resources Org');
    const id = await connection(orgId, 'res1.myshopify.com');
    await cursor(orgId, id, 'locations', 'complete', '2026-10-08T12:00:00.000Z');
    await cursor(orgId, id, 'products', 'running', '2026-10-08T11:30:00.000Z');
    await cursor(orgId, id, 'inventory', 'failed', '2026-10-08T11:00:00.000Z', 'Shopify rate limit hit.');
    const body = await first(orgId, h);
    expect(body.sync.resources).toEqual([
      { resource: 'locations', state: 'idle', lastCompletedAt: '2026-10-08T12:00:00.000Z', error: null },
      { resource: 'products', state: 'running', lastCompletedAt: '2026-10-08T11:30:00.000Z', error: null },
      { resource: 'inventory', state: 'failed', lastCompletedAt: '2026-10-08T11:00:00.000Z', error: 'Shopify rate limit hit.' },
      { resource: 'orders', state: 'never', lastCompletedAt: null, error: null },
    ]);
    // the aggregate fields keep their meaning
    expect(body.sync).toMatchObject({ state: 'running', resource: 'products' });
  });
  it('a cursor row that never completed reads never, even when it exists', async () => {
    const { orgId, h } = await createOrg('Never Org');
    const id = await connection(orgId, 'res2.myshopify.com');
    await cursor(orgId, id, 'orders', 'idle', null);
    const body = await first(orgId, h);
    expect(body.sync.resources.find((r: { resource: string }) => r.resource === 'orders')).toEqual({
      resource: 'orders', state: 'never', lastCompletedAt: null, error: null,
    });
  });
  it('leaves the connection time as the stored column (the oldest resource, never "now")', async () => {
    const { orgId, h } = await createOrg('Column Org');
    await connection(orgId, 'res3.myshopify.com', '2026-10-08T10:00:00.000Z');
    expect((await first(orgId, h)).lastSyncedAt).toBe('2026-10-08T10:00:00.000Z');
  });
  it('counts only unlinked lines of this connection that carry a variant, never test orders or other orgs', async () => {
    const { orgId, h } = await createOrg('Unlinked Org');
    const id = await connection(orgId, 'res4.myshopify.com');
    const sibling = await connection(orgId, 'res5.myshopify.com');
    await lineOn(orgId, id, 'o-1', { variant: 'v-1' });
    await lineOn(orgId, id, 'o-2', { variant: 'v-2' });
    await lineOn(orgId, id, 'o-3', { variant: null }); // no variant: nothing to link to
    await lineOn(orgId, id, 'o-4', { variant: 'v-4', test: true }); // test orders are not real sales
    await lineOn(orgId, sibling, 'o-5', { variant: 'v-5' }); // another connection
    const other = await createOrg('Other Unlinked Org');
    const otherConn = await connection(other.orgId, 'res6.myshopify.com');
    await lineOn(other.orgId, otherConn, 'o-6', { variant: 'v-6' }); // another org
    const body = (await request(server()).get(`/orgs/${orgId}/connections`).set(h)).body;
    const mine = body.find((c: { id: string }) => c.id === id);
    const theirs = body.find((c: { id: string }) => c.id === sibling);
    expect([mine.sync.unlinkedLines, theirs.sync.unlinkedLines]).toEqual([2, 1]);
    expect(JSON.stringify(body)).not.toContain(other.orgId);
  });
  it('is readable by a viewer and never exposes credentials', async () => {
    const { orgId } = await createOrg('Viewer Resources Org');
    await connection(orgId, 'res7.myshopify.com');
    const viewer = await addMember(orgId, 'viewer');
    const res = await request(server()).get(`/orgs/${orgId}/connections`).set(viewer);
    expect(res.status).toBe(200);
    expect(res.body[0].sync.resources).toHaveLength(4);
    expect(JSON.stringify(res.body)).not.toMatch(/ciphertext|credential|token/i);
  });
});
```
(The existing `uses a bounded number of tenant transactions however many connections exist` test keeps passing: the new queries run inside the same `withTenant`.)

- [ ] **Step 2: Run to see the failures**

Run: `pnpm --filter @erq/api exec vitest run test/connections.test.ts -t "per-resource|lists connections without"`
Expected: FAIL (`resources` and `unlinkedLines` are missing).

- [ ] **Step 3: Implement**

`packages/shared/src/connections.ts`: add before `ConnectionSyncDto`

```ts
export type ConnectionResourceName = 'locations' | 'products' | 'inventory' | 'orders';
export interface ConnectionResourceDto {
  resource: ConnectionResourceName;
  /** never: not imported yet; running: importing now; failed: the last attempt failed; idle: imported before. */
  state: 'never' | 'running' | 'failed' | 'idle';
  /** When this resource last finished importing (ISO), or null. A failed resource keeps its last good time. */
  lastCompletedAt: string | null;
  /** Stored, already sanitized failure text, else null. */
  error: string | null;
}
```
and add to `ConnectionSyncDto`:

```ts
  /** One entry per resource, in import order (locations, products, inventory, orders). */
  resources: ConnectionResourceDto[];
  /** Order lines whose product is not imported yet, so their cost is not counted. */
  unlinkedLines: number;
```
`apps/api/src/connections/connections.service.ts`:
- imports: add `count, isNotNull, isNull` to the `drizzle-orm` import, `orderLines` to the `@erq/db` import, and `type ConnectionResourceDto` to the `@erq/shared` import.
- in `list`, add `lastSyncedAt: syncCursors.lastSyncedAt,` to the cursors select, and after the `covered` query:

```ts
      const unlinked = await tx
        .select({ connectionId: orders.storeConnectionId, n: count() })
        .from(orderLines)
        .innerJoin(orders, and(eq(orders.orgId, orderLines.orgId), eq(orders.id, orderLines.orderId)))
        .where(
          and(
            // RLS already scopes the rows; the explicit org filter is defence in depth.
            eq(orders.orgId, orgId),
            isNull(orderLines.skuId),
            isNotNull(orderLines.externalVariantId),
            eq(orders.isTest, false),
          ),
        )
        .groupBy(orders.storeConnectionId);
      const unlinkedBy = new Map(unlinked.map((u) => [u.connectionId, u.n]));
```
  and pass `unlinkedBy.get(r.id) ?? 0` as a fourth argument of `summarize`.
- `summarize(conn, cursors, coveredFrom, unlinkedLines)`: the cursor type gains `lastSyncedAt: Date | null`; build the resources and put both new fields into `base`:

```ts
    const resources = SYNC_RESOURCE_ORDER.map((resource): ConnectionResourceDto => {
      const c = cursors.find((x) => x.resource === resource);
      const lastCompletedAt = c?.lastSyncedAt?.toISOString() ?? null;
      if (!c) return { resource, state: 'never', lastCompletedAt: null, error: null };
      if (c.status === 'running') return { resource, state: 'running', lastCompletedAt, error: null };
      if (c.status === 'failed') return { resource, state: 'failed', lastCompletedAt, error: c.lastError };
      return { resource, state: lastCompletedAt === null ? 'never' : 'idle', lastCompletedAt, error: null };
    });
    const base = {
      coveredFrom: coveredFrom?.toISOString() ?? null,
      historyLimited: !(conn.scopes ?? []).includes('read_all_orders'),
      canStart:
        this.syncQueue.available &&
        (conn.status === 'active' || conn.status === 'error') &&
        !running,
      resources,
      unlinkedLines,
    };
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd "C:/Users/OK COMPUTER/Desktop/WorkAgentic/eRetailQuery" && pnpm turbo run build --filter=@erq/db --filter=@erq/connectors --filter=@erq/shared --filter=@erq/sync --concurrency=1
pnpm --filter @erq/api exec vitest run test/connections.test.ts
pnpm --filter @erq/api typecheck
```
Expected: PASS (all existing sync-summary tests still pass because the aggregate fields did not change).

- [ ] **Step 5: Commit**

```bash
git add packages/shared apps/api
git commit -m "feat(api): report each resource's own sync status and count unlinked order lines

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---
### Task 10: Per-resource sync status in the web UI

**Files:**
- Modify: `apps/web/src/lib/connections.ts`, `apps/web/src/app/(app)/connections/page.tsx`
- Test: `apps/web/src/lib/connections.test.ts`

**Interfaces:**
- Consumes (Task 9): `ConnectionSyncDto.resources`, `ConnectionSyncDto.unlinkedLines`, `ConnectionResourceDto`.
- Produces (`apps/web/src/lib/connections.ts`):
  - `interface ResourceLine { resource: string; label: string; hint: string; text: string; tone: 'ok' | 'warn' | 'muted' }`
  - `oldestCompletedAt(resources: ConnectionResourceDto[]): string | null` (the oldest `lastCompletedAt`, only when every resource has one)
  - `describeResources(sync: ConnectionSyncDto, now: Date): ResourceLine[]`
  - `describeUnlinked(count: number): string | null`
  - `REFRESH_NOTE: string`
  - `describeSync` keeps its signature. When `sync.resources` is non-empty, "last import" means the OLDEST resource time (never more than the oldest resource), and an `idle` connection with a never-imported resource reads "Not imported yet". With `resources` empty it behaves exactly as before (the `lastSyncedAt` argument).
- Wording (exact): `Locations|Products|Stock|Orders: importing now`; `...: not imported yet`; `...: last import <relative time>`; `...: failed, <error without its final punctuation>. Last good import <relative time>.` (the second sentence only when a good time exists; with no stored error the reason is `try Sync now`). `REFRESH_NOTE` = `Orders refresh about every 15 minutes. Products and stock levels refresh sooner when Shopify tells us about a change.` `describeUnlinked(1)` = `1 order line is waiting for its product to be imported, so its cost is not counted yet.`; `describeUnlinked(n)` for n > 1 = `<n> order lines are waiting for their products to be imported, so their cost is not counted yet.` (thousands separators); 0 gives null.

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/lib/connections.test.ts` update the helper (the DTO gained two required fields) and the imports:

```ts
import { SHOPIFY_ERROR_CODES, type ConnectionDto, type ConnectionResourceDto, type ConnectionSyncDto } from '@erq/shared';
import {
  connectionsErrorMessage,
  describeConnection,
  describeResources,
  describeSync,
  describeUnlinked,
  isShopifyAuthorizeUrl,
  oldestCompletedAt,
  REFRESH_NOTE,
  shopifyErrorMessage,
  shopifyWarningMessage,
  STALE_AFTER_MS,
  suggestShopDomain,
} from './connections';

const sync = (over: Partial<ConnectionSyncDto> = {}): ConnectionSyncDto => ({
  state: 'idle',
  resource: null,
  recordsProcessed: 0,
  coveredFrom: null,
  historyLimited: false,
  error: null,
  canStart: true,
  resources: [],
  unlinkedLines: 0,
  ...over,
});
```
and add:

```ts
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const four = (over: Partial<Record<ConnectionResourceDto['resource'], Partial<ConnectionResourceDto>>> = {}): ConnectionResourceDto[] =>
  (['locations', 'products', 'inventory', 'orders'] as const).map((resource) => ({
    resource,
    state: 'idle',
    lastCompletedAt: ago(5 * MIN),
    error: null,
    ...over[resource],
  }));

describe('oldestCompletedAt', () => {
  it('is the oldest time, and null when any resource has none', () => {
    expect(oldestCompletedAt(four({ products: { lastCompletedAt: ago(2 * HOUR) } }))).toBe(ago(2 * HOUR));
    expect(oldestCompletedAt(four({ orders: { state: 'never', lastCompletedAt: null } }))).toBeNull();
    expect(oldestCompletedAt([])).toBeNull();
  });
});

describe('describeResources', () => {
  const lines = (over: Parameters<typeof four>[0]) =>
    describeResources(sync({ resources: four(over) }), NOW).map((l) => [l.label, l.text, l.tone]);
  it('gives every resource its own plain line, in import order', () => {
    expect(
      lines({
        orders: { lastCompletedAt: ago(6 * MIN) },
        products: { state: 'running' },
        inventory: { state: 'never', lastCompletedAt: null },
      }),
    ).toEqual([
      ['Locations', 'Locations: last import 5 minutes ago', 'ok'],
      ['Products', 'Products: importing now', 'muted'],
      ['Stock', 'Stock: not imported yet', 'muted'],
      ['Orders', 'Orders: last import 6 minutes ago', 'ok'],
    ]);
  });
  it('names a failed resource with its reason and its last good import', () => {
    expect(
      lines({
        inventory: { state: 'failed', error: 'Shopify rate limit hit.', lastCompletedAt: ago(3 * HOUR) },
      })[2],
    ).toEqual(['Stock', 'Stock: failed, Shopify rate limit hit. Last good import 3 hours ago.', 'warn']);
    expect(
      lines({ orders: { state: 'failed', error: null, lastCompletedAt: null } })[3],
    ).toEqual(['Orders', 'Orders: failed, try Sync now.', 'warn']);
  });
  it('warns when a resource is older than two days and not at exactly two days', () => {
    expect(lines({ orders: { lastCompletedAt: ago(STALE_AFTER_MS) } })[3]![2]).toBe('ok');
    expect(lines({ orders: { lastCompletedAt: ago(STALE_AFTER_MS + 1000) } })[3]![2]).toBe('warn');
  });
  it('gives every line a hint for its tooltip, and nothing when the server sent no resources', () => {
    for (const line of describeResources(sync({ resources: four() }), NOW)) expect(line.hint.length).toBeGreaterThan(10);
    expect(describeResources(sync(), NOW)).toEqual([]);
  });
});

describe('describeSync with per-resource times', () => {
  const d = (s: Partial<ConnectionSyncDto>, last: string | null = ago(MIN)) =>
    describeSync(sync(s), last, NOW, { status: 'active', lastError: null });
  it('never claims more than the OLDEST resource, whatever the connection time says', () => {
    const view = d({ resources: four({ products: { lastCompletedAt: ago(2 * HOUR) } }) }, ago(MIN));
    expect(view).toEqual({
      headline: 'Last import finished 2 hours ago',
      detail: null,
      tone: 'ok',
      canSync: true,
    });
  });
  it('warns by the oldest resource', () => {
    const view = d({ resources: four({ orders: { lastCompletedAt: ago(STALE_AFTER_MS + 1000) } }) });
    expect(view).toMatchObject({ headline: 'Last import finished 2 days ago', tone: 'warn' });
    expect(view.detail).toBe('This may be out of date. Try Sync now.');
  });
  it('reads not imported yet when a resource has never been imported, even if the state says idle', () => {
    expect(d({ resources: four({ orders: { state: 'never', lastCompletedAt: null } }) }).headline).toBe(
      'Not imported yet',
    );
  });
  it('a failed import keeps its own wording and quotes the oldest good time', () => {
    const view = d({
      state: 'failed',
      resource: 'inventory',
      error: 'Shopify rate limit hit.',
      resources: four({ inventory: { state: 'failed', error: 'Shopify rate limit hit.' }, products: { lastCompletedAt: ago(4 * HOUR) } }),
    });
    expect(view.headline).toBe('Import stopped');
    expect(view.detail).toBe(
      'Stopped while importing stock levels. Shopify rate limit hit. Last successful sync 4 hours ago.',
    );
  });
  it('an errored connection still shows its own error text', () => {
    const view = describeSync(
      sync({ resources: four() }),
      ago(MIN),
      NOW,
      { status: 'error', lastError: 'Shopify no longer accepts this connection. Reconnect the store.' },
    );
    expect(view.headline).toBe('Not up to date');
    expect(view.detail).toContain('Shopify no longer accepts this connection. Reconnect the store.');
  });
});

describe('describeUnlinked and REFRESH_NOTE', () => {
  it('has exact singular and plural wording and nothing for zero', () => {
    expect(describeUnlinked(0)).toBeNull();
    expect(describeUnlinked(1)).toBe('1 order line is waiting for its product to be imported, so its cost is not counted yet.');
    expect(describeUnlinked(1234)).toBe('1,234 order lines are waiting for their products to be imported, so their cost is not counted yet.');
    expect(describeUnlinked(-3)).toBeNull();
  });
  it('states the order latency plainly', () => {
    expect(REFRESH_NOTE).toBe(
      'Orders refresh about every 15 minutes. Products and stock levels refresh sooner when Shopify tells us about a change.',
    );
  });
});
```

- [ ] **Step 2: Run to see the failures**

Run: `pnpm --filter @erq/web exec vitest run src/lib/connections.test.ts`
Expected: FAIL (the new exports do not exist; TypeScript is not run by vitest, the missing functions fail the new tests).

- [ ] **Step 3: Implement**

In `apps/web/src/lib/connections.ts` add `ConnectionResourceDto` to the type import and add (after `relativeTime`):

```ts
export interface ResourceLine {
  resource: string;
  label: string;
  hint: string;
  text: string;
  tone: 'ok' | 'warn' | 'muted';
}

const RESOURCE_LABELS_SHORT: Record<string, string> = {
  locations: 'Locations',
  products: 'Products',
  inventory: 'Stock',
  orders: 'Orders',
};
const RESOURCE_HINTS: Record<string, string> = {
  locations: 'Your warehouses and stores in Shopify.',
  products: 'Your products, prices and the cost per item you entered in Shopify.',
  inventory: 'How many units you have at each location.',
  orders: 'Your sales. Orders refresh about every 15 minutes.',
};

/** The oldest completion time, only when EVERY resource has finished at least once. */
export function oldestCompletedAt(resources: ConnectionResourceDto[]): string | null {
  if (resources.length === 0) return null;
  let oldest: number | null = null;
  for (const r of resources) {
    const t = r.lastCompletedAt ? new Date(r.lastCompletedAt).getTime() : Number.NaN;
    if (Number.isNaN(t)) return null;
    oldest = oldest === null ? t : Math.min(oldest, t);
  }
  return oldest === null ? null : new Date(oldest).toISOString();
}
```
and, after `STALE_AFTER_MS` is declared, the rest (it uses `STALE_AFTER_MS`, so place it below that constant):

```ts
const stripEnd = (text: string): string => text.trim().replace(/[.!?]+$/, '');

export function describeResources(sync: ConnectionSyncDto, now: Date): ResourceLine[] {
  return sync.resources.map((r): ResourceLine => {
    const label = Object.hasOwn(RESOURCE_LABELS_SHORT, r.resource)
      ? (RESOURCE_LABELS_SHORT[r.resource] as string)
      : 'Data';
    const hint = Object.hasOwn(RESOURCE_HINTS, r.resource) ? (RESOURCE_HINTS[r.resource] as string) : '';
    const base = { resource: r.resource, label, hint };
    if (r.state === 'running') return { ...base, text: `${label}: importing now`, tone: 'muted' };
    if (r.state === 'never') return { ...base, text: `${label}: not imported yet`, tone: 'muted' };
    if (r.state === 'failed') {
      const good = r.lastCompletedAt ? ` Last good import ${relativeTime(r.lastCompletedAt, now)}.` : '';
      return {
        ...base,
        text: `${label}: failed, ${stripEnd(r.error ?? 'try Sync now')}.${good}`,
        tone: 'warn',
      };
    }
    const at = r.lastCompletedAt ? new Date(r.lastCompletedAt).getTime() : Number.NaN;
    const stale = !Number.isNaN(at) && now.getTime() - at > STALE_AFTER_MS;
    return {
      ...base,
      text: `${label}: last import ${relativeTime(r.lastCompletedAt, now)}`,
      tone: stale ? 'warn' : 'ok',
    };
  });
}

export const REFRESH_NOTE =
  'Orders refresh about every 15 minutes. Products and stock levels refresh sooner when Shopify tells us about a change.';

export function describeUnlinked(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  if (count === 1) {
    return '1 order line is waiting for its product to be imported, so its cost is not counted yet.';
  }
  return `${count.toLocaleString('en-US')} order lines are waiting for their products to be imported, so their cost is not counted yet.`;
}
```
In `describeSync`, replace the lines that derive the time from the argument:

```ts
  // With per-resource times, "last import" is the OLDEST resource: the headline never claims more than that.
  const freshness = sync.resources.length > 0 ? oldestCompletedAt(sync.resources) : lastSyncedAt;
  const syncedMs = freshness ? new Date(freshness).getTime() : Number.NaN;
  const hasSynced = !Number.isNaN(syncedMs);
  const synced = hasSynced ? `Last synced ${relativeTime(freshness, now)}` : 'Not synced yet';
```
and replace the later uses of `lastSyncedAt` in that function (`lastGood` and the final `headline`) with `freshness` (`relativeTime(freshness, now)`). Everything else (statuses, wording, `neverImported = sync.state === 'never' || !hasSynced`) stays, so an `idle` state with a never-imported resource reads "Not imported yet".

`apps/web/src/app/(app)/connections/page.tsx`: import `describeResources`, `describeUnlinked`, `REFRESH_NOTE`; inside the `connections.map` compute `const lines = describeResources(c.sync, now); const unlinked = describeUnlinked(c.sync.unlinkedLines);` and, inside the `<div id={syncId} ...>` after the detail paragraph, add:

```tsx
                        {lines.length > 0 && (
                          <ul aria-label={`Import status for ${c.shop}`} className="mt-1 flex flex-col gap-0.5">
                            {lines.map((line) => (
                              <li
                                key={line.resource}
                                title={line.hint}
                                className={line.tone === 'warn' ? 'text-destructive' : 'text-muted-foreground'}
                              >
                                {line.text}
                              </li>
                            ))}
                          </ul>
                        )}
                        {unlinked && <p className="text-muted-foreground">{unlinked}</p>}
```
and, after the closing `</ul>` of the stores list (inside `CardContent`, only when `connections.length > 0`): `<p className="mt-3 text-xs text-muted-foreground">{REFRESH_NOTE}</p>`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd "C:/Users/OK COMPUTER/Desktop/WorkAgentic/eRetailQuery" && pnpm turbo run build --filter=@erq/shared --concurrency=1
pnpm --filter @erq/web exec vitest run src/lib/connections.test.ts
pnpm --filter @erq/web typecheck
pnpm exec eslint "apps/web/src/lib/connections.ts" "apps/web/src/app/(app)/connections/page.tsx"
```
Expected: PASS. (No web production build here; Task 12 runs it once.)

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): show each data type's own last import and never claim more than the oldest

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Failed webhook retries, alerts and the Connections alert display

**Files:**
- Create: `packages/db/src/schema/alerts.ts`; generated `packages/db/migrations/0025_alerts_and_sweep_retries.sql`; custom `packages/db/migrations/0026_alerts_rls_and_sweep.sql`; `apps/worker/src/webhooks/alerts.ts`
- Modify: `packages/db/src/schema/webhooks.ts`, `packages/db/src/schema/index.ts`, `packages/db/test/fixtures.ts`, `apps/worker/src/webhooks/handler.ts`, `apps/worker/src/webhooks/sweep.ts`, `apps/worker/src/main.ts`, `packages/shared/src/connections.ts`, `apps/api/src/connections/connections.service.ts`, `apps/web/src/lib/connections.ts`, `apps/web/src/app/(app)/connections/page.tsx`
- Test: `packages/db/test/alerts-schema.test.ts` (create), `packages/db/test/webhook-sweep-retries.test.ts` (create), `apps/worker/test/webhook-failure.test.ts` (create), `apps/worker/test/webhook-sweep.test.ts` (update deps), `apps/api/test/connections.test.ts` (update one, add), `apps/web/src/lib/connections.test.ts` (add)

**Interfaces:**
- Produces (db): `webhookEvents.sweepRetries` (`integer not null default 0`, column `sweep_retries`); table `alerts` (`id`, `org_id`, `type text`, `severity alert_severity ('low','medium','high')`, `store_connection_id uuid` with composite FK to `store_connections` on delete cascade, `entity_ref text`, `message text`, `resolved_at timestamptz`, timestamps) with partial unique index `alerts_open_uq` on `(org_id, type, entity_ref) WHERE resolved_at IS NULL`; Drizzle `alerts`, `alertSeverity`. SQL: `app_list_stale_webhook_events(timestamptz, integer)` replaced (same signature): additionally lists `failed` events of NON-privacy topics whose `sweep_retries < 5` and whose `updated_at` is older than the cutoff; privacy topics stay unlimited.
- Produces (worker): `WEBHOOK_SWEEP_MAX_RETRIES = 5` (must equal the literal in the SQL), `MANDATORY_PRIVACY_TOPICS`, `webhookAlertFor(topic: string): { severity: 'high' | 'medium'; message: string }`, `raiseWebhookAlertIfExhausted(tx, args)`; `SweepDeps.db: TenantDb` (the sweep bumps `sweep_retries` for every failed non-privacy event it re-enqueues).
- Produces (shared): `ConnectionAlertDto { id: string; severity: 'low' | 'medium' | 'high'; message: string }`, `ConnectionDto.alerts: ConnectionAlertDto[]` (open `webhook_failed` alerts, highest severity first).
- Produces (web): `connectionAlerts(c: Pick<ConnectionDto, 'alerts'>): ConnectionAlertDto[]`.
- Rules: the alert is written when a failed event whose `sweep_retries >= 5` fails again (its handler run ends in `failed`); exactly once per event (partial unique index plus `ON CONFLICT DO NOTHING`); never for privacy topics; the message is a FIXED text per topic (high for `app/uninstalled`: `Shopify could not tell us the shop uninstalled. Reconnect if you removed the app.`; medium otherwise: `A live update from Shopify could not be applied. We still check your store every 15 minutes, so nothing is lost.`), never the error text. A reconnect or a disconnect resolves the connection's open alerts.

- [ ] **Step 1: Write the failing tests**

Create `packages/db/test/alerts-schema.test.ts`:

```ts
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../src/testing';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let tdb: TestDatabase;
let owner: Pool;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  for (const org of [A, B]) {
    await owner.query(`insert into orgs (id, name, slug) values ($1, 'Org', 'org-' || ($1::uuid)::text)`, [org]);
    await owner.query(
      `insert into store_connections (id, org_id, platform, external_account_id, status) values ($1, $1, 'shopify', ($1::uuid)::text || '.myshopify.com', 'active')`,
      [org],
    );
  }
}, 120_000);
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});
beforeEach(() => owner.query('delete from alerts'));

const insert = (org: string, conn: string | null, ref = 'webhook_event:1', severity = 'medium') =>
  owner.query(
    `insert into alerts (org_id, type, severity, store_connection_id, entity_ref, message) values ($1, 'webhook_failed', $2, $3, $4, 'm')`,
    [org, severity, conn, ref],
  );

describe('alerts', () => {
  it('allows one OPEN alert per (org, type, entity) and a new one once it is resolved', async () => {
    await insert(A, A);
    await expect(insert(A, A)).rejects.toMatchObject({ code: '23505' });
    await owner.query(`update alerts set resolved_at = now()`);
    await insert(A, A);
    expect((await owner.query(`select count(*)::int as n from alerts`)).rows[0].n).toBe(2);
  });
  it('lets two orgs raise the same entity ref', async () => {
    await insert(A, A);
    await insert(B, B);
  });
  it("refuses a connection of another org (composite foreign key)", async () => {
    await expect(insert(A, B)).rejects.toMatchObject({ code: '23503' });
  });
  it('goes away with its connection', async () => {
    const spare = 'dddddddd-0000-4000-8000-000000000001';
    await owner.query(
      `insert into store_connections (id, org_id, platform, external_account_id, status) values ($1, $2, 'shopify', 'spare.myshopify.com', 'active')`,
      [spare, A],
    );
    await insert(A, spare);
    await owner.query(`delete from store_connections where id = $1`, [spare]);
    expect((await owner.query(`select count(*)::int as n from alerts`)).rows[0].n).toBe(0);
  });
  it('only knows low, medium and high', async () => {
    await expect(insert(A, A, 'x', 'critical')).rejects.toMatchObject({ code: '22P02' });
  });
  it('gives webhook_events a retry counter that starts at zero', async () => {
    const { rows } = await owner.query(
      `insert into webhook_events (org_id, store_connection_id, topic, external_event_id, payload) values ($1, $1, 'products/update', 'e1', '{}') returning sweep_retries`,
      [A],
    );
    expect(rows[0].sweep_retries).toBe(0);
  });
});
```
Add the fixture (the isolation suite fails without it) to `packages/db/test/fixtures.ts`, after `store_connections`:

```ts
  alerts: (q, org) =>
    q.query(
      `insert into alerts (org_id, type, severity, store_connection_id, entity_ref, message)
       values ($1, 'webhook_failed', 'medium', $1, 'webhook_event:fixture', 'Fixture alert')`,
      [org],
    ),
```
Create `packages/db/test/webhook-sweep-retries.test.ts`:

```ts
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConnectionsApi, type ConnectionsApi } from '../src';
import { startTestDatabase, type TestDatabase } from '../src/testing';

const A = '11111111-1111-4111-8111-111111111111';
let tdb: TestDatabase;
let owner: Pool;
let app: Pool;
let api: ConnectionsApi;
let seq = 0;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  app = new Pool({ connectionString: tdb.appUrl });
  api = createConnectionsApi(app);
  await owner.query(`insert into orgs (id, name, slug) values ($1, 'Org', 'org')`, [A]);
  await owner.query(
    `insert into store_connections (id, org_id, platform, external_account_id, status) values ($1, $1, 'shopify', 'a.myshopify.com', 'active')`,
    [A],
  );
}, 120_000);
afterAll(async () => {
  await app?.end();
  await owner?.end();
  await tdb?.stop();
});
beforeEach(() => owner.query('delete from webhook_events'));

/** updated_at is set on INSERT: the trigger only fires on UPDATE. */
async function add(topic: string, status: string, retries: number, minutesOld: number): Promise<string> {
  const { rows } = await owner.query(
    `insert into webhook_events (org_id, store_connection_id, topic, external_event_id, payload, status, sweep_retries, received_at, updated_at)
     values ($1, $1, $2, $3, '{}', $4, $5, now() - make_interval(mins => $6), now() - make_interval(mins => $6)) returning id`,
    [A, topic, `e-${++seq}`, status, retries, minutesOld],
  );
  return rows[0].id as string;
}
const listed = async () =>
  (await api.listStaleWebhookEvents(new Date(Date.now() - 10 * 60_000), 100)).map((e) => e.eventId).sort();

describe('app_list_stale_webhook_events with a retry limit', () => {
  it('re-lists a failed non-privacy event only while it has retries left and has cooled down for 10 minutes', async () => {
    const fresh = await add('app/uninstalled', 'failed', 0, 5);
    const first = await add('app/uninstalled', 'failed', 0, 20);
    const fourth = await add('products/update', 'failed', 4, 20);
    const exhausted = await add('products/update', 'failed', 5, 20);
    const beyond = await add('app/uninstalled', 'failed', 9, 20);
    expect(await listed()).toEqual([first, fourth].sort());
    expect(await listed()).not.toContain(fresh);
    expect(await listed()).not.toContain(exhausted);
    expect(await listed()).not.toContain(beyond);
  });
  it('keeps privacy topics unlimited whatever the counter says', async () => {
    const ids = [
      await add('customers/data_request', 'failed', 99, 20),
      await add('customers/redact', 'failed', 0, 20),
      await add('shop/redact', 'failed', 5, 20),
    ];
    expect(await listed()).toEqual(ids.sort());
  });
  it('still lists received and processing events past the cutoff, and nothing that is processed, ignored or deferred', async () => {
    const received = await add('products/update', 'received', 0, 20);
    const processing = await add('products/update', 'processing', 0, 20);
    for (const status of ['processed', 'ignored', 'deferred']) await add('products/update', status, 0, 20);
    expect(await listed()).toEqual([received, processing].sort());
  });
  it('is SECURITY DEFINER with a pinned search_path and executable by app_user only', async () => {
    const fn = 'app_list_stale_webhook_events(timestamptz, integer)';
    const { rows } = await owner.query(`select prosecdef, proconfig from pg_proc where oid = $1::regprocedure`, [fn]);
    expect(rows[0].prosecdef).toBe(true);
    expect(rows[0].proconfig).toContain('search_path=pg_catalog, public, pg_temp');
    const priv = async (role: string) =>
      (await owner.query(`select has_function_privilege($1, $2::regprocedure, 'execute') as ok`, [role, fn])).rows[0].ok;
    expect(await priv('public')).toBe(false);
    expect(await priv('app_user')).toBe(true);
  });
});
```
Create `apps/worker/test/webhook-failure.test.ts`:

```ts
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConnectionsApi, createTenantDb, type ConnectionsApi, type TenantDb } from '@erq/db';
import { startTestDatabase, type TestDatabase } from '@erq/db/testing';
import type { JobQueue } from '@erq/sync';
import { WEBHOOK_SWEEP_MAX_RETRIES, webhookAlertFor } from '../src/webhooks/alerts';
import { processWebhookEvent } from '../src/webhooks/handler';
import { sweepStaleWebhookEvents } from '../src/webhooks/sweep';

const ORG = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-08T12:00:00.000Z');
let tdb: TestDatabase;
let owner: Pool;
let app: Pool;
let db: TenantDb;
let connections: ConnectionsApi;
let seq = 0;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  app = new Pool({ connectionString: tdb.appUrl });
  db = createTenantDb(tdb.appUrl);
  connections = createConnectionsApi(app);
}, 120_000);
afterAll(async () => {
  await db?.close();
  await app?.end();
  await owner?.end();
  await tdb?.stop();
});
beforeEach(async () => {
  await owner.query(`truncate orgs cascade`);
  await owner.query(`insert into orgs (id, name, slug) values ($1, 'Org', 'org')`, [ORG]);
  await owner.query(
    `insert into store_connections (id, org_id, platform, external_account_id, status, encrypted_credentials) values ($1, $1, 'shopify', 'main.myshopify.com', 'active', 'ciphertext')`,
    [ORG],
  );
});

async function addEvent(topic: string, o: { status?: string; retries?: number; minutesOld?: number } = {}) {
  const { rows } = await owner.query(
    `insert into webhook_events (org_id, store_connection_id, topic, external_event_id, payload, status, sweep_retries, received_at, updated_at)
     values ($1, $1, $2, $3, '{}', $4, $5, $6, $6) returning id`,
    [ORG, topic, `evt-${++seq}`, o.status ?? 'received', o.retries ?? 0, new Date(NOW.getTime() - (o.minutesOld ?? 0) * 60_000)],
  );
  return rows[0].id as string;
}
const event = async (id: string) =>
  (await owner.query(`select status, error, sweep_retries from webhook_events where id = $1`, [id])).rows[0];
const alertRows = async () => (await owner.query(`select * from alerts order by created_at`)).rows;
/** A db whose SECOND tenant transaction fails (the claim is the first), like a database blip during the work. */
const failingWork = (): TenantDb => {
  let calls = 0;
  return {
    ...db,
    withTenant: (org: string, fn: Parameters<TenantDb['withTenant']>[1]) =>
      ++calls === 2 ? Promise.reject(new Error('db down shpat_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE')) : db.withTenant(org, fn),
  } as TenantDb;
};
const throwingQueue: JobQueue = {
  enqueue: async () => {
    throw new Error('redis down shpat_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE');
  },
};
async function backfilledCursors() {
  for (const resource of ['locations', 'products', 'inventory', 'orders']) {
    await owner.query(
      `insert into sync_cursors (org_id, store_connection_id, resource, status, last_synced_at, updated_at) values ($1, $1, $2, 'complete', $3, $3)`,
      [ORG, resource, new Date(NOW.getTime() - 3_600_000)],
    );
  }
}
const run = (id: string, over: { db?: TenantDb; sync?: { queue: JobQueue } } = {}) =>
  processWebhookEvent({ db: over.db ?? db, connections, sync: over.sync, now: () => NOW }, { orgId: ORG, eventId: id });

describe('webhookAlertFor', () => {
  it('uses fixed texts: high for the uninstall, medium for everything else', () => {
    expect(WEBHOOK_SWEEP_MAX_RETRIES).toBe(5);
    expect(webhookAlertFor('app/uninstalled')).toEqual({
      severity: 'high',
      message: 'Shopify could not tell us the shop uninstalled. Reconnect if you removed the app.',
    });
    expect(webhookAlertFor('products/update')).toEqual({
      severity: 'medium',
      message: 'A live update from Shopify could not be applied. We still check your store every 15 minutes, so nothing is lost.',
    });
  });
});

describe('the sweep retry budget', () => {
  const enqueued: string[] = [];
  const enqueuer = {
    enqueue: async (job: { eventId: string }) => {
      enqueued.push(job.eventId);
    },
  };
  const clock = { ms: Date.parse('2026-10-08T12:00:00.000Z') };
  const sweep = () =>
    sweepStaleWebhookEvents({ connections, enqueuer, db, now: () => new Date(clock.ms) });
  const stamp = (id: string, minutesOld: number) =>
    owner.query(`update webhook_events set updated_at = $2 where id = $1`, [id, new Date(clock.ms - minutesOld * 60_000)]);
  // These tests place updated_at themselves, so the trigger that stamps it with the real clock is switched off.
  beforeAll(() => owner.query(`alter table webhook_events disable trigger set_updated_at`));
  afterAll(() => owner.query(`alter table webhook_events enable trigger set_updated_at`));
  beforeEach(() => {
    enqueued.length = 0;
    clock.ms = Date.parse('2026-10-08T12:00:00.000Z');
  });

  it('retries a failed non-privacy event at most 5 times, one every 10 minutes, and counts each retry', async () => {
    const id = await addEvent('app/uninstalled', { status: 'failed', minutesOld: 30 });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(await sweep(), `sweep ${attempt}`).toBe(1);
      expect((await event(id)).sweep_retries).toBe(attempt);
      await stamp(id, 0); // the retry just failed again: its last attempt is now
      expect(await sweep(), `cool-down ${attempt}`).toBe(0);
      clock.ms += 11 * 60_000; // past the 10 minute cool-down
    }
    clock.ms += 6 * 3_600_000;
    expect(await sweep()).toBe(0); // the budget is spent
    expect((await event(id)).status).toBe('failed'); // and the event stays failed
    expect(enqueued).toEqual([id, id, id, id, id]);
  });
  it('never stops retrying a privacy event and never counts it', async () => {
    const id = await addEvent('shop/redact', { status: 'failed', minutesOld: 30 });
    for (let i = 0; i < 8; i += 1) {
      expect(await sweep(), `sweep ${i}`).toBe(1);
      clock.ms += 11 * 60_000;
    }
    expect((await event(id)).sweep_retries).toBe(0);
  });
  it('does not count a retry for an event that is merely received or processing', async () => {
    const received = await addEvent('products/update', { status: 'received', minutesOld: 30 });
    expect(await sweep()).toBe(1);
    expect((await event(received)).sweep_retries).toBe(0);
  });
});

describe('the alert at exhaustion', () => {
  it('writes ONE high alert for a failing app/uninstalled once its retries are used up, however often it fails again', async () => {
    const id = await addEvent('app/uninstalled', { status: 'received', retries: 5 });
    await expect(run(id, { db: failingWork() })).rejects.toThrow('db down');
    expect((await event(id)).status).toBe('failed');
    await expect(run(id, { db: failingWork() })).rejects.toThrow('db down'); // a failed event is claimable again
    const rows = await alertRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      org_id: ORG,
      type: 'webhook_failed',
      severity: 'high',
      store_connection_id: ORG,
      entity_ref: `webhook_event:${id}`,
      message: 'Shopify could not tell us the shop uninstalled. Reconnect if you removed the app.',
      resolved_at: null,
    });
    expect(JSON.stringify(rows)).not.toMatch(/shpat_|db down/); // the error text never reaches an alert
    expect(JSON.stringify(await event(id))).not.toMatch(/shpat_/);
  });
  it('writes a medium alert for a failing nudge', async () => {
    await backfilledCursors();
    const id = await addEvent('products/update', { retries: 5 });
    await expect(run(id, { sync: { queue: throwingQueue } })).rejects.toThrow('redis down');
    expect((await alertRows()).map((r) => r.severity)).toEqual(['medium']);
  });
  it('writes no alert while retries remain', async () => {
    const id = await addEvent('app/uninstalled', { retries: WEBHOOK_SWEEP_MAX_RETRIES - 1 });
    await expect(run(id, { db: failingWork() })).rejects.toThrow('db down');
    expect(await alertRows()).toEqual([]);
    expect((await event(id)).status).toBe('failed');
  });
  it('never raises this alert for a privacy topic, which keeps retrying', async () => {
    const id = await addEvent('customers/redact', { retries: 99 });
    await expect(run(id, { db: failingWork() })).rejects.toThrow('db down');
    expect(await alertRows()).toEqual([]);
  });
});
```
(`NOW` is a `Date` mutated by the first sweep test and restored; if ESLint objects to mutating a `const`, make `NOW` a `let` clock helper `clock = { ms: Date.parse(...) }` and pass `() => new Date(clock.ms)`.)

In `apps/worker/test/webhook-sweep.test.ts` add `db` (a `createTenantDb(tdb.appUrl)` created in the file's `beforeAll` and closed in `afterAll`) to every `sweepStaleWebhookEvents({...})` call: the sweep now bumps `sweep_retries` and needs it.

In `apps/api/test/connections.test.ts`: add `alerts: []` to the exact list expectation next to `sync` (test `lists connections without any credential fields...`), and add:

```ts
describe('webhook failure alerts', () => {
  async function alertFor(orgId: string, connectionId: string, severity: 'low' | 'medium' | 'high', ref: string, message: string) {
    const { rows } = await owner.query(
      `insert into alerts (org_id, type, severity, store_connection_id, entity_ref, message) values ($1, 'webhook_failed', $2, $3, $4, $5) returning id`,
      [orgId, severity, connectionId, ref, message],
    );
    return rows[0].id as string;
  }
  async function conn(orgId: string, shop: string) {
    const { rows } = await owner.query(
      `insert into store_connections (org_id, platform, external_account_id, status, encrypted_credentials) values ($1, 'shopify', $2, 'active', 'ciphertext') returning id`,
      [orgId, shop],
    );
    return rows[0].id as string;
  }
  it('lists only the open alerts of this org, highest severity first, with no internal fields', async () => {
    const { orgId, h } = await createOrg('Alerts Org');
    const id = await conn(orgId, 'alerts1.myshopify.com');
    const medium = await alertFor(orgId, id, 'medium', 'webhook_event:1', 'Medium text.');
    const high = await alertFor(orgId, id, 'high', 'webhook_event:2', 'High text.');
    const resolved = await alertFor(orgId, id, 'high', 'webhook_event:3', 'Resolved text.');
    await owner.query(`update alerts set resolved_at = now() where id = $1`, [resolved]);
    const other = await createOrg('Other Alerts Org');
    const otherConn = await conn(other.orgId, 'alerts2.myshopify.com');
    await alertFor(other.orgId, otherConn, 'high', 'webhook_event:9', 'Other org text.');
    const body = (await request(server()).get(`/orgs/${orgId}/connections`).set(h)).body;
    expect(body[0].alerts).toEqual([
      { id: high, severity: 'high', message: 'High text.' },
      { id: medium, severity: 'medium', message: 'Medium text.' },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/Other org text|Resolved text|webhook_event/);
    const viewer = await addMember(orgId, 'viewer');
    expect((await request(server()).get(`/orgs/${orgId}/connections`).set(viewer)).body[0].alerts).toHaveLength(2);
  });
  it('a disconnect resolves the connection alerts', async () => {
    const { orgId, h } = await createOrg('Disconnect Alerts Org');
    const id = await conn(orgId, 'alerts3.myshopify.com');
    await alertFor(orgId, id, 'high', 'webhook_event:1', 'Text.');
    await request(server()).post(`/orgs/${orgId}/connections/${id}/disconnect`).set(h);
    expect((await owner.query(`select resolved_at from alerts where store_connection_id = $1`, [id])).rows[0].resolved_at).not.toBeNull();
  });
});
```
and, inside `describe('POST /connections/shopify/callback')`, after the reconnect test:

```ts
  it('a reconnect resolves the open webhook alerts of that connection and leaves other connections alone', async () => {
    const { orgId, h } = await createOrg('Reconnect Alerts Org');
    let state = await startInstall(orgId, h);
    await callbackAs(authOnly(h), rawSigned(state));
    const { rows } = await owner.query(`select id from store_connections where org_id = $1`, [orgId]);
    const id = rows[0].id as string;
    const sibling = await owner.query(
      `insert into store_connections (org_id, platform, external_account_id, status) values ($1, 'shopify', 'sibling.myshopify.com', 'active') returning id`,
      [orgId],
    );
    for (const target of [id, sibling.rows[0].id as string]) {
      await owner.query(
        `insert into alerts (org_id, type, severity, store_connection_id, entity_ref, message) values ($1, 'webhook_failed', 'high', $2, $3, 'x')`,
        [orgId, target, `webhook_event:${target}`],
      );
    }
    await owner.query(`update store_connections set status = 'disconnected' where id = $1`, [id]);
    state = await startInstall(orgId, h);
    await callbackAs(authOnly(h), rawSigned(state));
    const after = await owner.query(`select store_connection_id, resolved_at from alerts`);
    const byConn = Object.fromEntries(after.rows.map((r) => [r.store_connection_id, r.resolved_at]));
    expect(byConn[id]).not.toBeNull();
    expect(byConn[sibling.rows[0].id]).toBeNull();
  });
```
Add to `apps/web/src/lib/connections.test.ts` (and `alerts: []` to the `conn()` helper):

```ts
describe('connectionAlerts', () => {
  it('lists the open alerts of a connection, highest severity first, keeping order within a severity', () => {
    const alerts = [
      { id: 'a', severity: 'medium' as const, message: 'M1' },
      { id: 'b', severity: 'high' as const, message: 'H1' },
      { id: 'c', severity: 'medium' as const, message: 'M2' },
      { id: 'd', severity: 'low' as const, message: 'L1' },
    ];
    expect(connectionAlerts({ alerts }).map((a) => a.id)).toEqual(['b', 'a', 'c', 'd']);
    expect(connectionAlerts({ alerts: [] })).toEqual([]);
  });
});
```
(import `connectionAlerts` from `./connections`.)

- [ ] **Step 2: Run to see the failures**

Run: `pnpm --filter @erq/db exec vitest run test/alerts-schema.test.ts test/webhook-sweep-retries.test.ts` and `pnpm --filter @erq/worker exec vitest run test/webhook-failure.test.ts`
Expected: FAIL (no `alerts` table, no `sweep_retries`, no `alerts.ts`).

- [ ] **Step 3: Implement the database**

`packages/db/src/schema/webhooks.ts`: in `webhookEvents` after `error`:

```ts
    /** How many times the sweep re-enqueued this FAILED event (non-privacy topics stop at 5; privacy topics never stop). */
    sweepRetries: integer('sweep_retries').notNull().default(0),
```
(add `integer` to the `drizzle-orm/pg-core` import).

Create `packages/db/src/schema/alerts.ts`:

```ts
import { sql } from 'drizzle-orm';
import { foreignKey, index, pgEnum, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { storeConnections } from './connections';
import { tenantId } from './tenant';
import { timestamps } from './timestamps';

export const alertSeverity = pgEnum('alert_severity', ['low', 'medium', 'high']);

/** Something the owner should look at. Messages are fixed texts, never raw error text. */
export const alerts = pgTable(
  'alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    type: text('type').notNull(),
    severity: alertSeverity('severity').notNull(),
    storeConnectionId: uuid('store_connection_id'),
    /** What the alert is about, for example `webhook_event:<id>`; one open alert per (type, entity). */
    entityRef: text('entity_ref').notNull(),
    message: text('message').notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique('alerts_org_id_uq').on(t.orgId, t.id),
    foreignKey({
      columns: [t.orgId, t.storeConnectionId],
      foreignColumns: [storeConnections.orgId, storeConnections.id],
    }).onDelete('cascade'),
    uniqueIndex('alerts_open_uq')
      .on(t.orgId, t.type, t.entityRef)
      .where(sql`${t.resolvedAt} is null`),
    index('alerts_org_open_idx')
      .on(t.orgId, t.storeConnectionId)
      .where(sql`${t.resolvedAt} is null`),
  ],
);
```
`packages/db/src/schema/index.ts`: `export * from './alerts';`.

Generate and write the migrations:

```bash
cd "C:/Users/OK COMPUTER/Desktop/WorkAgentic/eRetailQuery/packages/db"
pnpm exec drizzle-kit generate --name=alerts_and_sweep_retries
pnpm exec drizzle-kit generate --custom --name=alerts_rls_and_sweep
```
Expected: `0025_alerts_and_sweep_retries.sql` (the enum, the `alerts` table, its constraints and indexes, `ALTER TABLE "webhook_events" ADD COLUMN "sweep_retries" integer DEFAULT 0 NOT NULL`) and an empty `0026_alerts_rls_and_sweep.sql`. Fill the latter:

```sql
SELECT app_secure_tenant_table('alerts');
--> statement-breakpoint
-- Replaces the 0021 definition (same signature). Failed events of NON-privacy topics are re-listed too, but only
-- while they have retries left (sweep_retries < 5, kept in line with WEBHOOK_SWEEP_MAX_RETRIES in
-- apps/worker/src/webhooks/alerts.ts) and after their last attempt is older than the cutoff. Privacy topics
-- (keep this list in line with MANDATORY_PRIVACY_TOPICS in the same file) stay unlimited.
CREATE OR REPLACE FUNCTION app_list_stale_webhook_events(p_older_than timestamptz, p_limit integer)
RETURNS TABLE (o_org_id uuid, o_event_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT org_id, id FROM webhook_events
  WHERE (status = 'received' AND received_at < p_older_than)
     OR (status = 'processing' AND updated_at < p_older_than)
     OR (status = 'failed'
         AND topic IN ('customers/data_request', 'customers/redact', 'shop/redact')
         AND updated_at < p_older_than)
     OR (status = 'failed'
         AND topic NOT IN ('customers/data_request', 'customers/redact', 'shop/redact')
         AND sweep_retries < 5
         AND updated_at < p_older_than)
  ORDER BY CASE WHEN status = 'received' THEN received_at ELSE updated_at END
  LIMIT least(greatest(p_limit, 1), 500)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_list_stale_webhook_events(timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_list_stale_webhook_events(timestamptz, integer) TO app_user;
--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION app_list_stale_webhook_events(timestamptz, integer) FROM %I', r);
  END LOOP;
END $$;
```

- [ ] **Step 4: Implement the worker, API, shared DTO and web**

`apps/worker/src/webhooks/alerts.ts`:

```ts
import { alerts, webhookEvents, type Tx } from '@erq/db';
import { and, eq } from 'drizzle-orm';

/** Sweep retries a failed non-privacy event gets before it stays failed and raises an alert. Must equal the literal in migration 0026. */
export const WEBHOOK_SWEEP_MAX_RETRIES = 5;
/** Mandatory privacy topics: retried without limit and never alerted on here. Must match migrations 0021 and 0026. */
export const MANDATORY_PRIVACY_TOPICS = ['customers/data_request', 'customers/redact', 'shop/redact'] as const;

export function webhookAlertFor(topic: string): { severity: 'high' | 'medium'; message: string } {
  if (topic === 'app/uninstalled') {
    return {
      severity: 'high',
      message: 'Shopify could not tell us the shop uninstalled. Reconnect if you removed the app.',
    };
  }
  return {
    severity: 'medium',
    message:
      'A live update from Shopify could not be applied. We still check your store every 15 minutes, so nothing is lost.',
  };
}

/**
 * Called in the same transaction that marks an event `failed`. Writes the alert when the event has used up its
 * sweep retries; the partial unique index plus ON CONFLICT DO NOTHING keep it to one open alert per event.
 */
export async function raiseWebhookAlertIfExhausted(
  tx: Tx,
  a: { orgId: string; eventId: string; topic: string; storeConnectionId: string },
): Promise<void> {
  if ((MANDATORY_PRIVACY_TOPICS as readonly string[]).includes(a.topic)) return;
  const [event] = await tx
    .select({ retries: webhookEvents.sweepRetries })
    .from(webhookEvents)
    .where(and(eq(webhookEvents.orgId, a.orgId), eq(webhookEvents.id, a.eventId)));
  if (!event || event.retries < WEBHOOK_SWEEP_MAX_RETRIES) return;
  const text = webhookAlertFor(a.topic);
  await tx
    .insert(alerts)
    .values({
      orgId: a.orgId,
      type: 'webhook_failed',
      severity: text.severity,
      storeConnectionId: a.storeConnectionId,
      entityRef: `webhook_event:${a.eventId}`,
      message: text.message,
    })
    .onConflictDoNothing();
}
```
`apps/worker/src/webhooks/handler.ts`: import `raiseWebhookAlertIfExhausted` from `./alerts`; replace the failure recording in the final `catch`:

```ts
  } catch (error) {
    try {
      const message = sanitizeMessage(error);
      await deps.db.withTenant(orgId, async (tx) => {
        await setStatus(tx, orgId, eventId, 'failed', now(), message);
        await raiseWebhookAlertIfExhausted(tx, { orgId, eventId, topic, storeConnectionId });
      });
    } catch {
      /* best effort: the original error must not be masked */
    }
    throw error;
  }
```
`apps/worker/src/webhooks/sweep.ts`: add `db: TenantDb` to `SweepDeps` (`import type { ConnectionsApi, TenantDb } from '@erq/db'`), import `webhookEvents` and Drizzle `and, eq, notInArray, sql`, `MANDATORY_PRIVACY_TOPICS`, and bump the counter before enqueueing:

```ts
  for (const job of stale) {
    try {
      // Every re-enqueue of a failed non-privacy event spends one of its retries (the update also restarts the
      // 10 minute cool-down through the updated_at trigger). Received, processing and privacy events are untouched.
      await deps.db.withTenant(job.orgId, (tx) =>
        tx
          .update(webhookEvents)
          .set({ sweepRetries: sql`${webhookEvents.sweepRetries} + 1` })
          .where(
            and(
              eq(webhookEvents.orgId, job.orgId),
              eq(webhookEvents.id, job.eventId),
              eq(webhookEvents.status, 'failed'),
              notInArray(webhookEvents.topic, [...MANDATORY_PRIVACY_TOPICS]),
            ),
          ),
      );
      await deps.enqueuer.enqueue({ orgId: job.orgId, eventId: job.eventId }, { retryBucket });
      enqueued++;
    } catch (error) {
      deps.onError?.(sanitizeMessage(error));
    }
  }
```
`apps/worker/src/main.ts`: pass `db` in the `sweepStaleWebhookEvents({ connections, enqueuer, db, onError: ... })` call. Also set the doc comment of the sweep (it now also re-lists failed non-privacy events within the retry budget).

`packages/shared/src/connections.ts`: add

```ts
export interface ConnectionAlertDto {
  id: string;
  severity: 'low' | 'medium' | 'high';
  /** A fixed, plain-English text that says what to do. Never raw error text. */
  message: string;
}
```
and `alerts: ConnectionAlertDto[];` to `ConnectionDto`.

`apps/api/src/connections/connections.service.ts`: import `alerts` from `@erq/db` and `Tx`; in `list` add after the cursors query:

```ts
      const open = await tx
        .select({
          id: alerts.id,
          connectionId: alerts.storeConnectionId,
          severity: alerts.severity,
          message: alerts.message,
        })
        .from(alerts)
        .where(
          and(eq(alerts.orgId, orgId), eq(alerts.type, 'webhook_failed'), isNull(alerts.resolvedAt)),
        )
        .orderBy(alerts.createdAt, alerts.id);
      const rank = { high: 0, medium: 1, low: 2 } as const;
      const alertsBy = new Map<string, { id: string; severity: 'low' | 'medium' | 'high'; message: string }[]>();
      for (const a of open) {
        if (a.connectionId === null) continue;
        const list = alertsBy.get(a.connectionId) ?? [];
        list.push({ id: a.id, severity: a.severity, message: a.message });
        alertsBy.set(a.connectionId, list);
      }
```
and in the row mapping `alerts: (alertsBy.get(r.id) ?? []).sort((x, y) => rank[x.severity] - rank[y.severity])` (`Array.prototype.sort` is stable, so creation order holds within a severity). Add the helper and call it where connections are replaced or removed:

```ts
/** Resolves a connection's open alerts: a reconnect or a disconnect answers them. */
async function resolveAlerts(tx: Tx, orgId: string, connectionId: string): Promise<void> {
  await tx
    .update(alerts)
    .set({ resolvedAt: new Date() })
    .where(
      and(eq(alerts.orgId, orgId), eq(alerts.storeConnectionId, connectionId), isNull(alerts.resolvedAt)),
    );
}
```
In `completeInstall` call `await resolveAlerts(tx, orgId, row.id);` inside the same transaction right after the credentials update, and in `disconnect` call `await resolveAlerts(tx, orgId, id);` after the status update (before `insertAudit`).

`apps/web/src/lib/connections.ts`:

```ts
import type { ConnectionAlertDto } from '@erq/shared';

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;
/** Open alerts of a connection, highest severity first (the order within a severity is kept). */
export function connectionAlerts(c: Pick<ConnectionDto, 'alerts'>): ConnectionAlertDto[] {
  return [...c.alerts].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}
```
`apps/web/src/app/(app)/connections/page.tsx`: import `connectionAlerts`; in the map compute `const openAlerts = connectionAlerts(c);`, render under the shop name

```tsx
                      {openAlerts.map((a) => (
                        <p
                          key={a.id}
                          role="alert"
                          className="mt-1 rounded-md border border-destructive p-2 text-sm text-destructive"
                        >
                          {a.message}
                        </p>
                      ))}
```
and show the reconnect button when there is an alert: change `v.canReconnect` in the `ReconnectShopify` condition to `(v.canReconnect || openAlerts.length > 0)`.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd "C:/Users/OK COMPUTER/Desktop/WorkAgentic/eRetailQuery" && pnpm turbo run build --filter=@erq/db --filter=@erq/connectors --filter=@erq/shared --filter=@erq/sync --concurrency=1
pnpm --filter @erq/db exec vitest run test/alerts-schema.test.ts test/webhook-sweep-retries.test.ts test/shopify-tables.test.ts test/hardening.test.ts
pnpm --filter @erq/db exec vitest run test/isolation.test.ts
pnpm --filter @erq/worker exec vitest run test/webhook-failure.test.ts test/webhook-sweep.test.ts test/webhook-handler.test.ts
pnpm --filter @erq/api exec vitest run test/connections.test.ts
pnpm --filter @erq/web exec vitest run src/lib/connections.test.ts
pnpm --filter @erq/worker typecheck && pnpm --filter @erq/api typecheck && pnpm --filter @erq/web typecheck
```
Expected: PASS. `shopify-tables.test.ts` already exercises the 0021 privacy listing; its privacy assertions must still hold (the new function keeps that branch). If it asserts that a failed non-privacy event is NEVER listed, update that assertion to the new rule (listed while `sweep_retries < 5`) and say so in the commit body.

- [ ] **Step 6: Commit**

```bash
git add packages apps
git commit -m "feat(webhooks): retry failed webhook events with a budget and alert when it runs out

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Part E: Documentation and verification

### Task 12: Documentation and final verification

**Files:**
- Modify: `docs/sync.md`, `docs/shopify-connection.md`, `CLAUDE.md`
- No new tests: this task is the full-repository verification.

**Interfaces:** none produced. Consumes everything above.

- [ ] **Step 1: Update `docs/sync.md`**

(a) In section 5 (Operations) add after the `mode` bullet list: `mode` may also be `full`: it needs no `since`, clears the cursor's `updated_since` at start (so the connector sends no change filter) and, like a backfill, stamps `sync_cursors.last_full_pass_at` on completion. Inventory ignores the filter in every mode, so its hourly poll is a plain `incremental` run.

(b) Replace the section `## Known gaps (1b-3c)` with two sections: `## Live updates (1b-3c)` and `## Known gaps after 1b-3c`. The first must contain these subsections, with this content:

- **Scheduler.** A repeatable job `schedule-tick` (scheduler id `sync-tick`, every 60 s) calls `runSchedulerTick` (`packages/sync/src/schedule/tick.ts`). It reads `app_list_due_sync_resources(now, 50)` (worker only, never an API route), re-checks each connection with the pure `dueResources`, and starts chains with `enqueueSync`: one incremental chain, plus a `full` chain of products and inventory when the daily products pass is due. Cadences: locations, products and orders 15 minutes; inventory 60 minutes (a full pass); products full pass every 24 hours; at most 50 connections per tick (oldest first). A connection is skipped unless it is an `active` Shopify connection with credentials, all four resources have completed once, and no cursor is `running`. A `failed` cursor waits one cadence from its last attempt. Errors for one connection are sanitized, reported and do not stop the tick.
- **Idle token refresh.** `app_list_idle_refresh_connections` lists active connections whose refresh token expires within 14 days and whose access token is expired or about to be; the tick renews them inline through the token service. A final refusal sets the connection to `error` with the reconnect text.
- **Token service.** `createTokenService` (`packages/sync/src/tokens.ts`): refresh when the access token has 5 minutes or less left, under `SELECT ... FOR UPDATE` on the connection row, re-reading after the lock, writing the rotated pair and both expiry columns in the same transaction. The engine calls it before every fetch and gives the connector only `{ accessToken }`. Residual risk: if Shopify answers but the commit fails, the rotated token is lost and the shop must be reconnected.
- **Webhook nudges.** `products/update` nudges products and `inventory_levels/update` nudges inventory (`apps/worker/src/webhooks/nudge.ts`): an incremental sync of that resource, dropped unless the connection is `active`, fully imported once, has no running cursor, and the resource did not complete (or fail) within 60 s. Order, refund and customer topics are not subscribed (protected customer data approval), so orders are polled every 15 minutes. The daily products tick also re-registers the webhook subscriptions (idempotent).
- **Link-up pass.** After a products chain end commits, `linkOrderLines` links order lines of that connection that have no SKU but a variant with a channel listing, filling the cost snapshot with the cost in effect on the order date in the org timezone; idempotent, bounded (500 per batch, 200 batches), never overwrites a link or snapshot, best effort.
- **Per-resource status.** `ConnectionSyncDto.resources` (one entry per resource: state, last completion, error) and `unlinkedLines`; `store_connections.last_synced_at` is the OLDEST of the four resource times and only exists once all four have completed.
- **Failed webhook events.** The sweep re-lists failed non-privacy events after 10 minutes, at most 5 times (`webhook_events.sweep_retries`), then one `alerts` row (`webhook_failed`, high for `app/uninstalled`) is written and the Connections page shows it until a reconnect or disconnect. Privacy topics keep their unlimited retry.
- **Migrations:** 0022 token expiry columns, 0023 `sync_cursors.last_full_pass_at`, 0024 the two scheduler functions, 0025 `sweep_retries` and `alerts`, 0026 alerts RLS and the replaced sweep function.

The second section lists what is still open: the `then` chain is still not persisted (a resumed run finishes only its resource; the scheduler heals the rest on the next cadence); a nudge arriving within 60 s after a run is dropped until the next poll; on the daily tick orders may run before the products full pass finishes (the link-up repairs lines); orders have a 15-minute latency until protected customer data approval exists; the connection-health row lock now has an interleaving test (closed); `coveredFrom` index, audit-after-start and the other items from the previous list that this task did not touch stay as they were (copy them over unchanged).

- [ ] **Step 2: Update `docs/shopify-connection.md`**

(a) Section 3 (Environment variables): the worker now also reads `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` (token refresh; without them an expiring token that needs refreshing fails the run with "Token refresh is not configured on this server.") and `API_PUBLIC_URL` (the webhook callback for the daily re-register; without it nothing is re-registered).
(b) Section 5 (Webhooks): the subscribed topics are `app/uninstalled`, `products/update`, `inventory_levels/update`; the product and stock topics only nudge a sync and are scrubbed to `{}`; the other data topics are still `deferred`.
(c) Section 6 (Credentials): the encrypted blob is `{ accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt }` for expiring tokens (the old `{ accessToken }` shape is read as non-expiring and never refreshed); the two expiry times are mirrored in `store_connections.access_token_expires_at` and `refresh_token_expires_at`; the install sends `expiring=1`; refresh rotates both tokens and is serialised by the connection row lock; a final `401` marks the connection `error` with "Shopify no longer accepts this connection. Reconnect the store."
(d) Section 8 (Known gaps): remove "Shopify token refresh is deferred to 1b-3c"; the "failed webhook events are never swept" item becomes "retried 5 times then alerted".
(e) Section 10 (First-install checklist), add these unverified items: the `expiring=1` exchange answer (`expires_in`, `refresh_token`, `refresh_token_expires_in`); the refresh request and its rotation, and that a replayed refresh token gives `401 {"error":"invalid_request"}`; that `products/update` and `inventory_levels/update` subscriptions are accepted without protected customer data approval and that their delivery nudges within seconds; the `webhookSubscriptionCreate` request shape (`URL!` variable, `format: JSON`) now used three times per connect; the real query cost of the 15-minute polling against the 1000-point bucket with several shops (`extensions.cost.actualQueryCost`); that the BullMQ job scheduler `sync-tick` runs exactly one tick per minute across worker restarts and several worker instances; that the nudge and the sweep work through real BullMQ; that the connection row lock held across the Shopify refresh call does not exhaust the Postgres pool under load.

- [ ] **Step 3: Update `CLAUDE.md`**

Section 16 and the Decisions Log (keep the section's existing style):
- Line 5 status: mention that 1b-3c (live updates) is built; next are the CSV import, the manual and CSV cost-entry paths, then 1c.
- "Built": append one sentence: `Phase 1b-3c adds live updates (docs/sync.md "Live updates"): expiring offline tokens refreshed under a connection row lock, a one-minute scheduler polling on a tiered cadence, product and stock webhook nudges, an order-line link-up pass, per-resource sync status, and retry plus alerts for failed webhook events (new migrations 0022 to 0026, the \`alerts\` table).`
- "Rules that are easy to break": add three bullets: (1) Access tokens are short-lived and expiring: refresh only through `createTokenService` (connection row lock, rotated pair written in the same transaction); the connector never sees the refresh token; never log, store in a job, DTO, audit row or error text. (2) `store_connections.last_synced_at` is the OLDEST of the four resource times and only exists when all four completed; the scheduler (`app_list_due_sync_resources`, `app_list_idle_refresh_connections`) and `app_list_stale_webhook_events` are worker-only SECURITY DEFINER reads, never exposed through a route. (3) A webhook nudge never carries or keeps data (payload `{}`), is gated in the database (not by a queue job id) and never starts a first import; order, refund and customer webhook topics stay unsubscribed until Shopify's protected customer data approval exists.
- "Not yet verified by running": add the unverified 1b-3c items: everything against real Shopify (exchange, refresh, subscriptions, query cost), the BullMQ `sync-tick` scheduler, nudge and sweep through real BullMQ, and the web UI in a browser.
- "Known open items": replace the 1b-3c bullet by what remains (see docs/sync.md "Known gaps after 1b-3c") and delete "Shopify token refresh ... is deferred to 1b-3c" and the failed-event sweep sentence.
- Decisions Log (dated 2026-10-08): `Scheduled polling plus webhook nudges: polling is the safety net, a webhook only starts a sync earlier.`; `Tiered cadence: locations, products and orders every 15 minutes, inventory a full pass hourly, a products full pass daily.`; `Only non-customer webhook topics (products/update, inventory_levels/update) are subscribed; orders stay polling-only until the protected customer data approval exists.`; `Access tokens are expiring offline tokens, refreshed under a connection row lock; the refresh token rotates on every refresh.`; `store_connections.last_synced_at is the oldest resource time; per-resource times live on sync_cursors.`; `The scheduler is one ticker plus a SECURITY DEFINER due query, not per-connection schedules or a next_due_at column.`; `Webhook nudges are debounced in the database, not with queue job ids, because enqueueSync commits the run before it enqueues.`; `Failed non-privacy webhook events are retried 5 times by the sweep and then raise an alert (new alerts table).`

- [ ] **Step 4: Full verification, one package at a time**

Run each command and check its result before the next (low disk: never in parallel; after every database-using run confirm no `postgres` process and no `erq-pg-*` folder remains with `Get-Process postgres` and `Get-ChildItem $env:TEMP -Filter 'erq-pg-*'` in PowerShell).

```bash
cd "C:/Users/OK COMPUTER/Desktop/WorkAgentic/eRetailQuery"
pnpm turbo run build --filter=@erq/db --filter=@erq/connectors --filter=@erq/sync --filter=@erq/shared --concurrency=1
pnpm --filter @erq/shared test
pnpm --filter @erq/connectors test
pnpm --filter @erq/db test
pnpm --filter @erq/sync test
pnpm --filter @erq/worker test
pnpm --filter @erq/api test
pnpm --filter @erq/web test
pnpm turbo run typecheck --concurrency=1
pnpm lint
```
Expected: every suite passes (Redis-dependent tests, `sync-redis` and `webhook-redis`, are skipped without Docker and reported as unverified), typecheck and lint are clean. Then the ONE web production build:

```bash
pnpm --filter @erq/web build
```
Expected: builds. Clean up straight away: `rm -rf "apps/web/.next" ".turbo"` and delete any `%TEMP%\erq-pg-*` folder.

- [ ] **Step 5: Review the unverified list and commit**

Check that the first-install checklist in `docs/shopify-connection.md` section 10 contains every item listed in Step 2(e), and that `git status` shows only intended files (no `.next`, `.turbo` or temp output).

```bash
git add docs CLAUDE.md
git commit -m "docs: document live updates, token refresh and the new first-install checklist items

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
