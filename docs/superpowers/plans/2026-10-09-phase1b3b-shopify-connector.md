# Phase 1b-3b: Shopify Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a connected Shopify store import: a `ShopifyStoreConnector` for locations, products with costs, inventory and orders (POS as its own channel), the wiring that starts the first backfill after connect, a "Sync now" action, and a sync summary on the Connections page.

**Architecture:** A paginated GraphQL Admin API connector in `packages/connectors/src/shopify` behind the existing `HttpClient` and the page-job engine from 1b-1; pure normalizers and an exact string-based money parser; a fixture-driven fake Shopify Admin for tests; thin wiring in the worker, the API and the web app.

**Tech Stack:** TypeScript strict, zod v3, Vitest 5, NestJS 11, BullMQ, Next.js 15.

**Spec:** `docs/superpowers/specs/2026-10-09-phase1b3b-shopify-connector-design.md` (the spec is the authority; where this plan refines it the Global Constraints say so).

## Global Constraints

- Branch `phase1b3b-connector` (created, spec committed). Every commit message ends with the exact line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Money is integer minor units (cents) with an ISO currency; NEVER floats. Shopify returns decimal strings; convert with exact string math only.
- Tokens, secrets, response bodies, raw GraphQL documents and webhook payloads never appear in error messages, logs, `last_error` or audit metadata. Connector errors use FIXED strings; stored error text still passes through `sanitizeMessage`.
- The connector never touches the database and never imports anything outside `packages/connectors` except `@erq/shared` types it already uses. No Shopify-specific field leaks past `normalize.ts`.
- External ids are Shopify GIDs as received (`gid://shopify/Product/123`), used verbatim in every normalized `externalId`, `externalVariantId`, `externalLineId` and `locationExternalId`.
- Customer id, UTM and landing-site fields are NEVER queried and stay `null` (protected customer data; spec section 1).
- GraphQL operation documents, field names, enum names, the API version and the rate-limit numbers reflect Shopify's documentation as of writing but could NOT be verified against a live shop. The implementer of each task confirms them against Shopify's current official Admin GraphQL reference (use web fetch when available), puts the doc link in a code comment, follows the docs where they differ and reports each difference. Anything still uncertain is listed in `docs/shopify-connection.md` as a first-install checklist item (Task 12).
- The fake and fixtures are built from the documented response shapes; they are test doubles, not evidence the real API behaves that way.
- TypeScript strict, no `any` without a comment. Prettier before every commit. ESLint rejects unused destructured variables: avoid `_x` destructuring in tests.
- Other packages load `@erq/db` and `@erq/connectors` from `dist`: run `pnpm turbo run build --filter=@erq/db --filter=@erq/connectors` before running another package's tests directly. After any test run that starts a database, verify no `postgres` process (including children) and no `%TEMP%\erq-pg-*` directory remains; keep >1GB disk free (delete `apps/web/.next` after web builds).
- Redis/BullMQ-dependent tests are skipped without Docker and reported as unverified. The Playwright path is written but runs in CI only.
- Refinement of the spec: the connector cursor is `{ v: 1, after: string | null }` only; the shop currency is read with `shop { currencyCode }` in each products and orders query instead of being carried in the cursor.

## Review Focus

Failure modes the spec implies that need explicit tests (each pinned in the task named):
1. A money value with more decimals than the currency allows, a zero- or three-decimal currency, a negative amount and a huge amount must convert exactly or fail loudly — Task 1.
2. A throttled response must produce a retry delay that keeps the sync alive, and no error text may carry the token, body or query — Task 2.
3. A product with more than 100 variants, an item with more than 50 inventory levels and an order with more than 100 lines must not silently lose rows — Tasks 3, 4, 5.
4. POS, test, cancelled, discounted, taxed and partially refunded orders must normalize to the semantics the sinks and P&L expect — Task 5.
5. A replayed page, a throttled page and an auth error must behave through the real engine (idempotent, retried, connection errored then recovered) — Task 8.
6. Connect must start the first backfill without breaking the connect when Redis is absent or enqueue fails — Task 9.

## File Structure

```
packages/connectors/src/shopify/{money,graphql,cursor,locations,products,inventory,orders,connector}.ts   (create)
packages/connectors/src/shopify/index.ts                  (modify: exports)
packages/connectors/src/testing/{fake-shopify-admin,shopify-fixtures}.ts   (create)
packages/connectors/src/testing/index.ts                  (modify)
packages/connectors/src/shopify/config.ts                 (modify: scopes)
packages/sync/src/{policies,history}.ts                   (modify/create)
packages/sync/src/engine/{start,process}.ts               (modify)
apps/worker/src/main.ts                                   (modify: register connector)
apps/api/src/connections/{sync-queue,sync-starter,connections.service,connections.controller,connections.module,tokens}.ts
packages/shared/src/connections.ts                        (modify: sync summary DTO)
apps/web/src/lib/connections.ts, app/(app)/connections/*, components/sync-now-button.tsx
docs/shopify-connection.md, docs/sync.md, CLAUDE.md
```

---

## Part A: Money and the GraphQL client

### Task 1: Exact money parsing

**Files:**
- Create: `packages/connectors/src/shopify/money.ts`
- Modify: `packages/connectors/src/shopify/index.ts` (`export * from './money';`)
- Test: `packages/connectors/test/shopify-money.test.ts`

**Interfaces:**
- Produces: `minorUnitExponent(currency: string): number` (0 for `BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF`; 3 for `BHD IQD JOD KWD LYD OMR TND`; otherwise 2; unknown or lowercase codes are upper-cased first; a non-3-letter code throws `PermanentError`) and `parseMoneyToMinorUnits(amount: string, currency: string): number`.
- Behaviour: accepts `^-?\d{1,15}(\.\d+)?$` after trimming; anything else (empty, `1,000.00`, `1e3`, `1.`, `.5`, `--1`, 16 integer digits, whitespace inside) throws `PermanentError('Shopify returned an unreadable amount.')`. Exact `BigInt` arithmetic: pad or cut the fraction to the exponent; when the fraction has MORE digits than the exponent, round half away from zero on the first dropped digit (digit `>= 5` rounds the magnitude up). The result must be a safe integer (`<= Number.MAX_SAFE_INTEGER`), else `PermanentError`. `-0` is returned as `0`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/connectors/test/shopify-money.test.ts
import { describe, expect, it } from 'vitest';
import { minorUnitExponent, parseMoneyToMinorUnits, PermanentError } from '../src';

describe('minorUnitExponent', () => {
  it.each([['USD', 2], ['EUR', 2], ['JPY', 0], ['KRW', 0], ['vnd', 0], ['KWD', 3], ['BHD', 3], ['usd', 2]] as const)(
    '%s has %i decimals',
    (code, exp) => expect(minorUnitExponent(code)).toBe(exp),
  );
  it('rejects codes that are not three letters', () => {
    for (const bad of ['', 'US', 'USDD', '12A', 'U$D']) expect(() => minorUnitExponent(bad)).toThrow(PermanentError);
  });
});

describe('parseMoneyToMinorUnits', () => {
  it.each([
    ['10.99', 'USD', 1099],
    ['10', 'USD', 1000],
    ['0.5', 'USD', 50],
    ['0.05', 'USD', 5],
    ['0', 'USD', 0],
    ['0.00', 'USD', 0],
    ['1234', 'JPY', 1234],
    ['1234.5', 'JPY', 1235],
    ['1234.4', 'JPY', 1234],
    ['1.234', 'KWD', 1234],
    ['1.2', 'KWD', 1200],
    ['0.005', 'USD', 1],
    ['0.004', 'USD', 0],
    ['0.015', 'USD', 2],
    ['19.999', 'USD', 2000],
    ['-2.50', 'USD', -250],
    ['-0.005', 'USD', -1],
    ['-0', 'USD', 0],
    ['  7.10  ', 'USD', 710],
    ['90071992547409.91', 'USD', 9007199254740991],
  ] as const)('%s %s -> %i', (amount, currency, cents) => {
    expect(parseMoneyToMinorUnits(amount, currency)).toBe(cents);
    expect(Object.is(parseMoneyToMinorUnits(amount, currency), -0)).toBe(false);
  });
  it.each(['', ' ', 'abc', '1,000.00', '1e3', '1.', '.5', '--1', '+1', '1 0', '1.2.3', '1234567890123456', '90071992547409.92', '99999999999999.99'])(
    'rejects %j with a fixed message that does not echo the input',
    (bad) => {
      let message = '';
      try {
        parseMoneyToMinorUnits(bad, 'USD');
      } catch (e) {
        expect(e).toBeInstanceOf(PermanentError);
        message = (e as Error).message;
      }
      expect(message).toBe('Shopify returned an unreadable amount.');
    },
  );
});
```
(The `99999999999999.99` and `90071992547409.92` cases overflow `MAX_SAFE_INTEGER` in cents and must fail with the same fixed message.)

- [ ] **Step 2: Run to see failures** — `pnpm --filter @erq/connectors exec vitest run test/shopify-money.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/connectors/src/shopify/money.ts
// ISO 4217 minor-unit exponents: https://www.iso.org/iso-4217-currency-codes.html
// Shopify money fields are decimal strings: https://shopify.dev/docs/api/admin-graphql/latest/scalars/Money
import { PermanentError } from '../errors';

const ZERO = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
const UNREADABLE = 'Shopify returned an unreadable amount.';

export function minorUnitExponent(currency: string): number {
  const code = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new PermanentError('Shopify returned an unreadable currency.');
  if (ZERO.has(code)) return 0;
  if (THREE.has(code)) return 3;
  return 2;
}

/** Exact decimal-string to minor-unit conversion. Never uses floating point. */
export function parseMoneyToMinorUnits(amount: string, currency: string): number {
  const match = /^(-?)(\d{1,15})(?:\.(\d+))?$/.exec(amount.trim());
  if (!match) throw new PermanentError(UNREADABLE);
  const exponent = minorUnitExponent(currency);
  const negative = match[1] === '-';
  const whole = match[2]!;
  const fraction = (match[3] ?? '').padEnd(exponent, '0');
  let units = BigInt(whole + fraction.slice(0, exponent));
  // Round half away from zero on the first dropped digit.
  if (fraction.length > exponent && fraction.charCodeAt(exponent) >= 53 /* '5' */) units += 1n;
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new PermanentError(UNREADABLE);
  const value = Number(units);
  return negative && value !== 0 ? -value : value;
}
```

- [ ] **Step 4: Run** — `pnpm turbo run test typecheck build --filter=@erq/connectors --concurrency=1` and `pnpm exec eslint packages/connectors` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors
git commit -m "feat(connectors): add exact decimal-string money parsing for Shopify

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The GraphQL client and the fake Shopify Admin

**Files:**
- Create: `packages/connectors/src/shopify/graphql.ts`, `packages/connectors/src/testing/fake-shopify-admin.ts`
- Modify: `packages/connectors/src/shopify/index.ts`, `packages/connectors/src/testing/index.ts`
- Test: `packages/connectors/test/shopify-graphql.test.ts`

**Interfaces:**
- Produces:
  - `interface GraphqlOperation<T> { name: string; document: string; schema: z.ZodType<T> }`
  - `interface GraphqlContext { externalAccountId: string; credentials: unknown }`
  - `createShopifyGraphqlClient(opts: { http: HttpClient; apiVersion?: string }): { query<T>(ctx: GraphqlContext, op: GraphqlOperation<T>, variables: Record<string, unknown>): Promise<{ data: T; cost: number }> }`. `apiVersion` defaults to `SHOPIFY_API_VERSION`.
  - Testing (in `@erq/connectors/testing`): `class FakeShopifyAdmin implements HttpClient` with `requests: HttpRequest[]`, `on(operationName: string, handler: (variables: Record<string, unknown>, callIndex: number) => unknown): this` (the handler returns the FULL JSON body object), `failNext(status: number, headers?: Record<string,string>)`, `respondNext(res: { status: number; body: string; headers?: Record<string,string> })`, `callsOf(operationName: string): number`; helpers `gqlOk(data: unknown, cost?: { requested?: number; actual?: number; available?: number; max?: number; restoreRate?: number }): unknown` (wraps `data` with `extensions.cost`, defaults requested 100, actual 40, available 960, max 1000, restoreRate 50) and `gqlThrottled(cost?: { requested?: number; available?: number; restoreRate?: number }): unknown` (HTTP 200 body with `errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }]` and the cost extension), and `paginate<T>(items: T[], first: number, after: string | null): { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }` (cursor = the index of the last returned item as a string; `after` resumes after that index).
- Client behaviour (all messages FIXED strings; never include the response body, token, query text or variables):
  1. `isValidShopDomain(ctx.externalAccountId)` else `PermanentError('Invalid shop domain')` before any request.
  2. credentials must satisfy `{ accessToken: non-empty string }` else `AuthError('Stored credentials are unusable. Reconnect the store.')`.
  3. POST `https://<shop>/admin/api/<apiVersion>/graphql.json` with headers `content-type: application/json`, `accept: application/json`, `X-Shopify-Access-Token`, body `JSON.stringify({ query: op.document, variables, operationName: op.name })`.
  4. HTTP 401/403 → `AuthError('Shopify rejected the access token.')`; 429 → `RateLimitedError(retry-after seconds * 1000, default 2000, blank/negative/non-numeric treated as missing)`; >= 500 and network failures (already `TransientError` from the HTTP client) → `TransientError('Shopify is temporarily unavailable')`; any other non-200 → `PermanentError('Shopify returned an unexpected response.')`.
  5. Body must be JSON matching the envelope `{ data?: unknown, errors?: { message?: string, extensions?: { code?: string } }[], extensions?: { cost?: { requestedQueryCost?: number, actualQueryCost?: number | null, throttleStatus?: { maximumAvailable?: number, currentlyAvailable?: number, restoreRate?: number } } } }` else `PermanentError('Shopify returned an unexpected response.')`.
  6. `errors` present: any `THROTTLED` → `RateLimitedError(waitMs)` where `waitMs = clamp(ceil((requestedQueryCost - currentlyAvailable) / restoreRate * 1000), 500, 60000)` and 2000 when the cost data is missing or `restoreRate <= 0`; any `ACCESS_DENIED` → `PermanentError('Shopify did not allow this request. Check the app\'s permissions.')`; anything else → `PermanentError('Shopify returned an unexpected response.')`.
  7. No `errors`: parse `data` with `op.schema` (failure → the same unexpected-response `PermanentError`); `cost` = `actualQueryCost ?? requestedQueryCost ?? 0`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/connectors/test/shopify-graphql.test.ts
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { AuthError, createShopifyGraphqlClient, PermanentError, RateLimitedError, TransientError } from '../src';
import { FakeShopifyAdmin, gqlOk, gqlThrottled, paginate } from '../src/testing';

const op = { name: 'Ping', document: 'query Ping { shop { name } }', schema: z.object({ shop: z.object({ name: z.string() }) }) };
const ctx = { externalAccountId: 'a.myshopify.com', credentials: { accessToken: 'shpat_secret_token_value' } };
const clientFor = (admin: FakeShopifyAdmin, apiVersion?: string) => createShopifyGraphqlClient({ http: admin, apiVersion });

describe('createShopifyGraphqlClient', () => {
  it('posts the documented request and returns parsed data with the actual query cost', async () => {
    const admin = new FakeShopifyAdmin().on('Ping', () => gqlOk({ shop: { name: 'Acme' } }, { actual: 42 }));
    const res = await clientFor(admin, '2025-07').query(ctx, op, { x: 1 });
    expect(res).toEqual({ data: { shop: { name: 'Acme' } }, cost: 42 });
    const req = admin.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://a.myshopify.com/admin/api/2025-07/graphql.json');
    expect(req.headers?.['X-Shopify-Access-Token']).toBe('shpat_secret_token_value');
    expect(JSON.parse(req.body!)).toEqual({ query: op.document, variables: { x: 1 }, operationName: 'Ping' });
  });
  it('rejects an invalid shop and unusable credentials before any request', async () => {
    const admin = new FakeShopifyAdmin();
    const c = clientFor(admin);
    await expect(c.query({ ...ctx, externalAccountId: 'evil.com' }, op, {})).rejects.toBeInstanceOf(PermanentError);
    for (const credentials of [null, undefined, {}, { accessToken: '' }, { accessToken: 5 }, 'shpat_x']) {
      await expect(c.query({ ...ctx, credentials }, op, {})).rejects.toBeInstanceOf(AuthError);
    }
    expect(admin.requests).toHaveLength(0);
  });
  it.each([[401, AuthError], [403, AuthError], [500, TransientError], [502, TransientError], [404, PermanentError], [418, PermanentError]] as const)(
    'maps HTTP %i',
    async (status, type) => {
      const admin = new FakeShopifyAdmin();
      admin.failNext(status);
      await expect(clientFor(admin).query(ctx, op, {})).rejects.toBeInstanceOf(type);
    },
  );
  it('maps HTTP 429 to a rate limit using retry-after, with a safe default', async () => {
    for (const [header, expected] of [['3', 3000], ['', 2000], ['abc', 2000], ['-1', 2000], [undefined, 2000]] as const) {
      const admin = new FakeShopifyAdmin();
      admin.failNext(429, header === undefined ? {} : { 'retry-after': header });
      const err = await clientFor(admin).query(ctx, op, {}).catch((e) => e);
      expect(err).toBeInstanceOf(RateLimitedError);
      expect((err as RateLimitedError).retryAfterMs).toBe(expected);
    }
  });
  it('maps a THROTTLED GraphQL error to a wait computed from the throttle status', async () => {
    const admin = new FakeShopifyAdmin().on('Ping', () => gqlThrottled({ requested: 600, available: 100, restoreRate: 50 }));
    const err = await clientFor(admin).query(ctx, op, {}).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterMs).toBe(10_000); // (600 - 100) / 50 s
  });
  it('clamps the throttle wait and defaults it when the cost data is missing', async () => {
    const tiny = new FakeShopifyAdmin().on('Ping', () => gqlThrottled({ requested: 101, available: 100, restoreRate: 50 }));
    expect(((await clientFor(tiny).query(ctx, op, {}).catch((e) => e)) as RateLimitedError).retryAfterMs).toBe(500);
    const huge = new FakeShopifyAdmin().on('Ping', () => gqlThrottled({ requested: 100000, available: 0, restoreRate: 1 }));
    expect(((await clientFor(huge).query(ctx, op, {}).catch((e) => e)) as RateLimitedError).retryAfterMs).toBe(60_000);
    const none = new FakeShopifyAdmin().on('Ping', () => ({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }));
    expect(((await clientFor(none).query(ctx, op, {}).catch((e) => e)) as RateLimitedError).retryAfterMs).toBe(2000);
  });
  it('maps ACCESS_DENIED and other GraphQL errors to permanent errors with fixed messages', async () => {
    const denied = new FakeShopifyAdmin().on('Ping', () => ({ errors: [{ message: 'Access denied for customer field', extensions: { code: 'ACCESS_DENIED' } }] }));
    const e1 = await clientFor(denied).query(ctx, op, {}).catch((e) => e);
    expect(e1).toBeInstanceOf(PermanentError);
    expect(e1.message).toBe("Shopify did not allow this request. Check the app's permissions.");
    const other = new FakeShopifyAdmin().on('Ping', () => ({ errors: [{ message: 'Field x does not exist ' + 'shpat_leak' }] }));
    const e2 = await clientFor(other).query(ctx, op, {}).catch((e) => e);
    expect(e2).toBeInstanceOf(PermanentError);
    expect(e2.message).toBe('Shopify returned an unexpected response.');
  });
  it('rejects malformed bodies and data that fails the schema, without echoing anything', async () => {
    const bodies = ['not json', '[]', '{"data": {"shop": {"name": 5}}}', '{"data": null}', '{}'];
    for (const body of bodies) {
      const admin = new FakeShopifyAdmin();
      admin.respondNext({ status: 200, body });
      const err = await clientFor(admin).query(ctx, op, {}).catch((e) => e);
      expect(err).toBeInstanceOf(PermanentError);
      expect(err.message).toBe('Shopify returned an unexpected response.');
    }
  });
  it('never puts the token, the query or the variables into any error message', async () => {
    const admin = new FakeShopifyAdmin();
    admin.failNext(500);
    const err = await clientFor(admin).query(ctx, op, { secretVariable: 'zzz' }).catch((e) => e);
    expect(err.message).not.toMatch(/shpat_|Ping|zzz|shop \{/);
  });
});

describe('paginate', () => {
  it('walks a list with cursors', () => {
    const items = [1, 2, 3, 4, 5];
    const first = paginate(items, 2, null);
    expect(first).toEqual({ nodes: [1, 2], pageInfo: { hasNextPage: true, endCursor: '1' } });
    const second = paginate(items, 2, first.pageInfo.endCursor);
    expect(second).toEqual({ nodes: [3, 4], pageInfo: { hasNextPage: true, endCursor: '3' } });
    expect(paginate(items, 2, second.pageInfo.endCursor)).toEqual({ nodes: [5], pageInfo: { hasNextPage: false, endCursor: '4' } });
    expect(paginate([], 2, null)).toEqual({ nodes: [], pageInfo: { hasNextPage: false, endCursor: null } });
  });
});
```

- [ ] **Step 2: Run to see failures** — `pnpm --filter @erq/connectors exec vitest run test/shopify-graphql.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/connectors/src/shopify/graphql.ts
// https://shopify.dev/docs/api/admin-graphql  (request shape)
// https://shopify.dev/docs/api/usage/rate-limits#graphql-admin-api-rate-limits  (cost, THROTTLED, throttleStatus)
import { z } from 'zod';
import { AuthError, PermanentError, RateLimitedError, TransientError } from '../errors';
import { SHOPIFY_API_VERSION } from './config';
import { isValidShopDomain } from './domain';
import type { HttpClient } from './http';

export interface GraphqlOperation<T> {
  name: string;
  document: string;
  schema: z.ZodType<T>;
}
export interface GraphqlContext {
  externalAccountId: string;
  /** Decrypted credentials. Never log this. */
  credentials: unknown;
}

const credentialsSchema = z.object({ accessToken: z.string().min(1) });
const envelope = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ message: z.string().optional(), extensions: z.object({ code: z.string().optional() }).passthrough().optional() }).passthrough()).optional(),
  extensions: z
    .object({
      cost: z
        .object({
          requestedQueryCost: z.number().optional(),
          actualQueryCost: z.number().nullable().optional(),
          throttleStatus: z
            .object({ maximumAvailable: z.number().optional(), currentlyAvailable: z.number().optional(), restoreRate: z.number().optional() })
            .partial()
            .optional(),
        })
        .optional(),
    })
    .passthrough()
    .optional(),
});

const UNEXPECTED = 'Shopify returned an unexpected response.';

function throttleWaitMs(cost: z.infer<typeof envelope>['extensions']): number {
  const c = cost?.cost;
  const requested = c?.requestedQueryCost;
  const available = c?.throttleStatus?.currentlyAvailable;
  const rate = c?.throttleStatus?.restoreRate;
  if (requested === undefined || available === undefined || rate === undefined || rate <= 0) return 2000;
  return Math.min(60_000, Math.max(500, Math.ceil(((requested - available) / rate) * 1000)));
}

export function createShopifyGraphqlClient(opts: { http: HttpClient; apiVersion?: string }) {
  const apiVersion = opts.apiVersion ?? SHOPIFY_API_VERSION;
  return {
    async query<T>(
      ctx: GraphqlContext,
      op: GraphqlOperation<T>,
      variables: Record<string, unknown>,
    ): Promise<{ data: T; cost: number }> {
      if (!isValidShopDomain(ctx.externalAccountId)) throw new PermanentError('Invalid shop domain');
      const creds = credentialsSchema.safeParse(ctx.credentials);
      if (!creds.success) throw new AuthError('Stored credentials are unusable. Reconnect the store.');
      const res = await opts.http.request({
        method: 'POST',
        url: `https://${ctx.externalAccountId}/admin/api/${apiVersion}/graphql.json`,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'X-Shopify-Access-Token': creds.data.accessToken,
        },
        body: JSON.stringify({ query: op.document, variables, operationName: op.name }),
      });
      if (res.status === 401 || res.status === 403) throw new AuthError('Shopify rejected the access token.');
      if (res.status === 429) {
        const raw = (res.headers['retry-after'] ?? '').trim();
        const seconds = raw === '' ? Number.NaN : Number(raw);
        throw new RateLimitedError(Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 2000);
      }
      if (res.status >= 500) throw new TransientError('Shopify is temporarily unavailable');
      if (res.status !== 200) throw new PermanentError(UNEXPECTED);
      let parsed: z.infer<typeof envelope>;
      try {
        parsed = envelope.parse(JSON.parse(res.body));
      } catch {
        throw new PermanentError(UNEXPECTED);
      }
      if (parsed.errors && parsed.errors.length > 0) {
        const codes = parsed.errors.map((e) => e.extensions?.code);
        if (codes.includes('THROTTLED')) throw new RateLimitedError(throttleWaitMs(parsed.extensions));
        if (codes.includes('ACCESS_DENIED')) {
          throw new PermanentError("Shopify did not allow this request. Check the app's permissions.");
        }
        throw new PermanentError(UNEXPECTED);
      }
      const data = op.schema.safeParse(parsed.data);
      if (!data.success) throw new PermanentError(UNEXPECTED);
      const cost = parsed.extensions?.cost;
      return { data: data.data, cost: cost?.actualQueryCost ?? cost?.requestedQueryCost ?? 0 };
    },
  };
}
export type ShopifyGraphqlClient = ReturnType<typeof createShopifyGraphqlClient>;
```

```ts
// packages/connectors/src/testing/fake-shopify-admin.ts
import type { HttpClient, HttpRequest, HttpResponse } from '../shopify/http';

type Handler = (variables: Record<string, unknown>, callIndex: number) => unknown;
interface CostOpts { requested?: number; actual?: number; available?: number; max?: number; restoreRate?: number }

const costExtension = (c: CostOpts) => ({
  cost: {
    requestedQueryCost: c.requested ?? 100,
    actualQueryCost: c.actual ?? 40,
    throttleStatus: { maximumAvailable: c.max ?? 1000, currentlyAvailable: c.available ?? 960, restoreRate: c.restoreRate ?? 50 },
  },
});

export const gqlOk = (data: unknown, cost: CostOpts = {}): unknown => ({ data, extensions: costExtension(cost) });
export const gqlThrottled = (cost: CostOpts = {}): unknown => ({
  errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
  extensions: costExtension({ available: 0, ...cost }),
});

/** Cursor = index of the last returned item; `after` resumes after that index. */
export function paginate<T>(items: T[], first: number, after: string | null) {
  const start = after === null ? 0 : Number(after) + 1;
  const nodes = items.slice(start, start + first);
  const last = start + nodes.length - 1;
  return {
    nodes,
    pageInfo: { hasNextPage: start + nodes.length < items.length, endCursor: nodes.length > 0 ? String(last) : null },
  };
}

/** In-memory Shopify Admin GraphQL endpoint for tests. Dispatches on `operationName`; records every request. */
export class FakeShopifyAdmin implements HttpClient {
  readonly requests: HttpRequest[] = [];
  private readonly handlers = new Map<string, Handler>();
  private readonly counts = new Map<string, number>();
  private readonly scripted: HttpResponse[] = [];

  on(operationName: string, handler: Handler): this {
    this.handlers.set(operationName, handler);
    return this;
  }
  failNext(status: number, headers: Record<string, string> = {}): void {
    this.scripted.push({ status, headers, body: '{}' });
  }
  respondNext(res: { status: number; body: string; headers?: Record<string, string> }): void {
    this.scripted.push({ status: res.status, headers: res.headers ?? {}, body: res.body });
  }
  callsOf(operationName: string): number {
    return this.counts.get(operationName) ?? 0;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    const scripted = this.scripted.shift();
    if (scripted) return scripted;
    let body: { operationName?: string; variables?: Record<string, unknown> };
    try {
      body = JSON.parse(req.body ?? '{}');
    } catch {
      return { status: 400, headers: {}, body: '{}' };
    }
    const name = body.operationName ?? '';
    const handler = this.handlers.get(name);
    if (!handler) return { status: 404, headers: {}, body: '{}' };
    const index = this.counts.get(name) ?? 0;
    this.counts.set(name, index + 1);
    return { status: 200, headers: {}, body: JSON.stringify(handler(body.variables ?? {}, index)) };
  }
}
```
Export both new modules from the barrels (`shopify/index.ts`: `export * from './graphql';`; `testing/index.ts`: `export * from './fake-shopify-admin';`). Confirm the THROTTLED code, the `extensions.cost` shape and the `throttleStatus` field names against Shopify's rate-limit documentation and report differences.

- [ ] **Step 4: Run** — `pnpm turbo run test typecheck build --filter=@erq/connectors --concurrency=1` and `pnpm exec eslint packages/connectors` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors
git commit -m "feat(connectors): add the Shopify GraphQL client and a fake Shopify Admin

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Part B: The five resources

Layout refinement: instead of one `queries.ts` and one `normalize.ts`, each resource lives in its own module (`locations.ts`, `products.ts`, `inventory.ts`, `orders.ts`) containing its GraphQL operations, zod schemas, pure normalizer and a `fetch<Resource>` function; `cursor.ts` is shared. Each `fetch<Resource>(gql, ctx, cursor, options)` returns `Page<Normalized…>` where `nextCursor` is `encodeCursor(endCursor)` when `hasNextPage` is true, else `null`, and `cost` is the sum of the calls' costs. All use the page sizes `LOCATIONS_PAGE = 100`, `PRODUCTS_PAGE = 25`, `INVENTORY_PAGE = 50`, `ORDERS_PAGE = 50`, and a shared bound `MAX_EXTRA_PAGES = 20` for nested lists.

### Task 3: Cursor, locations and products

**Files:**
- Create: `packages/connectors/src/shopify/{cursor,locations,products}.ts`
- Modify: `packages/connectors/src/shopify/index.ts` (export all three)
- Test: `packages/connectors/test/shopify-cursor.test.ts`, `shopify-locations.test.ts`, `shopify-products.test.ts`

**Interfaces:**
- Produces:
  - `encodeCursor(after: string | null): string` (base64url of `{"v":1,"after":<string|null>}`) and `decodeCursor(cursor: string | null): string | null` (null stays null; anything not canonical base64url, not valid JSON, with `v !== 1`, extra keys, or an empty-string `after` → `PermanentError('Invalid sync cursor.')`; the decoder re-encodes and requires equality with the input so non-canonical encodings are rejected).
  - `fetchLocations(gql: ShopifyGraphqlClient, ctx: GraphqlContext, cursor: string | null): Promise<Page<NormalizedLocation>>` and `normalizeLocation(node): NormalizedLocation`.
  - `fetchProducts(gql, ctx, cursor, options: FetchOptions): Promise<Page<NormalizedProduct>>`, `normalizeVariant(node, shopCurrency)`, `normalizeProduct(node, variantNodes, shopCurrency)`.
- Operations (names are the dispatch keys of the fake; confirm each field against Shopify's current Admin GraphQL reference and cite the doc links in comments):

```graphql
query ErqLocations($first: Int!, $after: String) {
  locations(first: $first, after: $after, includeInactive: true) {
    nodes { id name isActive isFulfillmentService address { formatted } }
    pageInfo { hasNextPage endCursor }
  }
}
query ErqProducts($first: Int!, $after: String, $query: String) {
  shop { currencyCode }
  products(first: $first, after: $after, query: $query) {
    nodes {
      id title vendor productType status updatedAt
      variants(first: 100) {
        nodes { id sku barcode price compareAtPrice updatedAt inventoryItem { unitCost { amount currencyCode } } }
        pageInfo { hasNextPage endCursor }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
query ErqProductVariants($id: ID!, $first: Int!, $after: String) {
  product(id: $id) {
    variants(first: $first, after: $after) {
      nodes { id sku barcode price compareAtPrice updatedAt inventoryItem { unitCost { amount currencyCode } } }
      pageInfo { hasNextPage endCursor }
    }
  }
}
```
- Mapping rules: location `type` is `3pl` when `isFulfillmentService`, else `warehouse`; `address` is the `formatted` lines joined with `, ` (empty or null → `null`). Variant: `skuCode` and `barcode` are trimmed, empty string → `null`; `priceCents`/`compareAtPriceCents` via `parseMoneyToMinorUnits(amount, shopCurrency)` (compare-at `null` stays `null`); `currency = shopCurrency` (from `shop.currencyCode`); `unitCostCents` = parsed cost only when `unitCost.currencyCode === shopCurrency`, else `null` (one currency per org); `updatedAt = new Date(updatedAt)`. Product: `brand = vendor.trim() || null`, `category = productType.trim() || null`, `status` `ACTIVE→active`, `DRAFT→draft`, `ARCHIVED→archived` (any other value → `PermanentError`), a product with no variants is returned with `variants: []`. Filter: `options.updatedSince` → `query` variable `updated_at:>='<ISO>'` (ISO from `toISOString()`), otherwise `null` (backfill imports every product). More than 100 variants: while `variants.pageInfo.hasNextPage`, call `ErqProductVariants` with the product `id` (page 100) up to `MAX_EXTRA_PAGES`; if still `hasNextPage` afterwards throw `PermanentError('A product has too many variants to import.')`. `cost` sums every call.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/connectors/test/shopify-cursor.test.ts
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, PermanentError } from '../src';

describe('cursor', () => {
  it('round-trips and keeps null', () => {
    expect(decodeCursor(null)).toBeNull();
    for (const after of [null, 'eyJsYXN0X2lkIjoxMjM0fQ==', 'a/b+c=', '0']) expect(decodeCursor(encodeCursor(after))).toBe(after);
    expect(encodeCursor('x')).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it.each([
    '', 'abc', '!!!', 'e30', // not valid / not our shape
    Buffer.from('{"v":2,"after":null}').toString('base64url'),
    Buffer.from('{"v":1,"after":null,"x":1}').toString('base64url'),
    Buffer.from('{"v":1,"after":""}').toString('base64url'),
    Buffer.from('{"v":1,"after":5}').toString('base64url'),
    Buffer.from('{"v":1}').toString('base64url'),
    Buffer.from('{"v":1,"after":null}').toString('base64'), // standard base64 with padding: not canonical
  ])('rejects %j', (bad) => {
    expect(() => decodeCursor(bad)).toThrow(PermanentError);
  });
});
```

```ts
// packages/connectors/test/shopify-locations.test.ts
import { describe, expect, it } from 'vitest';
import { createShopifyGraphqlClient, decodeCursor, encodeCursor, fetchLocations, normalizeLocation } from '../src';
import { FakeShopifyAdmin, gqlOk, paginate } from '../src/testing';

const ctx = { externalAccountId: 'a.myshopify.com', credentials: { accessToken: 'shpat_x' } };
const nodes = [
  { id: 'gid://shopify/Location/1', name: 'Main warehouse', isActive: true, isFulfillmentService: false, address: { formatted: ['1 Main St', 'Austin TX 78701', 'United States'] } },
  { id: 'gid://shopify/Location/2', name: 'ShipBob', isActive: true, isFulfillmentService: true, address: null },
  { id: 'gid://shopify/Location/3', name: 'Old shop', isActive: false, isFulfillmentService: false, address: { formatted: [] } },
];
const adminFor = () =>
  new FakeShopifyAdmin().on('ErqLocations', (v) => gqlOk({ locations: paginate(nodes, v.first as number, (v.after as string | null) ?? null) }));

describe('locations', () => {
  it('normalizes and maps types, addresses and activity', () => {
    expect(nodes.map(normalizeLocation)).toEqual([
      { externalId: 'gid://shopify/Location/1', name: 'Main warehouse', type: 'warehouse', address: '1 Main St, Austin TX 78701, United States', isActive: true },
      { externalId: 'gid://shopify/Location/2', name: 'ShipBob', type: '3pl', address: null, isActive: true },
      { externalId: 'gid://shopify/Location/3', name: 'Old shop', type: 'warehouse', address: null, isActive: false },
    ]);
  });
  it('pages with opaque cursors and ends with a null cursor', async () => {
    const admin = adminFor();
    const gql = createShopifyGraphqlClient({ http: admin });
    const first = await fetchLocations(gql, ctx, null);
    expect(first.items).toHaveLength(3); // page size 100 covers all three
    expect(first.nextCursor).toBeNull();
    expect(first.cost).toBe(40);
    const vars = JSON.parse(admin.requests[0]!.body!).variables;
    expect(vars).toEqual({ first: 100, after: null });
  });
  it('sends the decoded cursor back to Shopify when continuing', async () => {
    const admin = new FakeShopifyAdmin().on('ErqLocations', (v) =>
      gqlOk({ locations: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'NEXT' } } }),
    );
    const gql = createShopifyGraphqlClient({ http: admin });
    const page = await fetchLocations(gql, ctx, encodeCursor('PREV'));
    expect(JSON.parse(admin.requests[0]!.body!).variables.after).toBe('PREV');
    expect(decodeCursor(page.nextCursor)).toBe('NEXT');
  });
});
```

```ts
// packages/connectors/test/shopify-products.test.ts
import { describe, expect, it } from 'vitest';
import { createShopifyGraphqlClient, decodeCursor, fetchProducts, PermanentError } from '../src';
import { FakeShopifyAdmin, gqlOk, paginate } from '../src/testing';

const ctx = { externalAccountId: 'a.myshopify.com', credentials: { accessToken: 'shpat_x' } };
const variant = (n: number, over: Record<string, unknown> = {}) => ({
  id: `gid://shopify/ProductVariant/${n}`, sku: `SKU-${n}`, barcode: null, price: '19.99', compareAtPrice: null,
  updatedAt: '2026-03-01T10:00:00Z', inventoryItem: { unitCost: { amount: '7.50', currencyCode: 'USD' } }, ...over,
});
const product = (n: number, variants: unknown[], over: Record<string, unknown> = {}) => ({
  id: `gid://shopify/Product/${n}`, title: `Product ${n}`, vendor: 'Acme', productType: 'Shirts', status: 'ACTIVE',
  updatedAt: '2026-03-02T10:00:00Z', variants: { nodes: variants, pageInfo: { hasNextPage: false, endCursor: null } }, ...over,
});
const productsHandler = (items: unknown[], currency = 'USD') => (v: Record<string, unknown>) =>
  gqlOk({ shop: { currencyCode: currency }, products: paginate(items, v.first as number, (v.after as string | null) ?? null) });
const gqlOf = (admin: FakeShopifyAdmin) => createShopifyGraphqlClient({ http: admin });

describe('products', () => {
  it('normalizes variants, costs, status, brand and category', async () => {
    const items = [
      product(1, [variant(1), variant(2, { sku: '  ', barcode: ' 123 ', compareAtPrice: '29.00', inventoryItem: { unitCost: null } })]),
      product(2, [variant(3, { inventoryItem: null, price: '5' })], { vendor: ' ', productType: '', status: 'DRAFT' }),
      product(3, [], { status: 'ARCHIVED' }),
    ];
    const admin = new FakeShopifyAdmin().on('ErqProducts', productsHandler(items));
    const page = await fetchProducts(gqlOf(admin), ctx, null, {});
    expect(page.nextCursor).toBeNull();
    expect(page.items).toEqual([
      { externalId: 'gid://shopify/Product/1', title: 'Product 1', brand: 'Acme', category: 'Shirts', status: 'active', updatedAt: new Date('2026-03-02T10:00:00Z'),
        variants: [
          { externalId: 'gid://shopify/ProductVariant/1', skuCode: 'SKU-1', barcode: null, priceCents: 1999, compareAtPriceCents: null, currency: 'USD', unitCostCents: 750, updatedAt: new Date('2026-03-01T10:00:00Z') },
          { externalId: 'gid://shopify/ProductVariant/2', skuCode: null, barcode: '123', priceCents: 1999, compareAtPriceCents: 2900, currency: 'USD', unitCostCents: null, updatedAt: new Date('2026-03-01T10:00:00Z') },
        ] },
      { externalId: 'gid://shopify/Product/2', title: 'Product 2', brand: null, category: null, status: 'draft', updatedAt: new Date('2026-03-02T10:00:00Z'),
        variants: [{ externalId: 'gid://shopify/ProductVariant/3', skuCode: 'SKU-3', barcode: null, priceCents: 500, compareAtPriceCents: null, currency: 'USD', unitCostCents: null, updatedAt: new Date('2026-03-01T10:00:00Z') }] },
      { externalId: 'gid://shopify/Product/3', title: 'Product 3', brand: 'Acme', category: 'Shirts', status: 'archived', updatedAt: new Date('2026-03-02T10:00:00Z'), variants: [] },
    ]);
  });
  it('ignores a unit cost in another currency and handles zero-decimal shops', async () => {
    const items = [product(1, [variant(1, { price: '1500', inventoryItem: { unitCost: { amount: '700', currencyCode: 'JPY' } } }), variant(2, { price: '1500', inventoryItem: { unitCost: { amount: '7.00', currencyCode: 'USD' } } })])];
    const admin = new FakeShopifyAdmin().on('ErqProducts', productsHandler(items, 'JPY'));
    const page = await fetchProducts(gqlOf(admin), ctx, null, {});
    expect(page.items[0]!.variants.map((x) => [x.priceCents, x.unitCostCents, x.currency])).toEqual([[1500, 700, 'JPY'], [1500, null, 'JPY']]);
  });
  it('pages 25 products at a time and decodes/encodes cursors', async () => {
    const items = Array.from({ length: 30 }, (_, i) => product(i + 1, [variant(i + 1)]));
    const admin = new FakeShopifyAdmin().on('ErqProducts', productsHandler(items));
    const first = await fetchProducts(gqlOf(admin), ctx, null, {});
    expect(first.items).toHaveLength(25);
    expect(first.nextCursor).not.toBeNull();
    expect(decodeCursor(first.nextCursor)).toBe('24');
    const second = await fetchProducts(gqlOf(admin), ctx, first.nextCursor, {});
    expect(second.items.map((p) => p.title)).toEqual(['Product 26', 'Product 27', 'Product 28', 'Product 29', 'Product 30']);
    expect(second.nextCursor).toBeNull();
  });
  it('sends the updated_at filter only for incrementals', async () => {
    const admin = new FakeShopifyAdmin().on('ErqProducts', productsHandler([]));
    await fetchProducts(gqlOf(admin), ctx, null, {});
    await fetchProducts(gqlOf(admin), ctx, null, { since: new Date('2026-01-01T00:00:00Z') });
    await fetchProducts(gqlOf(admin), ctx, null, { updatedSince: new Date('2026-02-03T04:05:06.000Z') });
    const queries = admin.requests.map((r) => JSON.parse(r.body!).variables.query);
    expect(queries).toEqual([null, null, "updated_at:>='2026-02-03T04:05:06.000Z'"]);
  });
  it('fetches the remaining variants of a product with more than 100 variants', async () => {
    const all = Array.from({ length: 250 }, (_, i) => variant(i + 1));
    const first = paginate(all, 100, null);
    const items = [product(1, first.nodes, {})];
    (items[0] as { variants: unknown }).variants = first;
    const admin = new FakeShopifyAdmin()
      .on('ErqProducts', productsHandler(items))
      .on('ErqProductVariants', (v) => gqlOk({ product: { variants: paginate(all, v.first as number, (v.after as string | null) ?? null) } }));
    const page = await fetchProducts(gqlOf(admin), ctx, null, {});
    expect(page.items[0]!.variants).toHaveLength(250);
    expect(new Set(page.items[0]!.variants.map((x) => x.externalId)).size).toBe(250);
    expect(admin.callsOf('ErqProductVariants')).toBe(2);
    expect(page.cost).toBe(40 * 3);
  });
  it('fails loudly instead of truncating when a product has an absurd number of variants', async () => {
    const all = Array.from({ length: 2300 }, (_, i) => variant(i + 1));
    const first = paginate(all, 100, null);
    const items = [{ ...product(1, []), variants: first }];
    const admin = new FakeShopifyAdmin()
      .on('ErqProducts', productsHandler(items))
      .on('ErqProductVariants', (v) => gqlOk({ product: { variants: paginate(all, v.first as number, (v.after as string | null) ?? null) } }));
    const err = await fetchProducts(gqlOf(admin), ctx, null, {}).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.message).toBe('A product has too many variants to import.');
  });
  it('rejects an unknown product status and an unreadable price', async () => {
    for (const bad of [product(1, [variant(1)], { status: 'WEIRD' }), product(1, [variant(1, { price: 'abc' })])]) {
      const admin = new FakeShopifyAdmin().on('ErqProducts', productsHandler([bad]));
      await expect(fetchProducts(gqlOf(admin), ctx, null, {})).rejects.toBeInstanceOf(PermanentError);
    }
  });
});
```

- [ ] **Step 2: Run to see failures** — `pnpm --filter @erq/connectors exec vitest run test/shopify-cursor.test.ts test/shopify-locations.test.ts test/shopify-products.test.ts` → FAIL.

- [ ] **Step 3: Implement** `cursor.ts` (zod `.strict()` object `{ v: z.literal(1), after: z.string().min(1).nullable() }`; decode requires `/^[A-Za-z0-9_-]+$/`, parses JSON, validates, and returns `after` only if `encodeCursor(after) === cursor`), `locations.ts` and `products.ts` per the Interfaces block. Operation objects look like `export const PRODUCTS_OP = { name: 'ErqProducts', document: PRODUCTS_DOCUMENT, schema: productsResponse } satisfies GraphqlOperation<…>`; response schemas use `z.object({...})` (zod strips unknown keys by default, which is what we want) with `status: z.string()` mapped by a lookup table. Shared small helpers (`pageInfo` schema `{ hasNextPage: boolean, endCursor: string | null }`, `MAX_EXTRA_PAGES`, the page-size constants, a `nextCursorOf(pageInfo)` that returns `pageInfo.hasNextPage && pageInfo.endCursor ? encodeCursor(pageInfo.endCursor) : null`) live in `cursor.ts`. A `hasNextPage: true` with a null `endCursor` is a `PermanentError('Shopify returned an unexpected response.')` (an infinite-loop guard).

- [ ] **Step 4: Run** — `pnpm turbo run test typecheck build --filter=@erq/connectors --concurrency=1` and `pnpm exec eslint packages/connectors` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors
git commit -m "feat(connectors): fetch Shopify locations and products with variant costs

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Inventory

**Files:**
- Create: `packages/connectors/src/shopify/inventory.ts`; modify `index.ts`
- Test: `packages/connectors/test/shopify-inventory.test.ts`

**Interfaces:**
- Produces: `fetchInventory(gql, ctx, cursor, options): Promise<Page<NormalizedInventoryLevel>>`, `normalizeInventoryLevel(variantId: string, level): NormalizedInventoryLevel`.
- Operations:

```graphql
query ErqInventory($first: Int!, $after: String, $query: String) {
  inventoryItems(first: $first, after: $after, query: $query) {
    nodes {
      id
      variant { id }
      inventoryLevels(first: 50) {
        nodes { updatedAt location { id } quantities(names: ["on_hand", "committed", "reserved", "incoming"]) { name quantity } }
        pageInfo { hasNextPage endCursor }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
query ErqInventoryLevels($id: ID!, $first: Int!, $after: String) {
  inventoryItem(id: $id) {
    inventoryLevels(first: $first, after: $after) {
      nodes { updatedAt location { id } quantities(names: ["on_hand", "committed", "reserved", "incoming"]) { name quantity } }
      pageInfo { hasNextPage endCursor }
    }
  }
}
```
- Mapping: `externalVariantId = item.variant.id`, `locationExternalId = level.location.id`, `onHand = on_hand` (missing name → 0), `reserved = max(0, committed + reserved)`, `incoming = max(0, incoming)`, `updatedAt = new Date(level.updatedAt)`. Items with `variant: null` are skipped. Filter: `options.updatedSince` → `updated_at:>='<ISO>'` else `null`. More than 50 levels on one item: remaining levels via `ErqInventoryLevels` (bounded by `MAX_EXTRA_PAGES`, then `PermanentError('An inventory item has too many locations to import.')`). One `(variant, location)` pair appears at most once (a duplicate pair in the response is a `PermanentError('Shopify returned an unexpected response.')`).

- [ ] **Step 1: Write the failing test** — fixtures built from helpers `level(locationN, qty, updatedAt)` and `item(n, levels, variantId = ...)`; cases: (a) normal mapping incl. `reserved = committed + reserved` (e.g. committed 2 + reserved 1 → 3), missing `incoming` name → 0, negative on_hand kept (e.g. -2), negative committed clamped to 0 when summed; (b) an item with `variant: null` is skipped and not counted; (c) paging 50 items at a time with cursor round trip (60 items → 50 + 10); (d) the `updated_at` filter variable for incrementals only; (e) an item with 120 levels returns all 120 via 2 extra calls with unique `(variant, location)` pairs; (f) 20+ extra pages fails with the fixed message; (g) a duplicate pair fails with the fixed unexpected-response message; (h) an unreadable quantity (`"quantity": "x"`) fails (`PermanentError`). Write them in the style of `shopify-products.test.ts` (same helper pattern with `paginate`).

- [ ] **Step 2: Run to see failures** — `pnpm --filter @erq/connectors exec vitest run test/shopify-inventory.test.ts` → FAIL.

- [ ] **Step 3: Implement** `inventory.ts` per the Interfaces block (same module pattern as products).

- [ ] **Step 4: Run** — `pnpm turbo run test typecheck build --filter=@erq/connectors --concurrency=1` and `pnpm exec eslint packages/connectors` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors
git commit -m "feat(connectors): fetch Shopify inventory levels per location

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Orders

**Files:**
- Create: `packages/connectors/src/shopify/orders.ts`; modify `index.ts`
- Test: `packages/connectors/test/shopify-orders.test.ts`

**Interfaces:**
- Produces: `fetchOrders(gql, ctx, cursor, options): Promise<Page<NormalizedOrder>>` and `normalizeOrder(node, lineNodes): NormalizedOrder`.
- Operations (`MONEY` below stands for `{ shopMoney { amount currencyCode } }`):

```graphql
query ErqOrders($first: Int!, $after: String, $query: String, $sortKey: OrderSortKeys!) {
  orders(first: $first, after: $after, query: $query, sortKey: $sortKey) {
    nodes {
      id createdAt updatedAt cancelledAt closedAt test sourceName
      totalDiscountsSet MONEY
      totalTaxSet MONEY
      totalShippingPriceSet MONEY
      lineItems(first: 100) {
        nodes { id title quantity variant { id } originalUnitPriceSet MONEY totalDiscountSet MONEY }
        pageInfo { hasNextPage endCursor }
      }
      refunds {
        id createdAt totalRefundedSet MONEY
        refundLineItems(first: 100) {
          nodes { quantity restockType lineItem { id } subtotalSet MONEY }
          pageInfo { hasNextPage endCursor }
        }
        refundShippingLines(first: 10) { nodes { subtotalAmountSet MONEY } }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
query ErqOrderLines($id: ID!, $first: Int!, $after: String) {
  order(id: $id) {
    lineItems(first: $first, after: $after) {
      nodes { id title quantity variant { id } originalUnitPriceSet MONEY totalDiscountSet MONEY }
      pageInfo { hasNextPage endCursor }
    }
  }
}
```
(Write the real document with the `MONEY` fragment expanded inline; do NOT use GraphQL fragments so the fake can ignore the document.)
- Filter and sort: backfill with `options.since` → `query = created_at:>='<ISO>'`, `sortKey = CREATED_AT`; incremental with `options.updatedSince` → `query = updated_at:>='<ISO>'`, `sortKey = UPDATED_AT`; neither → `query = null`, `sortKey = CREATED_AT`.
- Mapping (`money(set)` = `parseMoneyToMinorUnits(set.shopMoney.amount, set.shopMoney.currencyCode)`):
  - `currency` = `totalTaxSet.shopMoney.currencyCode`; every other money set of the order must carry the same currency code, else `PermanentError('Shopify returned mixed currencies for one order.')`.
  - Lines: `externalLineId = id`, `externalVariantId = variant?.id ?? null`, `title`, `quantity` (must be an integer `>= 1`; lines with quantity 0 are dropped), `unitPriceCents = money(originalUnitPriceSet)`, `discountCents = min(money(totalDiscountSet), unitPriceCents * quantity)` (never negative).
  - `grossCents = Σ unitPriceCents × quantity` over lines (before discounts, excluding shipping and tax); `discountCents = money(totalDiscountsSet)`; `shippingChargedCents = money(totalShippingPriceSet)`; `taxCents = money(totalTaxSet)`; negative values are clamped to 0 for these four fields only if Shopify sent a negative (never happens in practice; add a test that a negative becomes 0 and is not an error).
  - `channel = sourceName === 'pos' ? 'shopify_pos' : 'shopify_online'`; `status = cancelledAt ? 'cancelled' : closedAt ? 'closed' : 'open'`; `placedAt = createdAt`; `cancelledAt` as Date or null; `isTest = test`; `customerExternalId`, `utmSource`, `utmMedium`, `utmCampaign`, `landingSite` all `null`.
  - Refunds: `refundedAt = createdAt`; refund lines: `externalLineId = lineItem.id`, `quantity` (lines with quantity 0 dropped), `amountCents = money(subtotalSet)` (excludes tax); `shippingRefundCents = Σ money(refundShippingLines.nodes[].subtotalAmountSet)`; `amountCents` = Σ refund-line amounts, or, when the refund has NO line items, `max(0, money(totalRefundedSet) - shippingRefundCents)` (a documented limitation: tax is included in that case); `restock = any refundLineItems.restockType !== 'NO_RESTOCK'`. A refund with `refundLineItems.pageInfo.hasNextPage` → `PermanentError('An order has too many refund lines to import.')`.
  - More than 100 lines: remaining pages via `ErqOrderLines` bounded by `MAX_EXTRA_PAGES`, else `PermanentError('An order has too many lines to import.')`. Duplicate line ids → `PermanentError('Shopify returned an unexpected response.')`.

- [ ] **Step 1: Write the failing test** — helpers `money(amount, code = 'USD')` returning `{ shopMoney: { amount, currencyCode: code } }`, `line(n, qty, unit, discount = '0.00', variant = n)`, `order(n, over)` building a full node, `ordersHandler(items)` that applies the incoming `query` variable (parse `created_at:>='…'` / `updated_at:>='…'` against the node's `createdAt`/`updatedAt` and filter) then `paginate`s with the requested `first`. Cases: (a) a plain online order: lines 2 × 19.99 + 1 × 5.00, order discount 4.00 with line discounts 3.00 + 1.00, shipping 4.99, tax 3.20 → `grossCents = 4498 + 500 = 4998`, `discountCents = 400`, line discounts `[300, 100]`, `shippingChargedCents = 499`, `taxCents = 320`, `currency 'USD'`, `status 'open'`, `channel 'shopify_online'`, customer/UTM fields null; (b) POS (`sourceName: 'pos'`), test (`test: true`), cancelled (`cancelledAt` set), closed (`closedAt` set, not cancelled) map correctly and `cancelledAt` is returned as a Date; (c) a partial refund with two refund lines (quantities 1 and 2, subtotals 19.99 and 10.00), a 4.99 shipping refund and `restockType` `RETURN` → `amountCents = 2999` (the line sums 1999 + 1000), `shippingRefundCents = 499`, `restock true`, `refundedAt` Date; a refund with only `NO_RESTOCK` lines → `restock false`; a refund with no line items and `totalRefundedSet` 10.00 and shipping 2.00 → `amountCents = 800`; a zero-quantity refund line is dropped; (d) JPY order (`1500` per unit × 2, tax `273`, shipping `0`) and a KWD order with three decimals keep exact minor units; (e) mixed currencies inside one order fail with the fixed message; (f) a negative discount set becomes 0; (g) line discount larger than the line total is clamped to it; (h) pagination 50 at a time with cursor round trip (60 orders → 50 + 10) and the backfill/incremental filter and `sortKey` variables (`CREATED_AT` + `created_at:>=` for `since`, `UPDATED_AT` + `updated_at:>=` for `updatedSince`, `CREATED_AT` + `null` for neither); (i) an order with 250 lines returns all lines through 2 extra `ErqOrderLines` calls with unique ids; 2300 lines fails with the fixed message; a duplicate line id fails; (j) a refund whose `refundLineItems.pageInfo.hasNextPage` is true fails with the fixed message; (k) an order with a null variant line gives `externalVariantId: null`; (l) a missing or unreadable money value fails with a `PermanentError` that does not echo the value.

- [ ] **Step 2: Run to see failures** — `pnpm --filter @erq/connectors exec vitest run test/shopify-orders.test.ts` → FAIL.

- [ ] **Step 3: Implement** `orders.ts` per the Interfaces block. Build the nested money schema once (`const moneySet = z.object({ shopMoney: z.object({ amount: z.string(), currencyCode: z.string() }) })`). Normalization is a pure function over validated nodes so the tests can call it directly.

- [ ] **Step 4: Run** — `pnpm turbo run test typecheck build --filter=@erq/connectors --concurrency=1` and `pnpm exec eslint packages/connectors` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors
git commit -m "feat(connectors): fetch Shopify orders with lines, discounts, tax, shipping and refunds

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Part C: The connector, its wiring and the engine

### Task 6: Assemble the connector, the Shopify fixture and the contract suite

**Files:**
- Create: `packages/connectors/src/shopify/connector.ts`, `packages/connectors/src/testing/shopify-fixtures.ts`
- Modify: `packages/connectors/src/shopify/index.ts` (`export * from './connector';`), `packages/connectors/src/testing/index.ts` (`export * from './shopify-fixtures';`)
- Test: `packages/connectors/test/shopify-connector.test.ts`

**Interfaces:**
- Produces:
  - `createShopifyConnector(opts: { http: HttpClient; apiVersion?: string }): StoreConnector`. `fetchPage(ctx, resource, cursor, options)` builds one `createShopifyGraphqlClient` and dispatches on `resource` to `fetchLocations`, `fetchProducts`, `fetchInventory`, `fetchOrders`; `ctx` is `ConnectionContext` (`externalAccountId`, `credentials` are passed through). `connect()` rejects with `PermanentError('Shopify connections are created through the install flow.')`; `handleWebhook()` is a no-op (resolves). The returned `Page<…>` is passed through unchanged (with `cost`).
  - `createShopifyFixture(): { admin: FakeShopifyAdmin; ctx: ConnectionContext; expected: { locations: NormalizedLocation[]; products: NormalizedProduct[]; inventory: NormalizedInventoryLevel[]; orders: NormalizedOrder[] } }` in `@erq/connectors/testing`: a complete shop in Shopify's GraphQL response shape (GIDs) served by `FakeShopifyAdmin` handlers for every operation (`ErqLocations`, `ErqProducts`, `ErqProductVariants`, `ErqInventory`, `ErqInventoryLevels`, `ErqOrders`, `ErqOrderLines`) that apply the `query` variable's `updated_at:>=`/`created_at:>=` filter to the fixture rows (hidden per-row timestamps), honour `first`/`after` with `paginate`, and report costs. Contents (all USD): 2 locations (`Main warehouse`, `ShipBob` as fulfillment service); 3 products with 5 variants in total (costs on 3 of them, one variant without sku, one product draft); inventory items for every variant at both locations (one level with committed and reserved quantities); 5 orders: a plain online order with 2 lines, order discount, shipping and tax; a POS order; a cancelled order; a test order; and an order with a partial refund (two refund lines, shipping refund, restock). `ctx` = `{ connectionId: 'c1', externalAccountId: 'fixture-shop.myshopify.com', credentials: { accessToken: 'shpat_fixture' } }`. `expected` is the hand-written normalized result of the whole fixture (so tests compare exact values, never recompute them with the code under test). Keep page sizes small enough that every resource needs at least 2 pages with the real page constants only for products (25) and orders (50), so also add in the fixture a `bulk(n)` option `createShopifyFixture({ extraOrders?: number })` that appends `n` simple generated orders to exercise paging; `expected.orders` then includes them.

- [ ] **Step 1: Write the failing test**

```ts
// packages/connectors/test/shopify-connector.test.ts
import { describe, expect, it } from 'vitest';
import { createShopifyConnector, SYNC_RESOURCES, type Page, type SyncResource } from '../src';
import { runConnectorContract } from '../src/testing/contract';
import { createShopifyFixture } from '../src/testing';

runConnectorContract({
  name: 'shopify (fixture)',
  create() {
    const { admin, ctx } = createShopifyFixture();
    return { connector: createShopifyConnector({ http: admin }), ctx };
  },
});

async function drain(resource: SyncResource, extraOrders = 0) {
  const { admin, ctx, expected } = createShopifyFixture({ extraOrders });
  const connector = createShopifyConnector({ http: admin });
  const items: unknown[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: Page<unknown> = await connector.fetchPage(ctx, resource, cursor, {});
    items.push(...page.items);
    cursor = page.nextCursor;
    pages++;
  } while (cursor !== null);
  return { items, expected, pages, admin };
}

describe('createShopifyConnector', () => {
  it.each(SYNC_RESOURCES)('returns exactly the expected normalized %s', async (resource) => {
    const { items, expected } = await drain(resource);
    expect(items).toEqual(expected[resource]);
  });
  it('pages orders across more than one request', async () => {
    const { items, expected, pages } = await drain('orders', 70);
    expect(pages).toBe(2);
    expect(items).toEqual(expected.orders);
    expect(items).toHaveLength(75);
  });
  it('never asks Shopify for customer, marketing or other protected fields', async () => {
    const { admin } = await drain('orders');
    const documents = admin.requests.map((r) => (JSON.parse(r.body!) as { query: string }).query).join('\n');
    expect(documents).not.toMatch(/customer\b|email|phone|shippingAddress|billingAddress|customerJourney|landingPage|utm/i);
  });
  it('rejects connect() and ignores webhooks', async () => {
    const { admin } = createShopifyFixture();
    const connector = createShopifyConnector({ http: admin });
    await expect(connector.connect({})).rejects.toThrow('Shopify connections are created through the install flow.');
    await expect(connector.handleWebhook({}, {})).resolves.toBeUndefined();
  });
  it('rejects an unknown resource', async () => {
    const { admin, ctx } = createShopifyFixture();
    const connector = createShopifyConnector({ http: admin });
    await expect(connector.fetchPage(ctx, 'nope' as SyncResource, null, {})).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to see failures** — `pnpm --filter @erq/connectors exec vitest run test/shopify-connector.test.ts` → FAIL.

- [ ] **Step 3: Implement** `connector.ts` and the fixture. Hand-write `expected` independently of the normalizers (type the numbers out). The contract suite (`runConnectorContract`) must pass: finite pages, canonical cursors that advance, exact key sets, no duplicates, `updatedSince` in the future returns nothing for products, inventory and orders.

- [ ] **Step 4: Run** — `pnpm turbo run test typecheck build --filter=@erq/connectors --concurrency=1` and `pnpm exec eslint packages/connectors` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors
git commit -m "feat(connectors): assemble the Shopify store connector with a contract-tested fixture shop

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Scopes, history depth, rate limits and worker registration

**Files:**
- Modify: `packages/connectors/src/shopify/config.ts` (`DEFAULT_SHOPIFY_SCOPES`), `apps/api/src/config/env.ts` (the `SHOPIFY_SCOPES` default), `.env.example`, `packages/sync/src/policies.ts`, `packages/sync/src/index.ts`, `apps/worker/src/main.ts`
- Create: `packages/sync/src/history.ts`
- Test: `packages/sync/test/history.test.ts`, `packages/sync/test/policies.test.ts`, `packages/connectors/test/shopify-config.test.ts`, extend `apps/api/test/env.test.ts`

**Interfaces:**
- `DEFAULT_SHOPIFY_SCOPES = ['read_products', 'read_inventory', 'read_locations', 'read_orders', 'read_all_orders']` and the API's `SHOPIFY_SCOPES` default is the same comma-separated list.
- `ordersBackfillSince(grantedScopes: readonly string[], now: Date): Date` (in `packages/sync/src/history.ts`, exported): 365 days before `now` when `read_all_orders` is in `grantedScopes`, otherwise 60 days; the result is `now` minus whole days in UTC milliseconds (`now.getTime() - days * 86_400_000`); `ORDERS_HISTORY_DAYS = { full: 365, limited: 60 }` exported.
- `RATE_LIMIT_POLICIES.shopify = { capacity: 1000, refillPerSecond: 50, costPerPage: 100 }` with a comment citing https://shopify.dev/docs/api/usage/rate-limits#graphql-admin-api-rate-limits (confirm the standard-plan numbers against that page and report differences; the connector's own `RateLimitedError` handles smaller plans).
- Worker: `apps/worker/src/main.ts` registers `shopify` in the `ConnectorRegistry` it builds for the sync worker: `.register('shopify', createShopifyConnector({ http: createFetchHttpClient(), apiVersion: process.env.SHOPIFY_API_VERSION || undefined }))` (imports from `@erq/connectors`). The worker has no unit test for `main.ts`; add a tiny exported factory `createWorkerConnectors(env: NodeJS.ProcessEnv): ConnectorRegistry` in `apps/worker/src/sync/connectors.ts` that `main.ts` calls, and test the factory (platform `shopify` is registered, `get('shopify')` returns a connector, calling it with a bad credential shape fails with an `AuthError` without any network request, using an injected `http` so the test never touches the network: the factory takes `(env, http = createFetchHttpClient())`).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/sync/test/history.test.ts
import { describe, expect, it } from 'vitest';
import { ORDERS_HISTORY_DAYS, ordersBackfillSince } from '../src';

const NOW = new Date('2026-10-09T12:00:00Z');
describe('ordersBackfillSince', () => {
  it('goes back 365 days when read_all_orders was granted', () => {
    expect(ordersBackfillSince(['read_orders', 'read_all_orders'], NOW)).toEqual(new Date('2025-10-09T12:00:00Z'));
    expect(ORDERS_HISTORY_DAYS).toEqual({ full: 365, limited: 60 });
  });
  it('falls back to 60 days otherwise', () => {
    expect(ordersBackfillSince(['read_orders'], NOW)).toEqual(new Date('2026-08-10T12:00:00Z'));
    expect(ordersBackfillSince([], NOW)).toEqual(new Date('2026-08-10T12:00:00Z'));
  });
  it('matches the scope exactly (no substring or case tricks)', () => {
    for (const scopes of [['read_all_orders_extra'], ['READ_ALL_ORDERS'], ['all_orders'], ['read_orders,read_all_orders']]) {
      expect(ordersBackfillSince(scopes, NOW)).toEqual(new Date('2026-08-10T12:00:00Z'));
    }
  });
});
```

```ts
// packages/sync/test/policies.test.ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_RATE_LIMIT_POLICY, policyFor } from '../src';

describe('rate-limit policies', () => {
  it('uses the Shopify cost bucket for shopify and the default for unknown platforms', () => {
    expect(policyFor('shopify')).toEqual({ capacity: 1000, refillPerSecond: 50, costPerPage: 100 });
    expect(policyFor('woocommerce')).toEqual(DEFAULT_RATE_LIMIT_POLICY);
  });
  it('lets a per-deployment override win', () => {
    expect(policyFor('shopify', { shopify: { capacity: 2000, refillPerSecond: 100, costPerPage: 100 } }).capacity).toBe(2000);
  });
});
```

```ts
// packages/connectors/test/shopify-config.test.ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_SHOPIFY_SCOPES } from '../src';

describe('DEFAULT_SHOPIFY_SCOPES', () => {
  it('requests the read scopes the sync needs plus read_all_orders, and nothing protected', () => {
    expect(DEFAULT_SHOPIFY_SCOPES).toEqual(['read_products', 'read_inventory', 'read_locations', 'read_orders', 'read_all_orders']);
    expect(DEFAULT_SHOPIFY_SCOPES.some((s) => /customer|write_/.test(s))).toBe(false);
  });
});
```
Extend `apps/api/test/env.test.ts`: the default `SHOPIFY_SCOPES` equals `DEFAULT_SHOPIFY_SCOPES.join(',')`. Worker test `apps/worker/test/connectors.test.ts`: `createWorkerConnectors({}, fakeHttp)` registers `shopify`; `get('shopify').fetchPage({ connectionId: 'c', externalAccountId: 'a.myshopify.com', credentials: null }, 'locations', null, {})` rejects with `AuthError` and `fakeHttp.requests` is empty.

- [ ] **Step 2: Run to see failures** — `pnpm --filter @erq/sync exec vitest run test/history.test.ts test/policies.test.ts` and the other new tests → FAIL.

- [ ] **Step 3: Implement** the pieces above. If any existing test asserts the old four scopes or the old placeholder policy, update it to the new values and report which.

- [ ] **Step 4: Run** — `pnpm turbo run build --filter=@erq/connectors`, then `pnpm turbo run test typecheck build --filter=@erq/sync --filter=@erq/worker --filter=@erq/api --concurrency=1` and `pnpm exec eslint packages apps/worker apps/api` → PASS; no leftover postgres processes.

- [ ] **Step 5: Commit**

```bash
git add packages apps .env.example
git commit -m "feat(sync): request read_all_orders, size orders history by the granted scopes, set the Shopify rate-limit policy and register the connector

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Connection health in the engine and a full backfill end to end

**Files:**
- Modify: `packages/sync/src/engine/process.ts`
- Test: extend `packages/sync/test/engine.test.ts` (health), create `packages/sync/test/shopify-engine-e2e.test.ts`

**Interfaces:**
- Engine change: when a page completes a resource (`page.nextCursor === null`) and that job has NO remaining chain (`!job.then || job.then.resources.length === 0`), inside the same transaction update the connection: `store_connections.last_synced_at = now`, and when `status = 'error'` set `status = 'active'` and `last_error = null` (leave `active`/`pending`/`disconnected`/`demo` statuses untouched except `last_synced_at`, and never touch a `disconnected` connection's status; the update is filtered by org and connection id). A chain still in progress does not set it. Failure paths are unchanged.
- E2E harness: reuse `packages/sync/test/engine-helpers.ts` (`makeHarness`, `drain`, `resetSync`) but register the Shopify connector over a `FakeShopifyAdmin` instead of the `FakeConnector`: read `engine-helpers.ts` first; if `makeHarness` hard-codes `FakeConnector`, add an optional `connectors` argument (backwards compatible) rather than copying the harness. The test connection row needs encrypted credentials `{ accessToken: 'shpat_fixture' }` (use `encryptConnectionCredentials` with the harness key and the connection id as AAD) and external account `fixture-shop.myshopify.com`.

- [ ] **Step 1: Write the failing tests**
  - `engine.test.ts` (health): (a) after a single-resource run completes, the connection's `last_synced_at` is set to the run time and status stays `active`; (b) a connection in status `error` returns to `active` with `last_error` null after the final page of a chain; (c) in the middle of a chain (first resource done, `then` remaining) `last_synced_at` stays null and an `error` status is NOT yet recovered; (d) a `disconnected` connection keeps its status and still gets no recovery; (e) a failed run (permanent error) leaves `last_synced_at` unchanged.
  - `shopify-engine-e2e.test.ts` with the fixture shop (`createShopifyFixture`, assertions use the fixture's `expected` values):
    1. a full `all` backfill with `since` 12 months back drains to completion: 2 locations, 5 variants as SKUs with listings (`sku_code` taken from the Shopify sku or a generated fallback as the products sink does), the 3 unit costs as `product_cost` components, inventory levels at both locations with movements equal to the on-hand sums, 5 orders (POS channel and test flag stored, cancelled status stored) with line snapshots equal to the costs in effect in the org timezone (`null` for variants without a cost, never 0), refunds and refund lines with `restock` honoured; all four cursors `complete`; the connection's `last_synced_at` set;
    2. replaying the same backfill a second time changes no row counts and creates no extra movements;
    3. a throttled first orders page (`THROTTLED` once via a scripted handler count) makes the engine return `delayed` with the computed wait and the next attempt succeeds without duplicating or losing rows;
    4. an HTTP 401 on the first page fails the run, marks the connection `error`, and a later successful run recovers it to `active`;
    5. an unreadable money value in one order fails the run with a sanitized message that does not contain the value and leaves earlier committed pages in place (cursor not advanced for the failed page);
    6. incremental mode after the backfill: with `updatedSince` set, only items newer than the watermark are requested (assert the `query` variables sent) and an updated order replaces its lines without duplicates.

- [ ] **Step 2: Run to see failures** — `pnpm turbo run build --filter=@erq/db --filter=@erq/connectors` then `pnpm --filter @erq/sync exec vitest run test/engine.test.ts test/shopify-engine-e2e.test.ts` → FAIL.

- [ ] **Step 3: Implement** the engine change (a single extra `tx.update(storeConnections)` in the `done` branch, with the status recovery expressed as `status: sql\`case when ${storeConnections.status} = 'error' then 'active'::connection_status else ${storeConnections.status} end\`` and `lastError` cleared only in the same case) and the harness option; write the e2e test.

- [ ] **Step 4: Run** — `pnpm turbo run test typecheck build --filter=@erq/sync --concurrency=1` and `pnpm exec eslint packages/sync` → PASS; no leftover postgres processes or `erq-pg-*` directories.

- [ ] **Step 5: Commit**

```bash
git add packages/sync
git commit -m "feat(sync): record last synced and recover errored connections when a chain completes; end-to-end Shopify backfill tests

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Part D: API, web and documentation

### Task 9: A sync queue in the API and the first backfill after connect

**Files:**
- Create: `apps/api/src/connections/sync-queue.ts`, `apps/api/src/connections/sync-starter.ts`
- Modify: `packages/sync/src/engine/start.ts` and `packages/sync/src/engine/deps.ts` (narrow the deps type), `apps/api/package.json` (`@erq/sync: workspace:*`), `apps/api/src/connections/{tokens,connections.module,connections.service}.ts`
- Test: extend `apps/api/test/connections.test.ts` (new `describe('first backfill after connect')`), `packages/sync/test/engine.test.ts` (typing only: `enqueueSync` accepts `{ db, queue, now }`)

**Interfaces:**
- Narrowing: `enqueueSync(deps: Pick<SyncDeps, 'db' | 'queue' | 'now'>, args)` and `nowOf(deps: Pick<SyncDeps, 'now'>)`; behaviour unchanged.
- `export interface SyncQueuePort extends JobQueue { readonly available: boolean }` in `sync-queue.ts`; `BullMqSyncQueue` (queue `SYNC_QUEUE_NAME = 'sync'`, job name `'page'`, options identical to `apps/worker/src/sync/bullmq-queue.ts`: `delay: opts.delayMs`, `attempts: 5`, exponential backoff 5000 ms, `removeOnComplete: { count: 1000 }`, `removeOnFail: { count: 5000 }`; `available = true`) and `NoopSyncQueue` (`available = false`, `enqueue` does nothing). A comment names the worker file as the source of the contract. Token `SYNC_QUEUE_PORT`.
- `REDIS_RESOURCES` gains the `sync` `Queue` (same producer connection and fail-fast options as the webhook producer); the lifecycle closes both queues; `SYNC_QUEUE_PORT` is `new BullMqSyncQueue(res.syncQueue)` when Redis is configured, else `NoopSyncQueue`.
- `SyncStarter` (injectable class in `sync-starter.ts`): `start(args: { orgId: string; connectionId: string; scopes: readonly string[]; mode?: 'backfill' | 'incremental' }): Promise<'started' | 'already_running' | 'unavailable'>`. `unavailable` when `!queue.available`; otherwise `enqueueSync({ db, queue, now }, { orgId, connectionId, resources: 'all', mode, since: mode === 'backfill' ? ordersBackfillSince(scopes, now) : undefined })` and maps `started` true/false. Default mode `backfill`.
- `completeInstall`: after the upsert transaction and the webhook registration, call `syncStarter.start({ orgId, connectionId, scopes: token.scopes })`. `unavailable` and `already_running` change nothing. If `start` throws, the connect still succeeds, a `last_error = 'Could not start the first import. Use Sync now.'` is stored on the connection (this overwrites the webhook-warning text; both conditions keep the existing redirect `warning` behaviour) and the failure is logged with `sanitizeMessage` only.

- [ ] **Step 1: Write the failing tests** (in `apps/api/test/connections.test.ts`, with a `RecordingSyncQueue { available = true; jobs: SyncPageJob[]; fail = false }` override for `SYNC_QUEUE_PORT`, and `fake`/`createOrg`/`startInstall`/`rawSigned`/`callbackAs` as in the callback tests)
  1. a successful connect (granted scopes `read_orders,read_products`, i.e. no `read_all_orders`) enqueues exactly one `page` job: resource `locations`, `then.resources == ['products','inventory','orders']`, `then.mode == 'backfill'`, `then.since` ≈ 60 days before now (assert within a minute); a `sync_runs` row and a `sync_cursors` row for `locations` exist in `running` state;
  2. with `FakeShopify({ scope: 'read_orders,read_all_orders' })` the `since` is ≈ 365 days back;
  3. `RecordingSyncQueue.fail = true`: the callback still answers `?shopify=connected`, the connection is active with `last_error = 'Could not start the first import. Use Sync now.'`, and nothing else breaks;
  4. a `NoopSyncQueue` (override with `available = false`) enqueues nothing and stores no error;
  5. a reconnect while the `locations` run is still active enqueues nothing new (`already_running`);
  6. no queue payload contains a token, credentials or the raw query (assert on `JSON.stringify(job)`).

- [ ] **Step 2: Run to see failures** — `pnpm turbo run build --filter=@erq/db --filter=@erq/connectors --filter=@erq/sync` then `pnpm --filter @erq/api exec vitest run test/connections.test.ts` → FAIL.

- [ ] **Step 3: Implement** per the Interfaces block. Add `@erq/sync` to the API's dependencies and run `pnpm install`; mention why in the commit body.

- [ ] **Step 4: Run** — `pnpm turbo run test typecheck build --filter=@erq/sync --filter=@erq/api --concurrency=1` and `pnpm exec eslint apps/api packages/sync` → PASS; no leftover postgres processes.

- [ ] **Step 5: Commit**

```bash
git add apps packages pnpm-lock.yaml
git commit -m "feat(api): start the first Shopify backfill after connect through a sync queue producer

@erq/sync is added to the API for enqueueSync and ordersBackfillSince.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Sync now and the sync summary in the connections list

**Files:**
- Modify: `packages/shared/src/connections.ts`, `apps/api/src/connections/{connections.controller,connections.service}.ts`
- Test: extend `apps/api/test/connections.test.ts` (`describe('sync now')`, `describe('sync summary')`)

**Interfaces:**
- Shared:

```ts
export interface ConnectionSyncDto {
  state: 'never' | 'running' | 'idle' | 'failed';
  /** The resource currently importing or that failed ('locations' | 'products' | 'inventory' | 'orders'), else null. */
  resource: string | null;
  recordsProcessed: number;
  /** Oldest imported order date (ISO), or null when no orders yet. */
  coveredFrom: string | null;
  /** True when read_all_orders was not granted, so older order history is not available. */
  historyLimited: boolean;
  error: string | null;
  /** False when the server cannot start syncs (no queue configured) or the connection is not usable. */
  canStart: boolean;
}
export interface SyncNowResponse { started: boolean }
```
and `ConnectionDto` gains `sync: ConnectionSyncDto`.
- Summary derivation in `ConnectionsService.list` (one query per table for the org, grouped in memory; no N+1): per connection read its `sync_cursors`; `state` = `running` if any cursor is `running` (then `resource` and `recordsProcessed` come from the first running cursor in `locations, products, inventory, orders` order), else `failed` if any cursor is `failed` (`resource` of the first failed, `error` = that cursor's `last_error`, which is already sanitized when stored), else `idle` when every one of the four resources has a cursor with status `complete`, else `never`. `coveredFrom = min(orders.placed_at)` for the connection (ISO) or null; `historyLimited = !connection.scopes.includes('read_all_orders')`; `canStart = queue.available && connection.status in ('active', 'error')`. No credentials, tokens or raw run errors beyond the stored sanitized text.
- `POST /orgs/:orgId/connections/:id/sync` (`AuthGuard, OrgGuard, RolesGuard`, `@Roles('admin')`, id validated with `uuidSchema`): `ConnectionsService.syncNow(orgId, userId, id)`: 404 `connection_not_found` when the connection is not in the org; 409 `connection_not_active` ("Reconnect this store first.") when its status is `disconnected`, `pending` or `demo`; 503 `sync_not_available` ("Importing is not available on this server yet.") when the queue is not available; otherwise mode = `backfill` when any of the four resources has no cursor with a completed run (`last_synced_at` null), else `incremental`; calls `syncStarter.start({ orgId, connectionId: id, scopes: connection.scopes ?? [], mode })`; writes audit `connection.sync_requested` (actor = the user, metadata `{ mode }` only); responds `{ started: boolean }` (`false` for `already_running`, never an error). The response contains nothing else.

- [ ] **Step 1: Write the failing tests**
  - sync summary: a connection with no cursors → `state 'never'`, `canStart true` (queue available), `historyLimited` true/false from stored scopes, `coveredFrom null`; after seeding cursors via the owner pool: one `running` orders cursor with `records_processed = 1200` → `running`/`orders`/`1200`; a `failed` cursor with `last_error` → `failed` with that text; all four `complete` → `idle`; orders rows seeded → `coveredFrom` equals the oldest `placed_at`; a `disconnected` connection → `canStart false`; a no-queue app → `canStart false`; two orgs never see each other's summaries; no credential field or ciphertext appears anywhere in the list JSON;
  - sync now: admin starts a backfill on a never-synced connection (job enqueued, `{ started: true }`, audit row with `{ mode: 'backfill' }`); a second call while running → `{ started: false }`; after all four cursors are complete → `incremental` mode (no `since` on the job's `then`); viewer and analyst → 403; unknown id → 404; malformed id → 400; disconnected/pending/demo → 409 `connection_not_active`; no queue → 503 `sync_not_available`; another org's connection id → 404; an `error`-status connection can be synced (recovery path).

- [ ] **Step 2: Run to see failures** — `pnpm --filter @erq/api exec vitest run test/connections.test.ts` → FAIL.

- [ ] **Step 3: Implement** per the Interfaces block. Update the existing `list` tests for the new `sync` field (their `toEqual` shapes gain it).

- [ ] **Step 4: Run** — `pnpm turbo run build --filter=@erq/shared` then `pnpm turbo run test typecheck build --filter=@erq/shared --filter=@erq/api --concurrency=1` and `pnpm exec eslint apps/api packages/shared` → PASS; no leftover postgres processes.

- [ ] **Step 5: Commit**

```bash
git add apps/api packages/shared
git commit -m "feat(api): add Sync now and a sync summary to the connections list

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The Connections page shows sync progress and offers Sync now

**Files:**
- Create: `apps/web/src/components/sync-now-button.tsx`
- Modify: `apps/web/src/lib/connections.ts`, `apps/web/src/lib/connections.test.ts`, `apps/web/src/app/(app)/connections/{page.tsx,actions.ts}`
- Test: `apps/web/src/lib/connections.test.ts`; one Playwright assertion added to the existing connections e2e (CI only)

**Interfaces:**
- Pure helper in `lib/connections.ts` (no `server-only` import): `describeSync(sync: ConnectionSyncDto, lastSyncedAt: string | null, now: Date): { headline: string; detail: string | null; tone: 'ok' | 'warn' | 'muted'; canSync: boolean }` with these exact texts:
  - `running`: headline `Importing ${label}, ${n} so far` where `label` maps `locations → locations`, `products → products`, `inventory → stock levels`, `orders → orders`, unknown or null → `your data`, and `n` is formatted with thousands separators (`1,200`); tone `muted`; `canSync` false.
  - `failed`: headline `Import stopped`; `detail` = the stored error text when present, else `Try Sync now.`; tone `warn`; `canSync` = `sync.canStart`.
  - `idle`: headline `Up to date`; `detail` = `Last synced ${relativeTime(lastSyncedAt, now)}`; tone `ok`; `canSync` = `sync.canStart`.
  - `never`: `canStart` → headline `Not imported yet`, detail `Press Sync now to start.`; otherwise headline `Not imported yet`, detail `Importing is not available on this server yet.`; tone `muted`; `canSync` = `sync.canStart`.
  - When `coveredFrom` is set, append to `detail` (space separated, or make it the detail when none): `Showing orders from ${Mon D, YYYY}.` (UTC date via `toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })`); when `historyLimited` also append `Older history needs Shopify's approval to read all orders.`.
- `actions.ts`: `syncNowAction(formData)` posts to `/orgs/:orgId/connections/:id/sync` through `apiFetch` with the ACTIVE org from `loadAppContext()` (never a posted org id), `revalidatePath('/connections')`, and returns a plain `{ error?: string; started?: boolean }`: `ApiRequestError` 409/503 messages come through as the API's plain message, anything else becomes `We could not start the import. Please try again.`.
- `SyncNowButton` (client component, `useActionState`): label `Sync now`, disabled while pending or when `canSync` is false, an `aria-live` status line for `started`/`error` results ("Import started." / the error), keyboard accessible.
- Page: each connection row shows the sync headline and detail under the existing status row (admins only see the button; viewers see the text), keeps its loading skeleton, error state and empty state; polls nothing (a refresh shows progress).

- [ ] **Step 1: Write the failing tests** in `connections.test.ts`: every branch of `describeSync` with exact strings: running orders with 1200 → `Importing orders, 1,200 so far`; running stock levels; running with null resource → `Importing your data, 0 so far`; failed with and without error text; idle with `lastSyncedAt` 5 minutes ago → detail `Last synced 5 minutes ago`; never with `canStart` true and false; `coveredFrom` appended with the exact date text (`Showing orders from Oct 9, 2026.`); `historyLimited` appended (`... Older history needs Shopify's approval to read all orders.`); `canSync` per state; large numbers (`1234567` → `1,234,567`); an invalid `coveredFrom` string is ignored (no date text).

- [ ] **Step 2: Run to see failures** — `pnpm --filter @erq/web exec vitest run src/lib/connections.test.ts` → FAIL.

- [ ] **Step 3: Implement** the helper, the action, the component and the page changes following the existing patterns (`team/page.tsx`, `disconnect-button.tsx`, `@erq/ui`). Plain English, WCAG AA, phone-width wrapping. The Playwright addition (connections spec, CI only): the page shows the "Not imported yet" text for a new connection; it cannot run here, make sure it typechecks and lints and say it is unverified.

- [ ] **Step 4: Run** — `pnpm turbo run build --filter=@erq/shared` then `pnpm turbo run test typecheck build --filter=@erq/web --concurrency=1` and `pnpm exec eslint apps/web`; delete `apps/web/.next` afterwards if free disk is under 2GB → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): show sync progress on the Connections page and add Sync now

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Documentation, notes and final verification

**Files:**
- Modify: `docs/shopify-connection.md`, `docs/sync.md`, `docs/architecture/tenancy.md` (only if anything there is now wrong), `CLAUDE.md` (section 16 and the Decisions Log only), `.env.example`, `docs/superpowers/specs/2026-10-09-phase1b3b-shopify-connector-design.md` (only where this plan refines it)

- [ ] **Step 1: `docs/shopify-connection.md`** (verify against the code): what imports (locations, products with unit costs, inventory, orders; POS as its own channel; test orders flagged), what is deliberately left out and why (customers, UTM and landing site: protected customer data; products' `updated_at` incrementals exist but the scheduler is 1b-3c); scopes including `read_all_orders` and the 12-month vs 60-day history with the "Showing orders from ..." text; how the first backfill starts (automatically after connect) and Sync now (roles, 409/503 cases); the sync summary fields; rate limits (the policy numbers and the connector's own throttle handling); error mapping table (fixed messages); the money rules (exact decimal-string conversion, currency exponents, one currency per org); a **first-install checklist** listing every unverified item: GraphQL field and enum names per query (`inventoryItems`, `quantities(names:)`, `refundShippingLines`, `restockType`, `sourceName`, `isFulfillmentService`, `address.formatted`), the API version, the cost-bucket numbers, `Money` as a decimal string, how Shopify signs the OAuth redirect (encoded vs decoded), whether `unitCost` needs `read_inventory` or `read_products`; and how to connect a development store end to end (Partner app, redirect URL on the web origin, scopes, env vars `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_SCOPES`, `API_PUBLIC_URL`, `WEB_PUBLIC_URL`, `REDIS_URL`, `ENCRYPTION_KEY_ID`, `ENCRYPTION_KEY`, `SHOPIFY_API_VERSION`).
- [ ] **Step 2: `docs/sync.md`**: the connector and its opaque cursor format, the per-resource filters (backfill `created_at`, incremental `updated_at`), nested-list bounds, `ordersBackfillSince`, the engine's connection-health update (`last_synced_at`, error recovery) and the sync queue producer in the API.
- [ ] **Step 3: CLAUDE.md** (section 16 and the Decisions Log only): section 16 "Built" gains the Shopify connector, Sync now and the sync summary; "Rules that are easy to break": the connector never touches the database and never queries protected customer fields; money from Shopify is converted with exact string math only; the API and worker agree on the `sync` queue name, the `page` job name and its options; "Not yet verified by running": everything against a real Shopify shop (GraphQL shapes, cost numbers, API version), the Redis sync queue producer, the Sync now button in a browser. Decisions Log entries dated 2026-10-09: paginated GraphQL (no bulk operations yet); customers and marketing fields left out until the protected-data approval; first backfill starts automatically plus Sync now; `read_all_orders` requested, history depth 12 months or 60 days by granted scopes; the engine now records `last_synced_at` and recovers errored connections. Change nothing else.
- [ ] **Step 4: `.env.example`**: add `SHOPIFY_API_VERSION=` (empty means the built-in default) with a comment.
- [ ] **Step 5: Final verification (all required)**: `pnpm turbo run build --filter=@erq/db --filter=@erq/connectors --filter=@erq/sync --filter=@erq/shared`, then one package at a time with `--concurrency=1`: `pnpm turbo run test typecheck build --filter=<pkg>` for `@erq/db`, `@erq/connectors`, `@erq/sync`, `@erq/shared`, `@erq/api`, `@erq/worker`, `@erq/web`, `@erq/metrics`, and `pnpm exec eslint packages apps`. Report per-package test counts; after EVERY package confirm zero postgres processes (including children) and no `%TEMP%\erq-pg-*`; delete `apps/web/.next` afterwards if free disk is under 2GB.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs(shopify): document the connector, the first-install checklist and update project notes

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** spec 2.1-2.4 connector (Tasks 1-6), 3 wiring (Tasks 7, 9, 10; the connection-health item is in Task 8), 4 Connections page (Tasks 10, 11), 5 testing (every task; engine end to end in Task 8), 6 documentation (Task 12), 7 success criteria (Tasks 6, 8, 9-11, 12).
- **Refinements to the spec made here:** per-resource modules instead of one `queries.ts`/`normalize.ts`; the cursor carries only `after` and the shop currency comes from `shop { currencyCode }` in each query (orders use the order's own money-set currency and reject mixed currencies); `coveredFrom` is the oldest imported order date and `historyLimited` comes from the stored scopes (the backfill timestamp is not kept after an incremental run); Sync now returns 409 `connection_not_active` for disconnected, pending and demo connections; the engine, not the connector, records `last_synced_at` and error recovery (spec 3 said the engine already did: it only updated cursors).
- **Known limitation recorded in the docs:** none of this has run against a real Shopify shop; the first-install checklist lists every assumption.
