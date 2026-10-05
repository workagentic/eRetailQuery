# eRetailQuery Phase 0: Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the monorepo, CI, Supabase-authenticated multi-tenant API, RLS-protected base schema, tenant-isolation test suite, seed script, and a minimal web shell that every later phase builds on.

**Architecture:** pnpm + Turborepo monorepo. Internal packages build to CJS with tsup. The API (NestJS) and worker (BullMQ) connect to Postgres as a non-superuser `app_user` role and run every query inside `withTenant(orgId, fn)`, which sets `app.org_id` locally per transaction; RLS policies read that setting. Pre-org operations (list my orgs, create org, accept invite) go through three `SECURITY DEFINER` functions.

**Tech Stack:** Node 22, pnpm, Turborepo, TypeScript strict, Drizzle ORM + drizzle-kit, `pg`, Postgres 16, NestJS (SWC builder), `jose`, zod 3, pino, BullMQ + ioredis, Next.js 15 (App Router) + Tailwind v4 + `@supabase/ssr`, Vitest, Testcontainers, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-05-phase0-foundations-design.md` (product rules: `CLAUDE.md`)

## Global Constraints

- Money is `*_cents bigint` plus an ISO `currency` column. Never floats for money.
- Every tenant table has `id uuid`, `org_id`, `created_at`, `updated_at` (`orgs` keys on its own `id`; `audit_log` has no `updated_at` and is append-only).
- RLS on every tenant table: `ENABLE` + `FORCE`, policy `org_id = current_setting('app.org_id')::uuid` (via `nullif(...,'')`). `orgs` compares `id`.
- `app_user` has no `BYPASSRLS`, owns no tables. API and worker connect as `app_user`. Migrations and seed use the owner role.
- TypeScript strict everywhere. No `any` without a comment.
- Validate all API inputs with zod schemas from `@erq/shared`.
- API error shape: `{ error: { code, message, details } }`.
- Database changes only through migrations (Drizzle). Never edit schema by hand; never hand-edit generated migration SQL.
- AES-256-GCM for credential encryption. Never log tokens (pino redaction).
- No secrets in the repo; `.env.example` lists every variable.
- Roles: owner, admin, analyst, viewer. `@Roles('x')` means role `x` or higher.
- Root scripts: `dev`, `db:migrate`, `db:seed`, `test`, `test:e2e`, `lint`, `typecheck`.
- Conventional Commits, one task per commit. Every commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Docker Desktop must be running for integration tests (Testcontainers) and local dev.
- Package scope is `@erq/*`. Packages: `shared`, `db`, `metrics`, `connectors`, `ui`; apps: `web`, `api`, `worker`.

## Review Focus

Inputs and conditions the spec implies but does not spell out. Each has a pinning test in the task named.

1. A pooled DB connection reused after another tenant's transaction must not leak that tenant, and must not error on the empty `app.org_id` (Task 6).
2. A row in tenant B pointing at tenant A's parent (e.g. a SKU whose `product_id` belongs to A) must be rejected by composite foreign keys (Task 7).
3. Invite tokens: reuse, expiry, and acceptance by a user whose email differs from the invited email must fail (Task 8, Task 12).
4. Garbage `Authorization` headers, non-UUID `sub`, and malformed or foreign `X-Org-Id` must return 4xx, never reach Postgres as a 500 (Task 11).
5. The post-login `next` parameter must never redirect off-site (`//evil.com`, `https://evil.com`, `/\evil.com`, tab/newline tricks) (Task 15).

## File Structure

```
eretailquery/
  package.json  pnpm-workspace.yaml  turbo.json  tsconfig.base.json
  eslint.config.mjs  .prettierrc  .prettierignore  .gitignore  .nvmrc
  docker-compose.yml  .env.example  .github/workflows/ci.yml
  supabase/config.toml                       local Supabase auth for e2e
  packages/
    shared/src/   money.ts crypto.ts logger.ts schemas.ts slug.ts api-types.ts index.ts
    db/
      drizzle.config.ts  migrations/         generated + custom SQL
      src/schema/ timestamps.ts orgs.ts tenant.ts identity.ts connections.ts catalog.ts index.ts
      src/ tenant-db.ts account.ts audit.ts admin.ts testing.ts seed.ts index.ts cli/{migrate,seed}.ts
      test/ fixtures.ts roles.test.ts tenant.test.ts isolation.test.ts audit-log.test.ts
            catalog-fk.test.ts account.test.ts seed.test.ts
    metrics/  connectors/  ui/
  apps/
    api/src/ config/ common/ db/ auth/ health/ orgs/ main.ts app.module.ts
    worker/src/ system-worker.ts tenant-job.ts main.ts
    web/src/ app/ lib/ middleware.ts
  docs/ dev-setup.md architecture/tenancy.md
```

---

### Task 1: Monorepo scaffold and empty packages

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc`, `.prettierignore`, `.gitignore`, `.nvmrc`, `docker-compose.yml`, `.env.example`
- Create: `packages/metrics/{package.json,tsconfig.json,tsup.config.ts,vitest.config.ts,src/index.ts,test/smoke.test.ts}`
- Create: `packages/connectors/{package.json,tsconfig.json,tsup.config.ts,src/index.ts,src/types.ts}`

**Interfaces:**
- Produces: workspace conventions used by every later task: each package has scripts `build` (`tsup`), `dev` (`tsup --watch`), `typecheck` (`tsc --noEmit`), `test` (`vitest run`) and `main`/`types` pointing at `dist/`.

- [ ] **Step 1: Initialize git and tooling files**

```bash
git init
corepack enable && pnpm -v
```

Create `.nvmrc` containing `22`. Create `pnpm-workspace.yaml`:

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

Create root `package.json` (change `packageManager` to exactly the version printed by `pnpm -v`):

```json
{
  "name": "eretailquery",
  "private": true,
  "packageManager": "pnpm@10.0.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "db:migrate": "pnpm --filter @erq/db migrate",
    "db:seed": "pnpm --filter @erq/db seed",
    "test": "turbo run test",
    "test:e2e": "pnpm --filter @erq/web test:e2e",
    "lint": "eslint . && prettier --check .",
    "typecheck": "turbo run typecheck",
    "format": "prettier --write ."
  }
}
```

`turbo.json`:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**", "!.next/cache/**"] },
    "dev": { "dependsOn": ["^build"], "cache": false, "persistent": true },
    "test": { "dependsOn": ["^build"], "cache": false },
    "typecheck": { "dependsOn": ["^build"] }
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true
  }
}
```

`.prettierrc`: `{ "singleQuote": true, "semi": true, "trailingComma": "all", "printWidth": 100 }`

`.prettierignore`:

```
dist
.next
node_modules
migrations
pnpm-lock.yaml
*.md
docs
supabase
coverage
playwright-report
test-results
```

`.gitignore`:

```
node_modules
dist
.next
.turbo
.env
coverage
playwright-report
test-results
supabase/.temp
*.tsbuildinfo
```

`eslint.config.mjs`:

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/migrations/**', '**/coverage/**', '**/*.config.*'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['apps/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@erq/db/admin'],
              message: 'The unscoped admin client is for migrations and seed only. Use TenantDb.withTenant.',
            },
          ],
        },
      ],
    },
  },
);
```

`docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: erq_owner
      POSTGRES_PASSWORD: erq_owner
      POSTGRES_DB: erq
    ports: ['54329:5432']
    volumes: ['pgdata:/var/lib/postgresql/data']
  redis:
    image: redis:7-alpine
    ports: ['6379:6379']
volumes:
  pgdata:
```

`.env.example`:

```bash
# Database. The owner role runs migrations/seed; app_user is what API and worker use.
DATABASE_OWNER_URL=postgres://erq_owner:erq_owner@localhost:54329/erq
DATABASE_URL=postgres://app_user:app_user_dev@localhost:54329/erq
APP_USER_PASSWORD=app_user_dev
REDIS_URL=redis://localhost:6379

# Credential encryption (AES-256-GCM). Generate: openssl rand -base64 32
ENCRYPTION_KEY_ID=dev-1
ENCRYPTION_KEY=
# Optional JSON map of retired key ids to base64 keys, so old ciphertext still decrypts
ENCRYPTION_OLD_KEYS=

# Supabase Auth. Set SUPABASE_JWKS_URL (asymmetric keys) OR SUPABASE_JWT_SECRET (HS256).
SUPABASE_JWT_ISSUER=http://127.0.0.1:54321/auth/v1
SUPABASE_JWKS_URL=http://127.0.0.1:54321/auth/v1/.well-known/jwks.json
SUPABASE_JWT_SECRET=

# API
API_PORT=4000
LOG_LEVEL=info
WEB_PUBLIC_URL=http://localhost:3000

# Web
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=
API_URL=http://localhost:4000
```

- [ ] **Step 2: Create the `metrics` package (empty, test harness only)**

`packages/metrics/package.json`:

```json
{
  "name": "@erq/metrics",
  "version": "0.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

`packages/metrics/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "noEmit": true }, "include": ["src", "test", "*.config.ts"] }
```

`packages/metrics/tsup.config.ts`:

```ts
import { defineConfig } from 'tsup';
export default defineConfig({ entry: ['src/index.ts'], format: ['cjs'], dts: true, clean: true, sourcemap: true });
```

`packages/metrics/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
```

`packages/metrics/src/index.ts`: `export const METRICS_PACKAGE = '@erq/metrics';`

`packages/metrics/test/smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { METRICS_PACKAGE } from '../src';

describe('metrics package', () => {
  it('loads', () => {
    expect(METRICS_PACKAGE).toBe('@erq/metrics');
  });
});
```

- [ ] **Step 3: Create the `connectors` package (interfaces from CLAUDE.md §6 only)**

Same `package.json` (name `@erq/connectors`, no `test` script), `tsconfig.json`, `tsup.config.ts` as above. `packages/connectors/src/types.ts`:

```ts
// Interfaces from CLAUDE.md section 6. Normalized shapes are minimal on purpose;
// Phase 1b/1c specs extend them. No platform-specific fields may leak out of this package.
export interface Connection {
  id: string;
  externalAccountId: string;
}
export interface SyncResult {
  recordsProcessed: number;
  cursor: string | null;
}
export interface NormalizedOrder {
  externalId: string;
  placedAt: Date;
  currency: string;
  grossCents: number;
}
export interface NormalizedProduct {
  externalId: string;
  title: string;
}
export interface NormalizedInventory {
  externalVariantId: string;
  locationExternalId: string;
  available: number;
}

export interface StoreConnector {
  connect(oauthParams: Record<string, string>): Promise<Connection>;
  backfill(
    connection: Connection,
    since: Date,
  ): AsyncIterable<NormalizedOrder | NormalizedProduct | NormalizedInventory>;
  syncIncremental(connection: Connection, cursor: string | null): Promise<SyncResult>;
  handleWebhook(payload: unknown, headers: Record<string, string>): Promise<void>;
  pushPrice?(sku: string, priceCents: number): Promise<void>; // phase 4
  pushInventory?(sku: string, location: string, qty: number): Promise<void>; // phase 4
}

export type InsightLevel = 'campaign' | 'adset' | 'ad';
export interface DateRange {
  from: Date;
  to: Date;
}
export interface AdConnector {
  connect(oauthParams: Record<string, string>): Promise<Connection>;
  syncInsights(connection: Connection, dateRange: DateRange, level: InsightLevel): Promise<SyncResult>;
}
```

`packages/connectors/src/index.ts`: `export * from './types';`

- [ ] **Step 4: Install tooling and verify**

```bash
pnpm add -Dw turbo typescript tsup vitest eslint @eslint/js typescript-eslint eslint-config-prettier prettier @types/node
pnpm install
pnpm turbo run build typecheck test
pnpm lint
```

Expected: build, typecheck and the metrics smoke test pass; lint passes. If lint reports formatting issues, run `pnpm format` and re-run.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm/turbo monorepo with metrics and connectors packages"
```

---

### Task 2: `@erq/shared` money utilities

**Files:**
- Create: `packages/shared/{package.json,tsconfig.json,tsup.config.ts,vitest.config.ts}`
- Create: `packages/shared/src/money.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/test/money.test.ts`

**Interfaces:**
- Produces (from `@erq/shared`): `type Money = { readonly cents: number; readonly currency: string }`, `money(cents, currency='USD'): Money`, `add(a,b)`, `subtract(a,b)`, `negate(m)`, `sum(items: Money[], currency='USD')`, `fromDecimalString(input, currency='USD')`, `applyBasisPoints(m, bps)`, `formatMoney(m, locale='en-US')`.

- [ ] **Step 1: Package files**

`packages/shared/package.json` (same shape as metrics, name `@erq/shared`, plus dependencies added in Step 4 and later tasks):

```json
{
  "name": "@erq/shared",
  "version": "0.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

`tsconfig.json`, `tsup.config.ts`, `vitest.config.ts` identical to the metrics package. `src/index.ts`: `export * from './money';`

- [ ] **Step 2: Write the failing tests**

`packages/shared/test/money.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  add, applyBasisPoints, formatMoney, fromDecimalString, money, negate, subtract, sum,
} from '../src/money';

describe('money()', () => {
  it('creates integer-cent values defaulting to USD', () => {
    expect(money(1234)).toEqual({ cents: 1234, currency: 'USD' });
  });
  it('rejects fractional, NaN, and unsafe cents', () => {
    expect(() => money(12.5)).toThrow(RangeError);
    expect(() => money(Number.NaN)).toThrow(RangeError);
    expect(() => money(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
  });
  it('rejects malformed currency codes', () => {
    expect(() => money(1, 'usd')).toThrow(RangeError);
    expect(() => money(1, 'US')).toThrow(RangeError);
  });
  it('allows negative values (refunds exceeding sales)', () => {
    expect(money(-500).cents).toBe(-500);
  });
});

describe('arithmetic', () => {
  it('adds, subtracts, negates', () => {
    expect(add(money(100), money(250))).toEqual(money(350));
    expect(subtract(money(100), money(250))).toEqual(money(-150));
    expect(negate(money(100))).toEqual(money(-100));
  });
  it('throws on currency mismatch', () => {
    expect(() => add(money(1, 'USD'), money(1, 'EUR'))).toThrow(/currency mismatch/);
  });
  it('sum of empty list is zero in the given currency', () => {
    expect(sum([], 'EUR')).toEqual(money(0, 'EUR'));
  });
  it('sums a list', () => {
    expect(sum([money(1), money(2), money(3)])).toEqual(money(6));
  });
  it('throws when an addition overflows safe range', () => {
    expect(() => add(money(Number.MAX_SAFE_INTEGER), money(1))).toThrow(RangeError);
  });
});

describe('fromDecimalString()', () => {
  it.each([
    ['12.34', 1234], ['12.3', 1230], ['12', 1200], ['0.05', 5], ['-1.50', -150], ['0', 0], [' 7.00 ', 700],
  ])('parses %s', (input, cents) => {
    expect(fromDecimalString(input)).toEqual(money(cents));
  });
  it('never yields negative zero', () => {
    expect(Object.is(fromDecimalString('-0').cents, 0)).toBe(true);
  });
  it.each(['', 'abc', '1.234', '1,000.00', '$5', '1e3', '.5', '5.'])('rejects %j', (input) => {
    expect(() => fromDecimalString(input)).toThrow(RangeError);
  });
  it('rejects amounts beyond the safe integer range', () => {
    expect(() => fromDecimalString('999999999999999')).toThrow(RangeError);
  });
});

describe('applyBasisPoints()', () => {
  it('computes percentages', () => {
    expect(applyBasisPoints(money(10_000), 2900)).toEqual(money(2900)); // 29%
  });
  it('rounds half away from zero', () => {
    expect(applyBasisPoints(money(1), 5000)).toEqual(money(1));
    expect(applyBasisPoints(money(-1), 5000)).toEqual(money(-1));
    expect(applyBasisPoints(money(1), 4999)).toEqual(money(0));
  });
  it('handles zero amount and zero bps', () => {
    expect(applyBasisPoints(money(0), 1234)).toEqual(money(0));
    expect(applyBasisPoints(money(999), 0)).toEqual(money(0));
  });
  it('rejects non-integer bps', () => {
    expect(() => applyBasisPoints(money(100), 12.5)).toThrow(RangeError);
  });
});

describe('formatMoney()', () => {
  it('formats USD with two decimals', () => {
    expect(formatMoney(money(123456))).toBe('$1,234.56');
    expect(formatMoney(money(-1234))).toBe('-$12.34');
    expect(formatMoney(money(0))).toBe('$0.00');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm install && pnpm --filter @erq/shared test`
Expected: FAIL, cannot resolve `../src/money`.

- [ ] **Step 4: Implement**

`packages/shared/src/money.ts`:

```ts
export interface Money {
  readonly cents: number;
  readonly currency: string;
}

const CURRENCY_RE = /^[A-Z]{3}$/;

export function money(cents: number, currency = 'USD'): Money {
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`cents must be a safe integer, got ${cents}`);
  }
  if (!CURRENCY_RE.test(currency)) {
    throw new RangeError(`invalid ISO currency code: ${currency}`);
  }
  return Object.freeze({ cents, currency });
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.cents + b.cents, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.cents - b.cents, a.currency);
}

export function negate(m: Money): Money {
  return money(m.cents === 0 ? 0 : -m.cents, m.currency);
}

export function sum(items: Money[], currency = 'USD'): Money {
  return items.reduce((acc, m) => add(acc, m), money(0, currency));
}

const DECIMAL_RE = /^(-)?(\d{1,15})(?:\.(\d{1,2}))?$/;

/** Parses "12.34" without ever going through a float. */
export function fromDecimalString(input: string, currency = 'USD'): Money {
  const match = DECIMAL_RE.exec(input.trim());
  if (!match) throw new RangeError(`invalid money string: ${JSON.stringify(input)}`);
  const [, negative, whole = '0', fraction = ''] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return money(negative && cents !== 0 ? -cents : cents, currency);
}

/** Multiplies by basis points (1% = 100 bps) in integer math, rounding half away from zero. */
export function applyBasisPoints(m: Money, bps: number): Money {
  if (!Number.isInteger(bps)) throw new RangeError(`bps must be an integer, got ${bps}`);
  const product = BigInt(m.cents) * BigInt(bps);
  const abs = product < 0n ? -product : product;
  let quotient = abs / 10_000n;
  if ((abs % 10_000n) * 2n >= 10_000n) quotient += 1n;
  return money(Number(product < 0n ? -quotient : quotient), m.currency);
}

/** Display only. The cents model assumes 2-decimal currencies. */
export function formatMoney(m: Money, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: m.currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(m.cents / 100);
}
```

`packages/shared/src/index.ts` already exports `./money`.

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @erq/shared test`
Expected: PASS (all money tests).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(shared): add integer-cent money utilities"
```

### Task 3: `@erq/shared` crypto and logger

**Files:**
- Create: `packages/shared/src/crypto.ts`, `packages/shared/src/logger.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/crypto.test.ts`, `packages/shared/test/logger.test.ts`

**Interfaces:**
- Produces: `interface KeyProvider { current(): { keyId: string; key: Buffer }; get(keyId: string): Buffer }`, `class EnvKeyProvider` (`new EnvKeyProvider(currentId, keys: Record<string,string>)`, `static fromEnv(env)`), `encrypt(plaintext: string, provider: KeyProvider, aad?: string): string`, `decrypt(payload: string, provider: KeyProvider, aad?: string): string`, `createLogger(opts?: { level?: string; destination?: { write(s: string): void } }): pino.Logger`.

- [ ] **Step 1: Write the failing crypto tests**

`packages/shared/test/crypto.test.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, EnvKeyProvider } from '../src/crypto';

const b64 = () => randomBytes(32).toString('base64');
const provider = () => new EnvKeyProvider('k1', { k1: b64() });

describe('encrypt/decrypt', () => {
  it('round-trips, including empty and unicode strings', () => {
    const p = provider();
    for (const text of ['', 'shpat_abc123', 'ünïcödé 🚀 {"a":1}']) {
      expect(decrypt(encrypt(text, p), p)).toBe(text);
    }
  });
  it('produces different ciphertext each time (random IV)', () => {
    const p = provider();
    expect(encrypt('same', p)).not.toBe(encrypt('same', p));
  });
  it('embeds the key id and version', () => {
    expect(encrypt('x', provider()).startsWith('v1.k1.')).toBe(true);
  });
  it('detects tampering', () => {
    const p = provider();
    const parts = encrypt('secret', p).split('.');
    parts[4] = Buffer.from('tampered').toString('base64url');
    expect(() => decrypt(parts.join('.'), p)).toThrow();
  });
  it('fails with the wrong key', () => {
    const payload = encrypt('secret', provider());
    expect(() => decrypt(payload, provider())).toThrow();
  });
  it('binds ciphertext to AAD', () => {
    const p = provider();
    const payload = encrypt('secret', p, 'org-1');
    expect(decrypt(payload, p, 'org-1')).toBe('secret');
    expect(() => decrypt(payload, p, 'org-2')).toThrow();
  });
  it('decrypts old ciphertext after key rotation', () => {
    const oldKey = b64();
    const before = new EnvKeyProvider('k1', { k1: oldKey });
    const payload = encrypt('secret', before);
    const after = new EnvKeyProvider('k2', { k1: oldKey, k2: b64() });
    expect(decrypt(payload, after)).toBe('secret');
    expect(encrypt('new', after).startsWith('v1.k2.')).toBe(true);
  });
  it('rejects malformed payloads and unknown key ids', () => {
    const p = provider();
    expect(() => decrypt('garbage', p)).toThrow(/malformed/);
    expect(() => decrypt('v1.nokey.a.b.c', p)).toThrow(/unknown encryption key/);
  });
});

describe('EnvKeyProvider', () => {
  it('rejects keys that are not 32 bytes', () => {
    expect(() => new EnvKeyProvider('k', { k: Buffer.alloc(16).toString('base64') })).toThrow(/32 bytes/);
  });
  it('rejects key ids containing dots', () => {
    expect(() => new EnvKeyProvider('a.b', { 'a.b': b64() })).toThrow(/key id/);
  });
  it('requires the current id to exist', () => {
    expect(() => new EnvKeyProvider('missing', { k: b64() })).toThrow();
  });
  it('builds from env including retired keys', () => {
    const old = b64();
    const p = EnvKeyProvider.fromEnv({
      ENCRYPTION_KEY_ID: 'k2', ENCRYPTION_KEY: b64(), ENCRYPTION_OLD_KEYS: JSON.stringify({ k1: old }),
    });
    expect(p.get('k1').length).toBe(32);
    expect(p.current().keyId).toBe('k2');
  });
  it('throws a clear error when env is missing', () => {
    expect(() => EnvKeyProvider.fromEnv({})).toThrow(/ENCRYPTION_KEY/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @erq/shared test -- crypto`
Expected: FAIL, cannot resolve `../src/crypto`.

- [ ] **Step 3: Implement crypto**

`packages/shared/src/crypto.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface KeyProvider {
  current(): { keyId: string; key: Buffer };
  get(keyId: string): Buffer;
}

const KEY_ID_RE = /^[A-Za-z0-9_-]+$/;

export class EnvKeyProvider implements KeyProvider {
  private readonly keys = new Map<string, Buffer>();

  constructor(
    private readonly currentId: string,
    keys: Record<string, string>,
  ) {
    for (const [id, b64] of Object.entries(keys)) {
      if (!KEY_ID_RE.test(id)) throw new Error(`invalid key id "${id}": use letters, digits, - or _`);
      const key = Buffer.from(b64, 'base64');
      if (key.length !== 32) throw new Error(`encryption key "${id}" must be 32 bytes (base64)`);
      this.keys.set(id, key);
    }
    if (!this.keys.has(currentId)) throw new Error(`current encryption key "${currentId}" not provided`);
  }

  static fromEnv(env: Record<string, string | undefined>): EnvKeyProvider {
    const id = env.ENCRYPTION_KEY_ID;
    const key = env.ENCRYPTION_KEY;
    if (!id || !key) throw new Error('ENCRYPTION_KEY_ID and ENCRYPTION_KEY are required');
    const retired = env.ENCRYPTION_OLD_KEYS
      ? (JSON.parse(env.ENCRYPTION_OLD_KEYS) as Record<string, string>)
      : {};
    return new EnvKeyProvider(id, { ...retired, [id]: key });
  }

  current(): { keyId: string; key: Buffer } {
    return { keyId: this.currentId, key: this.get(this.currentId) };
  }

  get(keyId: string): Buffer {
    const key = this.keys.get(keyId);
    if (!key) throw new Error(`unknown encryption key id: ${keyId}`);
    return key;
  }
}

/** Format: v1.<keyId>.<iv>.<tag>.<ciphertext> (base64url parts). AES-256-GCM. */
export function encrypt(plaintext: string, provider: KeyProvider, aad?: string): string {
  const { keyId, key } = provider.current();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', keyId, iv, tag, ciphertext]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

export function decrypt(payload: string, provider: KeyProvider, aad?: string): string {
  const parts = payload.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') throw new Error('malformed ciphertext');
  const [, keyId = '', iv = '', tag = '', ciphertext = ''] = parts;
  const decipher = createDecipheriv('aes-256-gcm', provider.get(keyId), Buffer.from(iv, 'base64url'));
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
```

- [ ] **Step 4: Run crypto tests**

Run: `pnpm --filter @erq/shared test -- crypto`
Expected: PASS.

- [ ] **Step 5: Write the failing logger test**

`packages/shared/test/logger.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger';

function capture() {
  const lines: string[] = [];
  return { lines, destination: { write: (s: string) => void lines.push(s) } };
}

describe('createLogger', () => {
  it('redacts secrets at top level and nested', () => {
    const { lines, destination } = capture();
    const log = createLogger({ level: 'info', destination });
    log.info({ token: 'SECRET1', password: 'SECRET2' }, 'a');
    log.info({ conn: { access_token: 'SECRET3', encrypted_credentials: 'SECRET4' } }, 'b');
    log.info({ req: { headers: { authorization: 'Bearer SECRET5', cookie: 'SECRET6' } } }, 'c');
    const out = lines.join('');
    for (const s of ['SECRET1', 'SECRET2', 'SECRET3', 'SECRET4', 'SECRET5', 'SECRET6']) {
      expect(out).not.toContain(s);
    }
    expect(out).toContain('[REDACTED]');
  });
  it('keeps non-secret fields', () => {
    const { lines, destination } = capture();
    createLogger({ destination }).info({ orgId: 'abc' }, 'hello');
    expect(lines.join('')).toContain('abc');
  });
});
```

- [ ] **Step 6: Run to verify failure, then implement**

Run: `pnpm --filter @erq/shared add pino && pnpm --filter @erq/shared test -- logger`
Expected: FAIL, cannot resolve `../src/logger`.

`packages/shared/src/logger.ts`:

```ts
import pino from 'pino';

const SECRET_KEYS = [
  'token', 'password', 'authorization', 'cookie', 'access_token', 'refresh_token',
  'encrypted_credentials', 'credentials', 'secret', 'apiKey',
];

export const REDACT_PATHS = [
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((k) => `*.${k}`),
  'req.headers.authorization',
  'req.headers.cookie',
  '*.headers.authorization',
  '*.headers.cookie',
];

export interface LoggerOptions {
  level?: string;
  destination?: { write(chunk: string): void };
}

export function createLogger(opts: LoggerOptions = {}): pino.Logger {
  return pino(
    { level: opts.level ?? 'info', redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
    opts.destination,
  );
}
```

- [ ] **Step 7: Export and run**

Append to `packages/shared/src/index.ts`:

```ts
export * from './crypto';
export * from './logger';
```

Run: `pnpm --filter @erq/shared test`
Expected: PASS (money, crypto, logger).

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(shared): add AES-256-GCM crypto with key rotation and redacting pino logger"
```

---

### Task 4: `@erq/shared` schemas, roles, slug, API types

**Files:**
- Create: `packages/shared/src/schemas.ts`, `packages/shared/src/slug.ts`, `packages/shared/src/api-types.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/schemas.test.ts`, `packages/shared/test/slug.test.ts`

**Interfaces:**
- Produces: `orgRoleSchema`, `type OrgRole`, `hasRole(actual: OrgRole, min: OrgRole): boolean`, `uuidSchema`, `createOrgInput`, `createInviteInput`, `slugify(name: string): string`, `interface MeResponse`, `interface OrgSummary { orgId; name; slug; role }`, `interface MemberDto`, `interface InviteDto`.

- [ ] **Step 1: Write the failing tests**

`packages/shared/test/schemas.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createInviteInput, createOrgInput, hasRole, uuidSchema } from '../src/schemas';

describe('hasRole', () => {
  it('ranks owner > admin > analyst > viewer', () => {
    expect(hasRole('owner', 'admin')).toBe(true);
    expect(hasRole('admin', 'admin')).toBe(true);
    expect(hasRole('analyst', 'admin')).toBe(false);
    expect(hasRole('viewer', 'viewer')).toBe(true);
    expect(hasRole('viewer', 'analyst')).toBe(false);
  });
});

describe('createOrgInput', () => {
  it('trims and accepts a normal name', () => {
    expect(createOrgInput.parse({ name: '  Acme Goods ' })).toEqual({ name: 'Acme Goods' });
  });
  it.each([{ name: '' }, { name: 'a' }, { name: 'x'.repeat(101) }, {}, { name: 5 }])('rejects %j', (v) => {
    expect(createOrgInput.safeParse(v).success).toBe(false);
  });
});

describe('createInviteInput', () => {
  it('lowercases the email', () => {
    expect(createInviteInput.parse({ email: ' Bob@Example.COM ', role: 'viewer' })).toEqual({
      email: 'bob@example.com', role: 'viewer',
    });
  });
  it('cannot invite an owner', () => {
    expect(createInviteInput.safeParse({ email: 'a@b.co', role: 'owner' }).success).toBe(false);
  });
  it('rejects bad emails', () => {
    expect(createInviteInput.safeParse({ email: 'nope', role: 'admin' }).success).toBe(false);
  });
});

describe('uuidSchema', () => {
  it('accepts uuids and rejects other strings', () => {
    expect(uuidSchema.safeParse('11111111-1111-4111-8111-111111111111').success).toBe(true);
    expect(uuidSchema.safeParse("1'; drop table orgs;--").success).toBe(false);
  });
});
```

`packages/shared/test/slug.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { slugify } from '../src/slug';

describe('slugify', () => {
  it.each([
    ['Acme Goods', 'acme-goods'],
    ['  Café  Crème!! ', 'cafe-creme'],
    ['A & B / C', 'a-b-c'],
    ['---', 'org'],
    ['日本語', 'org'],
    ['', 'org'],
  ])('%j -> %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });
  it('truncates to 40 chars without a trailing dash', () => {
    const s = slugify('a'.repeat(39) + ' b' + 'c'.repeat(20));
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith('-')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @erq/shared add zod@^3 && pnpm --filter @erq/shared test -- schemas slug`
Expected: FAIL, cannot resolve modules. (zod 3 is pinned repo-wide so `zod-to-json-schema` works for OpenAPI bodies.)

- [ ] **Step 3: Implement**

`packages/shared/src/schemas.ts`:

```ts
import { z } from 'zod';

export const orgRoleSchema = z.enum(['owner', 'admin', 'analyst', 'viewer']);
export type OrgRole = z.infer<typeof orgRoleSchema>;

const ROLE_RANK: Record<OrgRole, number> = { viewer: 0, analyst: 1, admin: 2, owner: 3 };

/** True when `actual` is `min` or higher. */
export function hasRole(actual: OrgRole, min: OrgRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[min];
}

export const uuidSchema = z.string().uuid();

export const createOrgInput = z.object({ name: z.string().trim().min(2).max(100) });
export type CreateOrgInput = z.infer<typeof createOrgInput>;

export const createInviteInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: z.enum(['admin', 'analyst', 'viewer']),
});
export type CreateInviteInput = z.infer<typeof createInviteInput>;
```

`packages/shared/src/slug.ts`:

```ts
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'org';
}
```

`packages/shared/src/api-types.ts`:

```ts
import type { OrgRole } from './schemas';

export interface OrgSummary {
  orgId: string;
  name: string;
  slug: string;
  role: OrgRole;
}
export interface MeResponse {
  user: { id: string; email: string };
  orgs: OrgSummary[];
}
export interface MemberDto {
  userId: string;
  role: OrgRole;
  joinedAt: string;
}
export interface InviteDto {
  id: string;
  email: string;
  role: Exclude<OrgRole, 'owner'>;
  expiresAt: string;
  acceptedAt: string | null;
}
export interface CreatedInviteDto extends InviteDto {
  acceptUrl: string;
}
export interface ErrorResponse {
  error: { code: string; message: string; details?: unknown };
}
```

Append to `packages/shared/src/index.ts`:

```ts
export * from './schemas';
export * from './slug';
export * from './api-types';
```

- [ ] **Step 4: Run, build, commit**

Run: `pnpm --filter @erq/shared test && pnpm --filter @erq/shared build && pnpm --filter @erq/shared typecheck`
Expected: all PASS.

```bash
git add -A && git commit -m "feat(shared): add role, org, invite schemas, slugify and API types"
```

---

### Task 5: `@erq/db` package, Testcontainers helper, roles and helper migration

**Files:**
- Create: `packages/db/{package.json,tsconfig.json,tsup.config.ts,vitest.config.ts,drizzle.config.ts}`
- Create: `packages/db/src/admin.ts`, `packages/db/src/testing.ts`, `packages/db/src/index.ts` (placeholder export), `packages/db/src/schema/index.ts` (empty)
- Create: `packages/db/migrations/0000_roles_and_helpers.sql` (via drizzle-kit `--custom`)
- Test: `packages/db/test/roles.test.ts`

**Interfaces:**
- Produces (`@erq/db/admin`): `runMigrations(ownerUrl: string, appUserPassword: string): Promise<void>`; (`@erq/db/testing`): `startTestDatabase(): Promise<TestDatabase>` with `type TestDatabase = { ownerUrl: string; appUrl: string; stop(): Promise<void> }`.
- Produces SQL: role `app_user`; function `app_secure_tenant_table(tbl regclass, tenant_col text default 'org_id', has_updated_at boolean default true)` which enables and forces RLS, creates policy `tenant_isolation`, and adds the `set_updated_at` trigger; function `app_set_updated_at()`.

- [ ] **Step 1: Package files**

`packages/db/package.json`:

```json
{
  "name": "@erq/db",
  "version": "0.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./admin": { "types": "./dist/admin.d.ts", "default": "./dist/admin.js" },
    "./testing": { "types": "./dist/testing.d.ts", "default": "./dist/testing.js" }
  },
  "files": ["dist", "migrations"],
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "generate": "drizzle-kit generate",
    "migrate": "tsx src/cli/migrate.ts",
    "seed": "tsx src/cli/seed.ts"
  }
}
```

`packages/db/tsup.config.ts`:

```ts
import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts', 'src/admin.ts', 'src/testing.ts'],
  format: ['cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  // Resolved at runtime from the package's own node_modules, never bundled.
  external: ['testcontainers', '@testcontainers/postgresql'],
});
```

`tsconfig.json` as other packages. `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 180_000, pool: 'forks' },
});
```

`drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
});
```

`src/schema/index.ts`: `export {};` and `src/index.ts`: `export * from './schema';`

Install:

```bash
pnpm --filter @erq/db add drizzle-orm pg dotenv @erq/shared@workspace:*
pnpm --filter @erq/db add -D drizzle-kit tsx @types/pg testcontainers @testcontainers/postgresql
```

- [ ] **Step 2: Write `admin.ts` and `testing.ts`**

`packages/db/src/admin.ts`:

```ts
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

/**
 * Runs all migrations as the owner role, then sets the app_user password.
 * The owner must be a superuser or have BYPASSRLS because the SECURITY DEFINER
 * account functions rely on bypassing RLS (Supabase's `postgres` role qualifies).
 */
export async function runMigrations(ownerUrl: string, appUserPassword: string): Promise<void> {
  const pool = new Pool({ connectionString: ownerUrl, max: 1 });
  try {
    const { rows } = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'select rolsuper, rolbypassrls from pg_roles where rolname = current_user',
    );
    if (!rows[0]?.rolsuper && !rows[0]?.rolbypassrls) {
      throw new Error('Migration role must be a superuser or have BYPASSRLS.');
    }
    await migrate(drizzle(pool), { migrationsFolder: path.resolve(__dirname, '../migrations') });
    const { rows: stmt } = await pool.query<{ s: string }>(
      `select format('alter role app_user password %L', $1::text) as s`,
      [appUserPassword],
    );
    await pool.query(stmt[0]!.s);
  } finally {
    await pool.end();
  }
}

export { Pool };
```

`packages/db/src/testing.ts`:

```ts
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from './admin';

export interface TestDatabase {
  ownerUrl: string;
  appUrl: string;
  stop(): Promise<void>;
}

const APP_USER_PASSWORD = 'app_user_test';

/** Starts a throwaway Postgres 16, applies all migrations, returns owner and app_user URLs. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withUsername('erq_owner')
    .withPassword('owner')
    .withDatabase('erq')
    .start();
  const ownerUrl = container.getConnectionUri();
  await runMigrations(ownerUrl, APP_USER_PASSWORD);
  const app = new URL(ownerUrl);
  app.username = 'app_user';
  app.password = APP_USER_PASSWORD;
  return { ownerUrl, appUrl: app.toString(), stop: async () => void (await container.stop()) };
}
```

- [ ] **Step 3: Write the failing test**

`packages/db/test/roles.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { startTestDatabase, type TestDatabase } from '../src/testing';

let tdb: TestDatabase;
let owner: Pool;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
});
afterAll(async () => {
  await owner.end();
  await tdb.stop();
});

describe('roles and helpers migration', () => {
  it('creates app_user without superuser or BYPASSRLS', async () => {
    const { rows } = await owner.query(
      `select rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname = 'app_user'`,
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcanlogin: true });
  });
  it('lets app_user log in with the configured password', async () => {
    const app = new Pool({ connectionString: tdb.appUrl });
    const { rows } = await app.query('select current_user as u');
    expect(rows[0].u).toBe('app_user');
    await app.end();
  });
  it('does not let app_user create objects in public', async () => {
    const app = new Pool({ connectionString: tdb.appUrl });
    await expect(app.query('create table nope (id int)')).rejects.toThrow(/permission denied/);
    await app.end();
  });
  it('installs the RLS helper and updated_at trigger function', async () => {
    const { rows } = await owner.query(
      `select proname from pg_proc where proname in ('app_secure_tenant_table','app_set_updated_at') order by 1`,
    );
    expect(rows.map((r) => r.proname)).toEqual(['app_secure_tenant_table', 'app_set_updated_at']);
  });
});
```

- [ ] **Step 4: Generate the custom migration and run to verify failure**

```bash
cd packages/db && pnpm drizzle-kit generate --custom --name=roles_and_helpers && cd ../..
pnpm turbo run test --filter=@erq/db
```

Expected: the generated `migrations/0000_roles_and_helpers.sql` is empty, so tests FAIL ("role app_user does not exist" / missing functions). Docker must be running.

- [ ] **Step 5: Write the migration SQL**

Fill `packages/db/migrations/0000_roles_and_helpers.sql` (statements separated by `--> statement-breakpoint`, which drizzle's migrator requires):

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_user;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_secure_tenant_table(
  tbl regclass,
  tenant_col text DEFAULT 'org_id',
  has_updated_at boolean DEFAULT true
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  -- nullif: after a transaction ends the setting reverts to '' (not NULL); casting '' to uuid would error.
  EXECUTE format(
    $p$CREATE POLICY tenant_isolation ON %s
       USING (%I = nullif(current_setting('app.org_id', true), '')::uuid)
       WITH CHECK (%I = nullif(current_setting('app.org_id', true), '')::uuid)$p$,
    tbl, tenant_col, tenant_col);
  IF has_updated_at THEN
    EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON %s', tbl);
    EXECUTE format(
      'CREATE TRIGGER set_updated_at BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION app_set_updated_at()', tbl);
  END IF;
END $$;
```

- [ ] **Step 6: Run to verify pass, then commit**

Run: `pnpm turbo run test typecheck --filter=@erq/db`
Expected: PASS.

```bash
git add -A && git commit -m "feat(db): add db package, test database helper, app_user role and RLS helper migration"
```

### Task 6: Identity and audit schema, RLS, `withTenant`, isolation harness

**Files:**
- Create: `packages/db/src/schema/{timestamps,orgs,tenant,identity}.ts`; modify `packages/db/src/schema/index.ts`
- Create: `packages/db/src/tenant-db.ts`, `packages/db/src/audit.ts`; modify `packages/db/src/index.ts`
- Create: migrations `0001_*.sql` (generated) and `0002_identity_rls.sql` (custom)
- Test: `packages/db/test/fixtures.ts`, `packages/db/test/tenant.test.ts`, `packages/db/test/isolation.test.ts`, `packages/db/test/audit-log.test.ts`

**Interfaces:**
- Produces: tables `orgs, orgMembers, invites, subscriptions, auditLog`; enum `orgRole`; helper `tenantId()` (returns the `org_id` uuid column with FK to `orgs.id`) and `timestamps` for later schema files.
- Produces (`@erq/db`): `type Database`, `type Tx`, `interface TenantDb { withTenant<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T>; pool: Pool; close(): Promise<void> }`, `createTenantDb(connectionString: string, opts?: { max?: number }): TenantDb`, `insertAudit(tx: Tx, entry: { orgId: string; actorUserId: string | null; action: string; entityType: string; entityId?: string; before?: unknown; after?: unknown }): Promise<void>`.
- Produces (tests): `fixtures: Record<string, (q: Queryable, orgId: string) => Promise<unknown>>`, one entry per tenant table, in parent-before-child order. Later tasks add entries; the isolation suite fails if a table lacks one.

- [ ] **Step 1: Schema files**

`packages/db/src/schema/timestamps.ts`:

```ts
import { timestamp } from 'drizzle-orm/pg-core';

export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};
```

`packages/db/src/schema/orgs.ts`:

```ts
import { char, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps } from './timestamps';

export const orgs = pgTable('orgs', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  reportingCurrency: char('reporting_currency', { length: 3 }).notNull().default('USD'),
  timezone: text('timezone').notNull().default('America/New_York'),
  ...timestamps,
});
```

`packages/db/src/schema/tenant.ts`:

```ts
import { uuid } from 'drizzle-orm/pg-core';
import { orgs } from './orgs';

/** The org_id column every tenant table carries. */
export const tenantId = () =>
  uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' });
```

`packages/db/src/schema/identity.ts`:

```ts
import { index, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { tenantId } from './tenant';
import { timestamps } from './timestamps';

export const orgRole = pgEnum('org_role', ['owner', 'admin', 'analyst', 'viewer']);

export const orgMembers = pgTable(
  'org_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    userId: uuid('user_id').notNull(), // Supabase auth user id; no FK (auth lives in another database)
    role: orgRole('role').notNull(),
    ...timestamps,
  },
  (t) => [unique('org_members_org_user_uq').on(t.orgId, t.userId), index('org_members_user_idx').on(t.userId)],
);

export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    email: text('email').notNull(),
    role: orgRole('role').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    invitedBy: uuid('invited_by'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('invites_org_idx').on(t.orgId)],
);

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: tenantId().unique(),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  plan: text('plan').notNull().default('free'),
  status: text('status').notNull().default('active'),
  ...timestamps,
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    actorUserId: uuid('actor_user_id'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    beforeJson: jsonb('before_json'),
    afterJson: jsonb('after_json'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_log_org_created_idx').on(t.orgId, t.createdAt)],
);
```

`packages/db/src/schema/index.ts`:

```ts
export * from './orgs';
export * from './tenant';
export * from './timestamps';
export * from './identity';
```

- [ ] **Step 2: Generate the schema migration and write the RLS migration**

```bash
cd packages/db
pnpm drizzle-kit generate --name=identity
pnpm drizzle-kit generate --custom --name=identity_rls
cd ../..
```

Expected: `0001_identity.sql` (generated, do not edit) and an empty `0002_identity_rls.sql`. Fill the latter:

```sql
SELECT app_secure_tenant_table('orgs', 'id');
--> statement-breakpoint
SELECT app_secure_tenant_table('org_members');
--> statement-breakpoint
SELECT app_secure_tenant_table('invites');
--> statement-breakpoint
SELECT app_secure_tenant_table('subscriptions');
--> statement-breakpoint
SELECT app_secure_tenant_table('audit_log', 'org_id', false);
--> statement-breakpoint
REVOKE UPDATE, DELETE ON audit_log FROM app_user;
```

- [ ] **Step 3: Write `tenant-db.ts` and `audit.ts`**

`packages/db/src/tenant-db.ts`:

```ts
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface TenantDb {
  /** Runs fn in a transaction with app.org_id set locally, so RLS scopes every query to orgId. */
  withTenant<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  pool: Pool;
  close(): Promise<void>;
}

export function createTenantDb(connectionString: string, opts: { max?: number } = {}): TenantDb {
  const pool = new Pool({ connectionString, max: opts.max ?? 10 });
  // Idle-client errors would otherwise crash the process; they surface on the next query.
  pool.on('error', () => undefined);
  const db = drizzle(pool, { schema });
  return {
    pool,
    withTenant(orgId, fn) {
      if (!UUID_RE.test(orgId)) throw new TypeError('withTenant requires a uuid orgId');
      return db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
        return fn(tx);
      });
    },
    close: () => pool.end(),
  };
}
```

`packages/db/src/audit.ts`:

```ts
import { auditLog } from './schema';
import type { Tx } from './tenant-db';

export interface AuditEntry {
  orgId: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
}

export async function insertAudit(tx: Tx, e: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    orgId: e.orgId,
    actorUserId: e.actorUserId,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    beforeJson: e.before ?? null,
    afterJson: e.after ?? null,
  });
}
```

`packages/db/src/index.ts`:

```ts
export * from './schema';
export * from './tenant-db';
export * from './audit';
```

- [ ] **Step 4: Write the failing tests (fixtures, tenant, isolation, audit)**

`packages/db/test/fixtures.ts`:

```ts
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}
export type Fixture = (q: Queryable, orgId: string) => Promise<unknown>;

/**
 * One entry per tenant table, parents before children. Each inserts a minimal valid row for orgId.
 * Child fixtures reuse orgId as the parent row's id. The isolation suite fails if a table has no entry.
 */
export const fixtures: Record<string, Fixture> = {
  orgs: (q, id) => q.query(`insert into orgs (id, name, slug) values ($1, $2, $3)`, [id, `Org ${id}`, `org-${id}`]),
  org_members: (q, org) =>
    q.query(`insert into org_members (org_id, user_id, role) values ($1, gen_random_uuid(), 'owner')`, [org]),
  invites: (q, org) =>
    q.query(
      `insert into invites (org_id, email, role, token_hash, expires_at)
       values ($1, 'a@b.co', 'viewer', gen_random_uuid()::text, now() + interval '1 day')`,
      [org],
    ),
  subscriptions: (q, org) => q.query(`insert into subscriptions (org_id) values ($1)`, [org]),
  audit_log: (q, org) =>
    q.query(`insert into audit_log (org_id, action, entity_type) values ($1, 'test', 'org')`, [org]),
};
```

`packages/db/test/tenant.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createTenantDb, orgMembers, orgs, type TenantDb } from '../src';
import { startTestDatabase, type TestDatabase } from '../src/testing';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let tdb: TestDatabase;
let owner: Pool;
let db: TenantDb;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  await owner.query(`insert into orgs (id, name, slug) values ($1,'A','a'), ($2,'B','b')`, [A, B]);
  await owner.query(`insert into org_members (org_id, user_id, role) values ($1, gen_random_uuid(), 'owner')`, [A]);
  db = createTenantDb(tdb.appUrl);
});
afterAll(async () => {
  await db.close();
  await owner.end();
  await tdb.stop();
});

describe('withTenant', () => {
  it('scopes reads to the given org', async () => {
    const rows = await db.withTenant(A, (tx) => tx.select().from(orgs));
    expect(rows.map((r) => r.id)).toEqual([A]);
    const members = await db.withTenant(B, (tx) => tx.select().from(orgMembers));
    expect(members).toEqual([]);
  });
  it('returns no rows when no org context is set', async () => {
    const { rows } = await db.pool.query('select * from orgs');
    expect(rows).toEqual([]);
  });
  it('rejects writes for a different org (WITH CHECK)', async () => {
    await expect(
      db.withTenant(B, (tx) => tx.insert(orgMembers).values({ orgId: A, userId: crypto.randomUUID(), role: 'viewer' })),
    ).rejects.toThrow(/row-level security|violates/);
  });
  it('rejects a non-uuid orgId before touching the database', () => {
    expect(() => db.withTenant("x'; drop table orgs;--", async () => 1)).toThrow(TypeError);
  });
  it('does not leak a previous tenant onto a reused connection (and does not error on the empty setting)', async () => {
    const single = createTenantDb(tdb.appUrl, { max: 1 });
    try {
      await single.withTenant(A, (tx) => tx.select().from(orgs));
      const { rows } = await single.pool.query('select * from orgs'); // same physical connection
      expect(rows).toEqual([]);
    } finally {
      await single.close();
    }
  });
  it('rolls back when fn throws', async () => {
    await expect(
      db.withTenant(A, async (tx) => {
        await tx.insert(orgMembers).values({ orgId: A, userId: crypto.randomUUID(), role: 'viewer' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const { rows } = await owner.query('select count(*)::int as n from org_members where org_id = $1', [A]);
    expect(rows[0].n).toBe(1);
  });
});
```

`packages/db/test/isolation.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { startTestDatabase, type TestDatabase } from '../src/testing';
import { fixtures } from './fixtures';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const APPEND_ONLY = new Set(['audit_log']); // app_user has no UPDATE/DELETE grant by design

let tdb: TestDatabase;
let owner: Pool;
let app: Pool;

async function asTenant<T>(orgId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await app.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.org_id', $1, true)`, [orgId]);
    const result = await fn(c);
    await c.query('commit');
    return result;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  app = new Pool({ connectionString: tdb.appUrl });
  for (const org of [ORG_A, ORG_B]) {
    for (const insert of Object.values(fixtures)) await insert(owner, org);
  }
});
afterAll(async () => {
  await app.end();
  await owner.end();
  await tdb.stop();
});

it('every public table has RLS enabled and forced, a tenant column, and a fixture', async () => {
  const { rows } = await owner.query(`
    select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
      exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped) as has_org_id
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'`);
  const problems: string[] = [];
  for (const t of rows) {
    if (!t.has_org_id && t.name !== 'orgs') problems.push(`${t.name}: no org_id column`);
    if (!t.rls || !t.forced) problems.push(`${t.name}: RLS must be enabled and forced`);
    if (!(t.name in fixtures)) problems.push(`${t.name}: add a fixture in test/fixtures.ts`);
  }
  expect(problems).toEqual([]);
});

describe.each(Object.keys(fixtures))('tenant isolation: %s', (table) => {
  const col = table === 'orgs' ? 'id' : 'org_id';

  it('tenant B sees only its own rows (and can see its own: not vacuous)', async () => {
    await asTenant(ORG_B, async (c) => {
      const own = await c.query(`select ${col} from ${table}`);
      expect(own.rows.length).toBeGreaterThan(0);
      expect(own.rows.every((r) => r[col] === ORG_B)).toBe(true);
      expect((await c.query(`select 1 from ${table} where ${col} = $1`, [ORG_A])).rowCount).toBe(0);
    });
  });

  it.skipIf(APPEND_ONLY.has(table))('tenant B cannot update or delete tenant A rows', async () => {
    await asTenant(ORG_B, async (c) => {
      expect((await c.query(`update ${table} set ${col} = ${col} where ${col} = $1`, [ORG_A])).rowCount).toBe(0);
      expect((await c.query(`delete from ${table} where ${col} = $1`, [ORG_A])).rowCount).toBe(0);
    });
  });

  it('tenant B cannot insert a row for tenant A', async () => {
    await expect(asTenant(ORG_B, (c) => fixtures[table]!(c, ORG_A))).rejects.toThrow(/row-level security/);
  });

  it('no tenant context returns zero rows', async () => {
    const { rows } = await app.query(`select 1 from ${table}`);
    expect(rows).toEqual([]);
  });
});
```

`packages/db/test/audit-log.test.ts`:

```ts
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createTenantDb, insertAudit, type TenantDb } from '../src';
import { startTestDatabase, type TestDatabase } from '../src/testing';

const ORG = '11111111-1111-4111-8111-111111111111';
let tdb: TestDatabase;
let db: TenantDb;

beforeAll(async () => {
  tdb = await startTestDatabase();
  const owner = new Pool({ connectionString: tdb.ownerUrl });
  await owner.query(`insert into orgs (id, name, slug) values ($1,'A','a')`, [ORG]);
  await owner.end();
  db = createTenantDb(tdb.appUrl);
});
afterAll(async () => {
  await db.close();
  await tdb.stop();
});

it('allows inserts', async () => {
  await db.withTenant(ORG, (tx) => insertAudit(tx, { orgId: ORG, actorUserId: null, action: 'x.y', entityType: 'x', after: { a: 1 } }));
  const { rows } = await db.withTenant(ORG, (tx) => tx.execute(`select action, after_json from audit_log`));
  expect(rows).toHaveLength(1);
});
it('is append-only: update and delete are denied', async () => {
  await expect(db.withTenant(ORG, (tx) => tx.execute(`update audit_log set action = 'z'`))).rejects.toThrow(/permission denied/);
  await expect(db.withTenant(ORG, (tx) => tx.execute(`delete from audit_log`))).rejects.toThrow(/permission denied/);
});
```

- [ ] **Step 5: Run to verify**

Run: `pnpm turbo run test typecheck --filter=@erq/db`
Expected: PASS. If `db.withTenant(... tx.execute(\`...\`))` with a plain string fails typechecking, wrap in `sql.raw(...)` from `drizzle-orm`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(db): add identity and audit schema with RLS, withTenant, and isolation suite"
```

---

### Task 7: Connections and catalog schema (with cross-tenant-safe foreign keys)

**Files:**
- Create: `packages/db/src/schema/{connections,catalog}.ts`; modify `packages/db/src/schema/index.ts`
- Create: migrations `0003_connections_catalog.sql` (generated) and `0004_connections_catalog_rls.sql` (custom)
- Modify: `packages/db/test/fixtures.ts`
- Test: `packages/db/test/catalog-fk.test.ts`

**Interfaces:**
- Produces: tables `storeConnections, adConnections, syncRuns, products, skus, skuCostComponents`; enums `storePlatform, adPlatform, connectionStatus, connectionKind, syncStatus, productStatus, skuStatus, costComponentType`.
- Consumes: `tenantId`, `timestamps` from Task 6.

- [ ] **Step 1: Write the failing tests first**

Add to `fixtures.ts` (after `audit_log`, order matters):

```ts
  store_connections: (q, org) =>
    q.query(
      `insert into store_connections (org_id, platform, external_account_id, status)
       values ($1, 'shopify', 'shop-' || $1::text, 'demo')`,
      [org],
    ),
  ad_connections: (q, org) =>
    q.query(
      `insert into ad_connections (org_id, platform, external_account_id, status)
       values ($1, 'meta', 'act-' || $1::text, 'demo')`,
      [org],
    ),
  sync_runs: (q, org) =>
    q.query(
      `insert into sync_runs (org_id, connection_kind, connection_id, type, status)
       values ($1, 'store', gen_random_uuid(), 'backfill', 'running')`,
      [org],
    ),
  products: (q, org) => q.query(`insert into products (id, org_id, title) values ($1, $1, 'Widget')`, [org]),
  skus: (q, org) =>
    q.query(
      `insert into skus (id, org_id, product_id, sku_code, selling_price_cents)
       values ($1, $1, $1, 'SKU-1', 2999)`,
      [org],
    ),
  sku_cost_components: (q, org) =>
    q.query(
      `insert into sku_cost_components (org_id, sku_id, component_type, amount_cents, effective_from)
       values ($1, $1, 'product_cost', 1000, '2025-01-01')`,
      [org],
    ),
```

`packages/db/test/catalog-fk.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
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
  await db.close();
  await owner.end();
  await tdb.stop();
});

describe('cross-tenant references are rejected by composite foreign keys', () => {
  it("a tenant-B sku cannot point at tenant A's product", async () => {
    await expect(
      db.withTenant(B, (tx) =>
        tx.execute(`insert into skus (org_id, product_id, sku_code, selling_price_cents) values ('${B}', '${A}', 'X', 100)`),
      ),
    ).rejects.toThrow(/foreign key|violates/);
  });
  it("a tenant-B cost component cannot point at tenant A's sku", async () => {
    await expect(
      db.withTenant(B, (tx) =>
        tx.execute(
          `insert into sku_cost_components (org_id, sku_id, component_type, amount_cents, effective_from)
           values ('${B}', '${A}', 'packaging', 5, '2025-01-01')`,
        ),
      ),
    ).rejects.toThrow(/foreign key|violates/);
  });
});

describe('catalog constraints', () => {
  it('rejects a cost period that ends before it starts', async () => {
    await expect(
      owner.query(
        `insert into sku_cost_components (org_id, sku_id, component_type, amount_cents, effective_from, effective_to)
         values ($1, $1, 'packaging', 5, '2025-06-01', '2025-01-01')`,
        [A],
      ),
    ).rejects.toThrow(/cost_period_valid|check/);
  });
  it('rejects negative amounts and prices', async () => {
    await expect(
      owner.query(
        `insert into sku_cost_components (org_id, sku_id, component_type, amount_cents, effective_from)
         values ($1, $1, 'packaging', -1, '2025-01-01')`,
        [A],
      ),
    ).rejects.toThrow(/check/);
    await expect(
      owner.query(`insert into skus (org_id, product_id, sku_code, selling_price_cents) values ($1, $1, 'NEG', -5)`, [A]),
    ).rejects.toThrow(/check/);
  });
  it('enforces unique sku_code per org but not across orgs', async () => {
    await expect(
      owner.query(`insert into skus (org_id, product_id, sku_code, selling_price_cents) values ($1, $1, 'SKU-1', 5)`, [A]),
    ).rejects.toThrow(/unique|duplicate/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm turbo run test --filter=@erq/db`
Expected: FAIL (relations do not exist).

- [ ] **Step 3: Write schema files**

`packages/db/src/schema/connections.ts`:

```ts
import { index, integer, pgEnum, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { tenantId } from './tenant';
import { timestamps } from './timestamps';

export const storePlatform = pgEnum('store_platform', ['shopify', 'woocommerce', 'amazon']);
export const adPlatform = pgEnum('ad_platform', ['meta', 'google', 'tiktok']);
export const connectionStatus = pgEnum('connection_status', ['pending', 'active', 'error', 'disconnected', 'demo']);
export const connectionKind = pgEnum('connection_kind', ['store', 'ad']);
export const syncStatus = pgEnum('sync_status', ['running', 'succeeded', 'failed']);

export const storeConnections = pgTable(
  'store_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    platform: storePlatform('platform').notNull(),
    externalAccountId: text('external_account_id').notNull(),
    status: connectionStatus('status').notNull().default('pending'),
    encryptedCredentials: text('encrypted_credentials'), // AES-256-GCM via @erq/shared crypto
    scopes: text('scopes').array(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),
    ...timestamps,
  },
  (t) => [unique('store_connections_org_platform_acct_uq').on(t.orgId, t.platform, t.externalAccountId)],
);

export const adConnections = pgTable(
  'ad_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    platform: adPlatform('platform').notNull(),
    externalAccountId: text('external_account_id').notNull(),
    status: connectionStatus('status').notNull().default('pending'),
    encryptedCredentials: text('encrypted_credentials'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),
    ...timestamps,
  },
  (t) => [unique('ad_connections_org_platform_acct_uq').on(t.orgId, t.platform, t.externalAccountId)],
);

export const syncRuns = pgTable(
  'sync_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    connectionKind: connectionKind('connection_kind').notNull(),
    connectionId: uuid('connection_id').notNull(), // polymorphic: store_connections or ad_connections
    type: text('type').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    status: syncStatus('status').notNull().default('running'),
    recordsProcessed: integer('records_processed').notNull().default(0),
    error: text('error'),
    ...timestamps,
  },
  (t) => [index('sync_runs_org_created_idx').on(t.orgId, t.createdAt)],
);
```

`packages/db/src/schema/catalog.ts`:

```ts
import { sql } from 'drizzle-orm';
import {
  bigint, boolean, char, check, date, foreignKey, index, numeric, pgEnum, pgTable, text, unique, uuid,
} from 'drizzle-orm/pg-core';
import { tenantId } from './tenant';
import { timestamps } from './timestamps';

export const productStatus = pgEnum('product_status', ['active', 'draft', 'archived']);
export const skuStatus = pgEnum('sku_status', ['active', 'inactive']);
export const costComponentType = pgEnum('cost_component_type', [
  'product_cost', 'inbound_freight', 'duties_tariffs', 'packaging', 'labeling_prep', 'other_landed',
]);

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    title: text('title').notNull(),
    brand: text('brand'),
    category: text('category'),
    status: productStatus('status').notNull().default('active'),
    ...timestamps,
  },
  // (org_id, id) is the target of composite FKs so children can never reference another tenant's parent.
  (t) => [unique('products_org_id_uq').on(t.orgId, t.id)],
);

export const skus = pgTable(
  'skus',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    productId: uuid('product_id').notNull(),
    skuCode: text('sku_code').notNull(),
    barcode: text('barcode'),
    sellingPriceCents: bigint('selling_price_cents', { mode: 'number' }).notNull(),
    compareAtPriceCents: bigint('compare_at_price_cents', { mode: 'number' }),
    currency: char('currency', { length: 3 }).notNull().default('USD'),
    targetMarkupPct: numeric('target_markup_pct', { precision: 6, scale: 2 }),
    status: skuStatus('status').notNull().default('active'),
    ...timestamps,
  },
  (t) => [
    unique('skus_org_id_uq').on(t.orgId, t.id),
    unique('skus_org_code_uq').on(t.orgId, t.skuCode),
    foreignKey({ columns: [t.orgId, t.productId], foreignColumns: [products.orgId, products.id] }).onDelete('cascade'),
    index('skus_org_product_idx').on(t.orgId, t.productId),
    check('skus_price_nonneg', sql`${t.sellingPriceCents} >= 0`),
  ],
);

export const skuCostComponents = pgTable(
  'sku_cost_components',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    skuId: uuid('sku_id').notNull(),
    componentType: costComponentType('component_type').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    perUnit: boolean('per_unit').notNull().default(true),
    currency: char('currency', { length: 3 }).notNull().default('USD'),
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    effectiveTo: date('effective_to', { mode: 'string' }),
    ...timestamps,
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.skuId], foreignColumns: [skus.orgId, skus.id] }).onDelete('cascade'),
    index('sku_cost_components_org_sku_idx').on(t.orgId, t.skuId),
    check('cost_amount_nonneg', sql`${t.amountCents} >= 0`),
    check('cost_period_valid', sql`${t.effectiveTo} is null or ${t.effectiveTo} > ${t.effectiveFrom}`),
  ],
);
```

Append to `schema/index.ts`: `export * from './connections';` and `export * from './catalog';`

- [ ] **Step 4: Generate migrations and the RLS migration**

```bash
cd packages/db
pnpm drizzle-kit generate --name=connections_catalog
pnpm drizzle-kit generate --custom --name=connections_catalog_rls
cd ../..
```

Fill `0004_connections_catalog_rls.sql`:

```sql
SELECT app_secure_tenant_table('store_connections');
--> statement-breakpoint
SELECT app_secure_tenant_table('ad_connections');
--> statement-breakpoint
SELECT app_secure_tenant_table('sync_runs');
--> statement-breakpoint
SELECT app_secure_tenant_table('products');
--> statement-breakpoint
SELECT app_secure_tenant_table('skus');
--> statement-breakpoint
SELECT app_secure_tenant_table('sku_cost_components');
```

- [ ] **Step 5: Run to verify pass, then commit**

Run: `pnpm turbo run test typecheck --filter=@erq/db`
Expected: PASS, including the isolation suite now iterating the new tables.

```bash
git add -A && git commit -m "feat(db): add connections and catalog schema with tenant-safe composite foreign keys"
```

### Task 8: Pre-org account functions (list orgs, create org, accept invite)

**Files:**
- Create: migration `0005_account_functions.sql` (custom), `packages/db/src/account.ts`; modify `packages/db/src/index.ts`
- Test: `packages/db/test/account.test.ts`

**Interfaces:**
- Consumes: `slugify`, `OrgRole`, `OrgSummary` from `@erq/shared`.
- Produces (`@erq/db`): `createAccountApi(pool: Pool): AccountApi` where
  `AccountApi = { listUserOrgs(userId): Promise<OrgSummary[]>; createOrg(userId, name): Promise<OrgSummary>; acceptInvite(userId, email, token): Promise<{ orgId: string; role: OrgRole }> }`;
  `generateInviteToken(): string`; `hashInviteToken(token: string): string`; `class InviteInvalidError extends Error`.
- SQL: `app_list_user_orgs(uuid)`, `app_create_org(uuid, text, text) returns uuid`, `app_accept_invite(uuid, text, text)`; all `SECURITY DEFINER`, `EXECUTE` granted to `app_user` only.

- [ ] **Step 1: Write the failing tests**

`packages/db/test/account.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createAccountApi, createTenantDb, generateInviteToken, hashInviteToken, InviteInvalidError, type TenantDb } from '../src';
import { startTestDatabase, type TestDatabase } from '../src/testing';

const U1 = '00000000-0000-4000-8000-0000000000a1';
const U2 = '00000000-0000-4000-8000-0000000000a2';
let tdb: TestDatabase;
let owner: Pool;
let db: TenantDb;
let account: ReturnType<typeof createAccountApi>;

async function seedInvite(orgId: string, email: string, opts: { expired?: boolean } = {}) {
  const token = generateInviteToken();
  await owner.query(
    `insert into invites (org_id, email, role, token_hash, expires_at)
     values ($1, $2, 'analyst', $3, now() + ($4 || ' hours')::interval)`,
    [orgId, email, hashInviteToken(token), opts.expired ? '-1' : '24'],
  );
  return token;
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  db = createTenantDb(tdb.appUrl);
  account = createAccountApi(db.pool);
});
afterAll(async () => {
  await db.close();
  await owner.end();
  await tdb.stop();
});

describe('createOrg / listUserOrgs', () => {
  it('creates the org with an owner membership, a subscription, and an audit entry', async () => {
    const org = await account.createOrg(U1, 'Acme Goods');
    expect(org).toMatchObject({ name: 'Acme Goods', slug: 'acme-goods', role: 'owner' });
    const counts = await owner.query(
      `select (select count(*) from org_members where org_id = $1)::int m,
              (select count(*) from subscriptions where org_id = $1)::int s,
              (select count(*) from audit_log where org_id = $1 and action = 'org.created')::int a`,
      [org.orgId],
    );
    expect(counts.rows[0]).toEqual({ m: 1, s: 1, a: 1 });
  });
  it('suffixes the slug on collision', async () => {
    const a = await account.createOrg(U1, 'Same Name');
    const b = await account.createOrg(U2, 'Same Name');
    expect(a.slug).toBe('same-name');
    expect(b.slug).toMatch(/^same-name-[0-9a-f]{6}$/);
  });
  it("lists only the caller's orgs", async () => {
    const mine = await account.listUserOrgs(U2);
    expect(mine.every((o) => o.role === 'owner')).toBe(true);
    expect(mine.map((o) => o.name)).toContain('Same Name');
    expect(mine.map((o) => o.name)).not.toContain('Acme Goods');
    expect(await account.listUserOrgs('00000000-0000-4000-8000-0000000000ff')).toEqual([]);
  });
});

describe('acceptInvite', () => {
  it('adds the member once and marks the invite accepted', async () => {
    const org = await account.createOrg(U1, 'Invite Co');
    const token = await seedInvite(org.orgId, 'bob@example.com');
    const result = await account.acceptInvite(U2, 'Bob@Example.com', token);
    expect(result).toEqual({ orgId: org.orgId, role: 'analyst' });
    expect((await account.listUserOrgs(U2)).map((o) => o.orgId)).toContain(org.orgId);
  });
  it('rejects reuse of the same token', async () => {
    const org = await account.createOrg(U1, 'Reuse Co');
    const token = await seedInvite(org.orgId, 'bob@example.com');
    await account.acceptInvite(U2, 'bob@example.com', token);
    await expect(account.acceptInvite(U2, 'bob@example.com', token)).rejects.toBeInstanceOf(InviteInvalidError);
  });
  it('rejects expired invites', async () => {
    const org = await account.createOrg(U1, 'Expired Co');
    const token = await seedInvite(org.orgId, 'bob@example.com', { expired: true });
    await expect(account.acceptInvite(U2, 'bob@example.com', token)).rejects.toBeInstanceOf(InviteInvalidError);
  });
  it('rejects a user whose email differs from the invited email', async () => {
    const org = await account.createOrg(U1, 'Wrong Email Co');
    const token = await seedInvite(org.orgId, 'bob@example.com');
    await expect(account.acceptInvite(U2, 'mallory@example.com', token)).rejects.toBeInstanceOf(InviteInvalidError);
    expect((await account.listUserOrgs(U2)).map((o) => o.orgId)).not.toContain(org.orgId);
  });
  it('rejects unknown tokens', async () => {
    await expect(account.acceptInvite(U2, 'bob@example.com', 'nope')).rejects.toBeInstanceOf(InviteInvalidError);
  });
});

describe('privileges', () => {
  it('app_user can execute the functions but not read tables without tenant context', async () => {
    const { rows } = await db.pool.query('select * from org_members');
    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm turbo run test --filter=@erq/db`
Expected: FAIL (cannot resolve `createAccountApi`).

- [ ] **Step 3: Custom migration**

```bash
cd packages/db && pnpm drizzle-kit generate --custom --name=account_functions && cd ../..
```

Fill `packages/db/migrations/0005_account_functions.sql`:

```sql
CREATE OR REPLACE FUNCTION app_list_user_orgs(p_user_id uuid)
RETURNS TABLE (org_id uuid, name text, slug text, role org_role)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT o.id, o.name, o.slug, m.role
  FROM org_members m JOIN orgs o ON o.id = m.org_id
  WHERE m.user_id = p_user_id
  ORDER BY o.name, o.id
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_create_org(p_user_id uuid, p_name text, p_slug text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid;
BEGIN
  INSERT INTO orgs (name, slug) VALUES (p_name, p_slug) RETURNING id INTO v_org;
  INSERT INTO org_members (org_id, user_id, role) VALUES (v_org, p_user_id, 'owner');
  INSERT INTO subscriptions (org_id) VALUES (v_org);
  INSERT INTO audit_log (org_id, actor_user_id, action, entity_type, entity_id, after_json)
  VALUES (v_org, p_user_id, 'org.created', 'org', v_org::text, jsonb_build_object('name', p_name));
  RETURN v_org;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_accept_invite(p_user_id uuid, p_user_email text, p_token_hash text)
RETURNS TABLE (o_org_id uuid, o_role org_role)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE inv invites%ROWTYPE;
BEGIN
  SELECT * INTO inv FROM invites WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND
     OR inv.accepted_at IS NOT NULL
     OR inv.expires_at < now()
     OR lower(inv.email) <> lower(p_user_email) THEN
    RAISE EXCEPTION 'invite_invalid';
  END IF;
  INSERT INTO org_members (org_id, user_id, role) VALUES (inv.org_id, p_user_id, inv.role)
  ON CONFLICT (org_id, user_id) DO NOTHING;
  UPDATE invites SET accepted_at = now() WHERE id = inv.id;
  INSERT INTO audit_log (org_id, actor_user_id, action, entity_type, entity_id)
  VALUES (inv.org_id, p_user_id, 'invite.accepted', 'invite', inv.id::text);
  RETURN QUERY SELECT m.org_id, m.role FROM org_members m WHERE m.org_id = inv.org_id AND m.user_id = p_user_id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_list_user_orgs(uuid), app_create_org(uuid, text, text), app_accept_invite(uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_list_user_orgs(uuid), app_create_org(uuid, text, text), app_accept_invite(uuid, text, text) TO app_user;
```

- [ ] **Step 4: Implement `account.ts`**

`packages/db/src/account.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { slugify, type OrgRole, type OrgSummary } from '@erq/shared';

export class InviteInvalidError extends Error {
  constructor() {
    super('invite_invalid');
  }
}

export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface OrgRow {
  org_id: string;
  name: string;
  slug: string;
  role: OrgRole;
}
const toSummary = (r: OrgRow): OrgSummary => ({ orgId: r.org_id, name: r.name, slug: r.slug, role: r.role });

export interface AccountApi {
  listUserOrgs(userId: string): Promise<OrgSummary[]>;
  createOrg(userId: string, name: string): Promise<OrgSummary>;
  acceptInvite(userId: string, email: string, token: string): Promise<{ orgId: string; role: OrgRole }>;
}

export function createAccountApi(pool: Pool): AccountApi {
  async function listUserOrgs(userId: string): Promise<OrgSummary[]> {
    const { rows } = await pool.query<OrgRow>('select * from app_list_user_orgs($1)', [userId]);
    return rows.map(toSummary);
  }
  return {
    listUserOrgs,
    async createOrg(userId, name) {
      const base = slugify(name);
      for (let attempt = 0; attempt < 4; attempt++) {
        const slug = attempt === 0 ? base : `${base}-${randomBytes(3).toString('hex')}`;
        try {
          const { rows } = await pool.query<{ id: string }>('select app_create_org($1, $2, $3) as id', [userId, name, slug]);
          const created = (await listUserOrgs(userId)).find((o) => o.orgId === rows[0]!.id);
          if (!created) throw new Error('org created but not visible to creator');
          return created;
        } catch (e) {
          if ((e as { code?: string }).code !== '23505') throw e; // only retry slug collisions
        }
      }
      throw new Error('could not allocate a unique org slug');
    },
    async acceptInvite(userId, email, token) {
      try {
        const { rows } = await pool.query<{ o_org_id: string; o_role: OrgRole }>(
          'select * from app_accept_invite($1, $2, $3)',
          [userId, email, hashInviteToken(token)],
        );
        return { orgId: rows[0]!.o_org_id, role: rows[0]!.o_role };
      } catch (e) {
        if ((e as Error).message === 'invite_invalid') throw new InviteInvalidError();
        throw e;
      }
    },
  };
}
```

Append `export * from './account';` to `packages/db/src/index.ts`.

- [ ] **Step 5: Run to verify pass, then commit**

Run: `pnpm turbo run test typecheck --filter=@erq/db`
Expected: PASS. (The isolation suite is unaffected: functions are not tables.)

```bash
git add -A && git commit -m "feat(db): add SECURITY DEFINER account functions and account API"
```

---

### Task 9: Seed script

**Files:**
- Create: `packages/db/src/seed.ts`, `packages/db/src/cli/migrate.ts`, `packages/db/src/cli/seed.ts`
- Modify: `packages/db/src/admin.ts` (export `seedDemoOrg` via `src/admin.ts` re-export)
- Test: `packages/db/test/seed.test.ts`

**Interfaces:**
- Consumes: schema tables from Tasks 6 and 7.
- Produces (`@erq/db/admin`): `seedDemoOrg(ownerUrl: string): Promise<void>`, constants `DEMO_ORG_ID`, `DEMO_USER_IDS = { owner, analyst, viewer }`.

- [ ] **Step 1: Write the failing test**

`packages/db/test/seed.test.ts`:

```ts
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { DEMO_ORG_ID, seedDemoOrg } from '../src/seed';
import { startTestDatabase, type TestDatabase } from '../src/testing';

let tdb: TestDatabase;
let owner: Pool;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
});
afterAll(async () => {
  await owner.end();
  await tdb.stop();
});

async function counts() {
  const { rows } = await owner.query(
    `select (select count(*) from orgs where id = $1)::int orgs,
            (select count(*) from org_members where org_id = $1)::int members,
            (select count(*) from store_connections where org_id = $1)::int conns,
            (select count(*) from skus where org_id = $1)::int skus,
            (select count(*) from sku_cost_components where org_id = $1)::int costs`,
    [DEMO_ORG_ID],
  );
  return rows[0];
}

it('creates a demo org with 3 members, 3 connections and 200 SKUs with costs', async () => {
  await seedDemoOrg(tdb.ownerUrl);
  const c = await counts();
  expect(c).toMatchObject({ orgs: 1, members: 3, conns: 3, skus: 200 });
  expect(c.costs).toBeGreaterThanOrEqual(600);
});

it('is idempotent', async () => {
  const before = await counts();
  await seedDemoOrg(tdb.ownerUrl);
  expect(await counts()).toEqual(before);
});

it('prices every SKU above its current landed cost, in integer cents', async () => {
  const { rows } = await owner.query(
    `select s.sku_code, s.selling_price_cents, sum(c.amount_cents)::int as landed
     from skus s join sku_cost_components c on c.sku_id = s.id and c.effective_to is null
     where s.org_id = $1 group by s.id`,
    [DEMO_ORG_ID],
  );
  expect(rows).toHaveLength(200);
  expect(rows.every((r) => Number.isInteger(r.selling_price_cents) && r.selling_price_cents > r.landed)).toBe(true);
});

it('includes SKUs whose product cost changed over time (time-versioned)', async () => {
  const { rows } = await owner.query(
    `select count(*)::int n from (
       select sku_id from sku_cost_components
       where org_id = $1 and component_type = 'product_cost' group by sku_id having count(*) > 1) t`,
    [DEMO_ORG_ID],
  );
  expect(rows[0].n).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm turbo run test --filter=@erq/db`
Expected: FAIL (cannot resolve `../src/seed`).

- [ ] **Step 3: Implement the seed**

`packages/db/src/seed.ts`:

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import * as s from './schema';

export const DEMO_ORG_ID = '00000000-0000-4000-8000-000000000001';
export const DEMO_USER_IDS = {
  owner: '00000000-0000-4000-8000-0000000000a1',
  analyst: '00000000-0000-4000-8000-0000000000a2',
  viewer: '00000000-0000-4000-8000-0000000000a3',
} as const;

// mulberry32: tiny deterministic PRNG so the demo data is identical on every run.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CATEGORIES = ['Apparel', 'Home', 'Beauty', 'Outdoor', 'Kitchen', 'Pets', 'Fitness', 'Toys'];
const VARIANTS = ['Small', 'Medium', 'Large', 'XL', 'One Size'];
const PRODUCT_COUNT = 40; // x 5 variants = 200 SKUs

export async function seedDemoOrg(ownerUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: ownerUrl, max: 1 });
  const db = drizzle(pool, { schema: s });
  const rand = rng(42);
  try {
    await db.transaction(async (tx) => {
      await tx.delete(s.orgs).where(eq(s.orgs.id, DEMO_ORG_ID)); // cascades to all demo tenant rows
      await tx.insert(s.orgs).values({ id: DEMO_ORG_ID, name: 'Demo Outfitters', slug: 'demo' });
      await tx.insert(s.orgMembers).values([
        { orgId: DEMO_ORG_ID, userId: DEMO_USER_IDS.owner, role: 'owner' },
        { orgId: DEMO_ORG_ID, userId: DEMO_USER_IDS.analyst, role: 'analyst' },
        { orgId: DEMO_ORG_ID, userId: DEMO_USER_IDS.viewer, role: 'viewer' },
      ]);
      await tx.insert(s.subscriptions).values({ orgId: DEMO_ORG_ID, plan: 'free' });
      await tx.insert(s.storeConnections).values([
        { orgId: DEMO_ORG_ID, platform: 'shopify', externalAccountId: 'demo-shopify', status: 'demo' },
        { orgId: DEMO_ORG_ID, platform: 'woocommerce', externalAccountId: 'demo-woo', status: 'demo' },
        { orgId: DEMO_ORG_ID, platform: 'amazon', externalAccountId: 'demo-amazon', status: 'demo' },
      ]);

      const productRows: (typeof s.products.$inferInsert)[] = [];
      const skuRows: (typeof s.skus.$inferInsert)[] = [];
      const costRows: (typeof s.skuCostComponents.$inferInsert)[] = [];
      for (let p = 0; p < PRODUCT_COUNT; p++) {
        const productId = `00000000-0000-4000-8001-${String(p).padStart(12, '0')}`;
        productRows.push({
          id: productId, orgId: DEMO_ORG_ID, title: `Demo Product ${p + 1}`,
          brand: 'Demo Co', category: CATEGORIES[p % CATEGORIES.length],
        });
        const baseCost = 400 + Math.floor(rand() * 5600);
        VARIANTS.forEach((variant, v) => {
          const skuId = `00000000-0000-4000-8002-${String(p * 5 + v).padStart(12, '0')}`;
          const productCost = baseCost + v * 25;
          const freight = Math.round(productCost * (0.05 + rand() * 0.1));
          const packaging = 50 + Math.floor(rand() * 200);
          const duties = rand() < 0.5 ? Math.round(productCost * (0.05 + rand() * 0.2)) : 0;
          const landed = productCost + freight + packaging + duties;
          const price = Math.round((landed * (1.5 + rand() * 0.6)) / 100) * 100 - 1;
          skuRows.push({
            id: skuId, orgId: DEMO_ORG_ID, productId, skuCode: `DEMO-${p + 1}-${v + 1}`,
            sellingPriceCents: Math.max(price, landed + 1),
          });
          const base = { orgId: DEMO_ORG_ID, skuId, perUnit: true };
          if (rand() < 0.3) {
            // Supplier price increase: older cost closed out, newer cost open-ended.
            costRows.push({ ...base, componentType: 'product_cost', amountCents: Math.round(productCost * 0.9), effectiveFrom: '2025-01-01', effectiveTo: '2025-07-01' });
            costRows.push({ ...base, componentType: 'product_cost', amountCents: productCost, effectiveFrom: '2025-07-01' });
          } else {
            costRows.push({ ...base, componentType: 'product_cost', amountCents: productCost, effectiveFrom: '2025-01-01' });
          }
          costRows.push({ ...base, componentType: 'inbound_freight', amountCents: freight, effectiveFrom: '2025-01-01' });
          costRows.push({ ...base, componentType: 'packaging', amountCents: packaging, effectiveFrom: '2025-01-01' });
          if (duties > 0) costRows.push({ ...base, componentType: 'duties_tariffs', amountCents: duties, effectiveFrom: '2025-01-01' });
        });
      }
      await tx.insert(s.products).values(productRows);
      await tx.insert(s.skus).values(skuRows);
      await tx.insert(s.skuCostComponents).values(costRows);
    });
  } finally {
    await pool.end();
  }
}
```

Note: each SKU has at least product_cost, freight and packaging, so the cost count is at least 600. The "above landed cost" assertion only sums rows with `effective_to is null`, which is the current cost.

`packages/db/src/cli/migrate.ts`:

```ts
import path from 'node:path';
import dotenv from 'dotenv';
import { runMigrations } from '../admin';

dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const ownerUrl = process.env.DATABASE_OWNER_URL;
const password = process.env.APP_USER_PASSWORD;
if (!ownerUrl || !password) throw new Error('DATABASE_OWNER_URL and APP_USER_PASSWORD are required');
runMigrations(ownerUrl, password).then(
  () => console.log('migrations applied'),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
```

`packages/db/src/cli/seed.ts` (same shape, calls `seedDemoOrg(ownerUrl)` and logs `demo org seeded`).

Append to `packages/db/src/admin.ts`: `export { seedDemoOrg, DEMO_ORG_ID, DEMO_USER_IDS } from './seed';`

- [ ] **Step 4: Run tests, then try the CLI**

Run: `pnpm turbo run test typecheck --filter=@erq/db`
Expected: PASS.

Then, with Docker running: `cp .env.example .env`, `docker compose up -d`, `pnpm db:migrate && pnpm db:seed`. Expected: "migrations applied" then "demo org seeded"; running both again also succeeds.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(db): add idempotent demo seed (200 SKUs with time-versioned costs)"
```

### Task 10: API bootstrap (config, errors, validation, DB wiring, health)

**Files:**
- Create: `apps/api/{package.json,tsconfig.json,nest-cli.json,vitest.config.ts}`
- Create: `apps/api/src/config/{env.ts,config.module.ts}`, `apps/api/src/common/{api-error.ts,api-exception.filter.ts,zod-validation.pipe.ts}`
- Create: `apps/api/src/db/db.module.ts`, `apps/api/src/health/health.controller.ts`, `apps/api/src/app.module.ts`, `apps/api/src/main.ts`
- Test: `apps/api/test/helpers/app.ts`, `apps/api/test/env.test.ts`, `apps/api/test/pipe.test.ts`, `apps/api/test/health.test.ts`

**Interfaces:**
- Produces: `loadEnv(raw: Record<string, string | undefined>): Env`; `class ApiError extends HttpException` (`new ApiError(status, code, message, details?)`); `class ZodValidationPipe`; tokens `APP_CONFIG`, `LOGGER`, `TENANT_DB`, `ACCOUNT_API`; `AppModule.register(env: Env): DynamicModule`; test helper `createTestApp()` (extended in Task 11).
- Consumes: `createTenantDb`, `createAccountApi`, `TenantDb`, `AccountApi` from `@erq/db`; `createLogger`, `ErrorResponse` from `@erq/shared`.

Dependency rationale (CLAUDE.md §15): `@nestjs/*` is the chosen backend; `@swc/core` + `unplugin-swc` are required because Vitest's esbuild does not emit decorator metadata that Nest DI needs; `zod-to-json-schema` renders our zod schemas into OpenAPI bodies; `supertest` drives HTTP tests; `jose` verifies JWTs (Task 11).

- [ ] **Step 1: Package setup**

`apps/api/package.json`:

```json
{
  "name": "@erq/api",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "nest build",
    "dev": "nest start --watch --builder swc",
    "start": "node dist/main.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

Install:

```bash
pnpm --filter @erq/api add @nestjs/common @nestjs/core @nestjs/platform-express @nestjs/swagger reflect-metadata rxjs express zod@^3 zod-to-json-schema drizzle-orm dotenv jose@^5 @erq/shared@workspace:* @erq/db@workspace:*
pnpm --filter @erq/api add -D @nestjs/cli @nestjs/testing @swc/core @swc/cli unplugin-swc vitest supertest @types/supertest @types/express typescript
```

`apps/api/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "experimentalDecorators": true, "emitDecoratorMetadata": true, "noEmit": true },
  "include": ["src", "test", "*.config.ts"]
}
```

`apps/api/nest-cli.json`:

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": { "builder": "swc", "typeCheck": true, "deleteOutDir": true }
}
```

Nest's build needs `noEmit` off: create `apps/api/tsconfig.build.json` with `{ "extends": "./tsconfig.json", "compilerOptions": { "noEmit": false }, "include": ["src"] }` and set `"tsConfigPath": "tsconfig.build.json"` inside `compilerOptions` in `nest-cli.json`.

`apps/api/vitest.config.ts`:

```ts
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 180_000, pool: 'forks' },
});
```

- [ ] **Step 2: Write the failing tests**

`apps/api/test/env.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  WEB_PUBLIC_URL: 'http://localhost:3000',
  SUPABASE_JWT_ISSUER: 'http://localhost:54321/auth/v1',
};

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv({ ...base, SUPABASE_JWT_SECRET: 's' });
    expect(env.API_PORT).toBe(4000);
    expect(env.LOG_LEVEL).toBe('info');
  });
  it('treats empty strings (from .env) as unset', () => {
    expect(() => loadEnv({ ...base, SUPABASE_JWT_SECRET: '', SUPABASE_JWKS_URL: '' })).toThrow(/SUPABASE_JWKS_URL or SUPABASE_JWT_SECRET/);
  });
  it('accepts a JWKS url instead of a secret', () => {
    expect(loadEnv({ ...base, SUPABASE_JWKS_URL: 'http://localhost:54321/jwks' }).SUPABASE_JWKS_URL).toBeDefined();
  });
  it('rejects a missing database url', () => {
    expect(() => loadEnv({ ...base, DATABASE_URL: undefined, SUPABASE_JWT_SECRET: 's' })).toThrow();
  });
});
```

`apps/api/test/pipe.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createOrgInput } from '@erq/shared';
import { ApiError } from '../src/common/api-error';
import { ZodValidationPipe } from '../src/common/zod-validation.pipe';

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(createOrgInput);
  it('returns parsed data', () => {
    expect(pipe.transform({ name: ' Acme ' })).toEqual({ name: 'Acme' });
  });
  it('throws a 400 ApiError with flattened details', () => {
    try {
      pipe.transform({ name: '' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).getStatus()).toBe(400);
      expect((e as ApiError).code).toBe('validation_failed');
    }
  });
  it('handles undefined bodies', () => {
    expect(() => pipe.transform(undefined)).toThrow(ApiError);
  });
});
```

`apps/api/test/helpers/app.ts`:

```ts
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { startTestDatabase, type TestDatabase } from '@erq/db/testing';
import { AppModule } from '../../src/app.module';
import { loadEnv } from '../../src/config/env';

export interface TestApp {
  app: INestApplication;
  tdb: TestDatabase;
  close(): Promise<void>;
}

export async function createTestApp(): Promise<TestApp> {
  const tdb = await startTestDatabase();
  const env = loadEnv({
    DATABASE_URL: tdb.appUrl,
    WEB_PUBLIC_URL: 'http://localhost:3000',
    SUPABASE_JWT_ISSUER: 'http://issuer.test/auth/v1',
    SUPABASE_JWT_SECRET: 'unused-in-tests',
    LOG_LEVEL: 'silent',
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(env)] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return { app, tdb, close: async () => { await app.close(); await tdb.stop(); } };
}
```

`apps/api/test/health.test.ts`:

```ts
import { afterAll, beforeAll, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './helpers/app';

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

it('GET /health returns ok when the database is reachable', async () => {
  const res = await request(t.app.getHttpServer()).get('/health');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: 'ok' });
});

it('unknown routes use the standard error shape', async () => {
  const res = await request(t.app.getHttpServer()).get('/nope');
  expect(res.status).toBe(404);
  expect(res.body).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm turbo run test --filter=@erq/api`
Expected: FAIL (modules do not exist).

- [ ] **Step 4: Implement**

`apps/api/src/config/env.ts`:

```ts
import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().url(),
    WEB_PUBLIC_URL: z.string().url(),
    SUPABASE_JWT_ISSUER: z.string().url(),
    SUPABASE_JWKS_URL: z.string().url().optional(),
    SUPABASE_JWT_SECRET: z.string().min(1).optional(),
    LOG_LEVEL: z.string().default('info'),
  })
  .refine((v) => v.SUPABASE_JWKS_URL || v.SUPABASE_JWT_SECRET, {
    message: 'Set SUPABASE_JWKS_URL or SUPABASE_JWT_SECRET',
  });

export type Env = z.infer<typeof schema>;

/** Empty strings (e.g. `FOO=` in .env) are treated as unset. */
export function loadEnv(raw: Record<string, string | undefined>): Env {
  const cleaned = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v !== ''));
  return schema.parse(cleaned);
}
```

`apps/api/src/config/config.module.ts`:

```ts
import { DynamicModule, Global, Module } from '@nestjs/common';
import { createLogger } from '@erq/shared';
import type { Env } from './env';

export const APP_CONFIG = Symbol('APP_CONFIG');
export const LOGGER = Symbol('LOGGER');

@Global()
@Module({})
export class ConfigModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: ConfigModule,
      providers: [
        { provide: APP_CONFIG, useValue: env },
        { provide: LOGGER, useValue: createLogger({ level: env.LOG_LEVEL }) },
      ],
      exports: [APP_CONFIG, LOGGER],
    };
  }
}
```

`apps/api/src/common/api-error.ts`:

```ts
import { HttpException } from '@nestjs/common';

export class ApiError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message, status);
  }
}
```

`apps/api/src/common/zod-validation.pipe.ts`:

```ts
import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { ApiError } from './api-error';

export class ZodValidationPipe<T extends z.ZodTypeAny> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ApiError(400, 'validation_failed', 'Request validation failed', result.error.flatten());
    }
    return result.data;
  }
}
```

`apps/api/src/common/api-exception.filter.ts`:

```ts
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import type { Response } from 'express';
import type { Logger } from 'pino';
import type { ErrorResponse } from '@erq/shared';
import { LOGGER } from '../config/config.module';
import { ApiError } from './api-error';

const STATUS_CODES: Record<number, string> = {
  400: 'bad_request', 401: 'unauthenticated', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 429: 'rate_limited',
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    let status = 500;
    let body: ErrorResponse = { error: { code: 'internal_error', message: 'Internal server error' } };

    if (exception instanceof ApiError) {
      status = exception.getStatus();
      body = { error: { code: exception.code, message: exception.message, details: exception.details } };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      body = { error: { code: STATUS_CODES[status] ?? 'error', message: exception.message } };
    } else {
      this.logger.error({ err: exception }, 'unhandled exception');
    }
    res.status(status).json(body);
  }
}
```

`apps/api/src/db/db.module.ts`:

```ts
import { DynamicModule, Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { createAccountApi, createTenantDb, type AccountApi, type TenantDb } from '@erq/db';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env';

export const TENANT_DB = Symbol('TENANT_DB');
export const ACCOUNT_API = Symbol('ACCOUNT_API');

@Injectable()
class DbLifecycle implements OnApplicationShutdown {
  constructor(@Inject(TENANT_DB) private readonly db: TenantDb) {}
  async onApplicationShutdown(): Promise<void> {
    await this.db.close();
  }
}

@Global()
@Module({})
export class DbModule {
  static forRoot(): DynamicModule {
    return {
      module: DbModule,
      providers: [
        { provide: TENANT_DB, inject: [APP_CONFIG], useFactory: (env: Env) => createTenantDb(env.DATABASE_URL) },
        { provide: ACCOUNT_API, inject: [TENANT_DB], useFactory: (db: TenantDb): AccountApi => createAccountApi(db.pool) },
        DbLifecycle,
      ],
      exports: [TENANT_DB, ACCOUNT_API],
    };
  }
}
```

`apps/api/src/health/health.controller.ts`:

```ts
import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { TenantDb } from '@erq/db';
import { ApiError } from '../common/api-error';
import { TENANT_DB } from '../db/db.module';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@Inject(TENANT_DB) private readonly db: TenantDb) {}

  @Get()
  async check(): Promise<{ status: 'ok' }> {
    try {
      await this.db.pool.query('select 1');
    } catch {
      throw new ApiError(503, 'db_unavailable', 'Database is unavailable');
    }
    return { status: 'ok' };
  }
}
```

`apps/api/src/app.module.ts`:

```ts
import { DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { ConfigModule } from './config/config.module';
import type { Env } from './config/env';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';

@Module({})
export class AppModule {
  static register(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(env), DbModule.forRoot()],
      controllers: [HealthController],
      providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
    };
  }
}
```

`apps/api/src/main.ts`:

```ts
import 'reflect-metadata';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import dotenv from 'dotenv';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

async function main(): Promise<void> {
  const env = loadEnv(process.env);
  const app = await NestFactory.create(AppModule.register(env));
  app.enableCors({ origin: env.WEB_PUBLIC_URL, allowedHeaders: ['authorization', 'content-type', 'x-org-id'] });
  app.enableShutdownHooks();
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('eRetailQuery API').setVersion('0.1').addBearerAuth().build(),
  );
  SwaggerModule.setup('docs', app, doc);
  await app.listen(env.API_PORT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 5: Run, then smoke the dev server**

Run: `pnpm turbo run test typecheck --filter=@erq/api`
Expected: PASS.

Then with `.env` filled (`SUPABASE_JWT_SECRET=dev-secret` is enough for now): `pnpm --filter @erq/api dev` and `curl localhost:4000/health` returns `{"status":"ok"}`; `http://localhost:4000/docs` renders Swagger.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(api): bootstrap NestJS with env validation, error filter, zod pipe, DB wiring, health"
```

---

### Task 11: API authentication, org context and role guards

**Files:**
- Create: `apps/api/src/auth/{jwt-verifier.ts,auth.module.ts,auth.guard.ts,org.guard.ts,roles.guard.ts,decorators.ts,request.ts}`
- Modify: `apps/api/src/app.module.ts`, `apps/api/test/helpers/app.ts`
- Test: `apps/api/test/auth.test.ts`

**Interfaces:**
- Consumes: `ApiError`, `TENANT_DB`, `Env`, `orgMembers`, `uuidSchema`, `hasRole`.
- Produces: `JWT_VERIFIER` token; `createJoseVerifier(opts: { key: JWTVerifyGetKey | Uint8Array | KeyLike; issuer: string; algorithms: string[] }): JwtVerifier`; `buildVerifierFromEnv(env)`; `interface JwtVerifier { verify(token): Promise<{ userId: string; email: string }> }`; guards `AuthGuard`, `OrgGuard`, `RolesGuard`; decorators `@Roles(min: OrgRole)`, `@CurrentUser()` (`{userId,email}`), `@CurrentOrg()` (`{orgId, role}`); `AuthedRequest`.
- Test helper additions: `createTestApp()` now also returns `signToken(opts?)` and `privateKey`.

- [ ] **Step 1: Extend the test helper (stub keypair)**

Replace `apps/api/test/helpers/app.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { startTestDatabase, type TestDatabase } from '@erq/db/testing';
import { generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { AppModule } from '../../src/app.module';
import { createJoseVerifier, JWT_VERIFIER } from '../../src/auth/jwt-verifier';
import { loadEnv } from '../../src/config/env';

export const ISSUER = 'http://issuer.test/auth/v1';

export interface TokenOptions {
  sub?: string;
  email?: string;
  iss?: string;
  aud?: string;
  expiresIn?: string;
  key?: KeyLike;
}

export interface TestApp {
  app: INestApplication;
  tdb: TestDatabase;
  signToken(opts?: TokenOptions): Promise<string>;
  close(): Promise<void>;
}

export async function createTestApp(): Promise<TestApp> {
  const tdb = await startTestDatabase();
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const env = loadEnv({
    DATABASE_URL: tdb.appUrl,
    WEB_PUBLIC_URL: 'http://localhost:3000',
    SUPABASE_JWT_ISSUER: ISSUER,
    SUPABASE_JWT_SECRET: 'unused-in-tests',
    LOG_LEVEL: 'silent',
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(env)] })
    .overrideProvider(JWT_VERIFIER)
    .useValue(createJoseVerifier({ key: publicKey, issuer: ISSUER, algorithms: ['ES256'] }))
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return {
    app,
    tdb,
    signToken: (o = {}) =>
      new SignJWT({ email: o.email ?? 'owner@example.com' })
        .setProtectedHeader({ alg: 'ES256' })
        .setSubject(o.sub ?? randomUUID())
        .setIssuer(o.iss ?? ISSUER)
        .setAudience(o.aud ?? 'authenticated')
        .setIssuedAt()
        .setExpirationTime(o.expiresIn ?? '1h')
        .sign(o.key ?? privateKey),
    close: async () => {
      await app.close();
      await tdb.stop();
    },
  };
}
```

- [ ] **Step 2: Write the failing tests**

`apps/api/test/auth.test.ts` uses a tiny probe controller registered only in tests so the guards are exercised before real endpoints exist:

```ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { generateKeyPair } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthGuard } from '../src/auth/auth.guard';
import { CurrentOrg, CurrentUser, Roles } from '../src/auth/decorators';
import { OrgGuard } from '../src/auth/org.guard';
import { RolesGuard } from '../src/auth/roles.guard';
import { createTestApp, type TestApp } from './helpers/app';
import { createJoseVerifier } from '../src/auth/jwt-verifier';

@Controller('probe')
class ProbeController {
  @Get('user') @UseGuards(AuthGuard)
  user(@CurrentUser() u: { userId: string }) { return u; }

  @Get('org') @UseGuards(AuthGuard, OrgGuard, RolesGuard)
  org(@CurrentOrg() o: { orgId: string; role: string }) { return o; }

  @Get('admin') @Roles('admin') @UseGuards(AuthGuard, OrgGuard, RolesGuard)
  admin() { return { ok: true }; }
}

let t: TestApp;
const U_OWNER = '00000000-0000-4000-8000-0000000000a1';
const U_VIEWER = '00000000-0000-4000-8000-0000000000a2';
const U_OUTSIDER = '00000000-0000-4000-8000-0000000000a3';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

beforeAll(async () => {
  t = await createTestApp({ extraControllers: [ProbeController] });
  const { Pool } = await import('pg');
  const owner = new Pool({ connectionString: t.tdb.ownerUrl });
  await owner.query(`insert into orgs (id,name,slug) values ($1,'A','a'),($2,'B','b')`, [ORG_A, ORG_B]);
  await owner.query(
    `insert into org_members (org_id,user_id,role) values ($1,$2,'owner'),($1,$3,'viewer'),($4,$5,'owner')`,
    [ORG_A, U_OWNER, U_VIEWER, ORG_B, U_OUTSIDER],
  );
  await owner.end();
});
afterAll(async () => { await t.close(); });

const get = (path: string) => request(t.app.getHttpServer()).get(path);

describe('authentication', () => {
  it('rejects a missing Authorization header', async () => {
    const res = await get('/probe/user');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });
  it.each(['Bearer', 'Bearer ', 'Basic abc', 'Bearer not.a.jwt', 'Bearer ' + 'a'.repeat(5000), 'bearer\u0000x'])(
    'rejects garbage header %j with 401, never 500',
    async (header) => {
      expect((await get('/probe/user').set('authorization', header)).status).toBe(401);
    },
  );
  it('rejects an expired token', async () => {
    const token = await t.signToken({ sub: U_OWNER, expiresIn: '-1h' });
    expect((await get('/probe/user').set('authorization', `Bearer ${token}`)).status).toBe(401);
  });
  it('rejects wrong issuer, wrong audience and a different signing key', async () => {
    const other = await generateKeyPair('ES256');
    for (const opts of [{ iss: 'http://evil/auth/v1' }, { aud: 'anon' }, { key: other.privateKey }]) {
      const token = await t.signToken({ sub: U_OWNER, ...opts });
      expect((await get('/probe/user').set('authorization', `Bearer ${token}`)).status).toBe(401);
    }
  });
  it('rejects a non-uuid sub instead of passing it to Postgres', async () => {
    const token = await t.signToken({ sub: "x'; drop table orgs;--" });
    expect((await get('/probe/user').set('authorization', `Bearer ${token}`)).status).toBe(401);
  });
  it('accepts a valid token', async () => {
    const token = await t.signToken({ sub: U_OWNER });
    const res = await get('/probe/user').set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(U_OWNER);
  });
});

describe('org context', () => {
  it('requires a valid X-Org-Id header', async () => {
    const token = await t.signToken({ sub: U_OWNER });
    const auth = { authorization: `Bearer ${token}` };
    expect((await get('/probe/org').set(auth)).status).toBe(400);
    expect((await get('/probe/org').set({ ...auth, 'x-org-id': 'not-a-uuid' })).status).toBe(400);
    expect((await get('/probe/org').set({ ...auth, 'x-org-id': "1' or '1'='1" })).status).toBe(400);
  });
  it('403s for orgs the user does not belong to', async () => {
    const token = await t.signToken({ sub: U_OWNER });
    const res = await get('/probe/org').set({ authorization: `Bearer ${token}`, 'x-org-id': ORG_B });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('not_a_member');
  });
  it('403s for a random but well-formed org id', async () => {
    const token = await t.signToken({ sub: U_OWNER });
    const res = await get('/probe/org').set({ authorization: `Bearer ${token}`, 'x-org-id': '99999999-9999-4999-8999-999999999999' });
    expect(res.status).toBe(403);
  });
  it('resolves the role for members', async () => {
    const token = await t.signToken({ sub: U_VIEWER });
    const res = await get('/probe/org').set({ authorization: `Bearer ${token}`, 'x-org-id': ORG_A });
    expect(res.body).toEqual({ orgId: ORG_A, role: 'viewer' });
  });
});

describe('roles', () => {
  it('blocks a viewer from an admin route and allows an owner', async () => {
    const viewer = await t.signToken({ sub: U_VIEWER });
    const owner = await t.signToken({ sub: U_OWNER });
    expect((await get('/probe/admin').set({ authorization: `Bearer ${viewer}`, 'x-org-id': ORG_A })).status).toBe(403);
    expect((await get('/probe/admin').set({ authorization: `Bearer ${owner}`, 'x-org-id': ORG_A })).status).toBe(200);
  });
});

describe('verifier factory', () => {
  it('rejects tokens when the key is a mismatched HS256 secret', async () => {
    const v = createJoseVerifier({ key: new TextEncoder().encode('secret'), issuer: 'x', algorithms: ['HS256'] });
    await expect(v.verify('a.b.c')).rejects.toThrow();
  });
});
```

`ProbeController` is registered through the `extraControllers` option added in Step 3.

- [ ] **Step 3: Allow tests to register extra controllers**

In `apps/api/src/app.module.ts` change the signature to `static register(env: Env, extras: { controllers?: Type<unknown>[] } = {})` and spread `...(extras.controllers ?? [])` into `controllers`. In `test/helpers/app.ts` change `createTestApp(opts: { extraControllers?: Type<unknown>[] } = {})` and pass `AppModule.register(env, { controllers: opts.extraControllers })`.

- [ ] **Step 4: Run to verify failure**

Run: `pnpm turbo run test --filter=@erq/api`
Expected: FAIL (auth modules do not exist).

- [ ] **Step 5: Implement auth**

`apps/api/src/auth/jwt-verifier.ts`:

```ts
// Supabase JWT docs: https://supabase.com/docs/guides/auth/jwts (verify key type for your project before launch)
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type KeyLike } from 'jose';
import { uuidSchema } from '@erq/shared';
import { ApiError } from '../common/api-error';
import type { Env } from '../config/env';

export const JWT_VERIFIER = Symbol('JWT_VERIFIER');

export interface VerifiedUser {
  userId: string;
  email: string;
}
export interface JwtVerifier {
  verify(token: string): Promise<VerifiedUser>;
}

export function createJoseVerifier(opts: {
  key: JWTVerifyGetKey | Uint8Array | KeyLike;
  issuer: string;
  algorithms: string[];
}): JwtVerifier {
  const options = { issuer: opts.issuer, audience: 'authenticated', algorithms: opts.algorithms };
  return {
    async verify(token) {
      try {
        const { payload } =
          typeof opts.key === 'function'
            ? await jwtVerify(token, opts.key, options)
            : await jwtVerify(token, opts.key, options);
        if (!uuidSchema.safeParse(payload.sub).success || typeof payload.email !== 'string') {
          throw new Error('missing or invalid claims');
        }
        return { userId: payload.sub as string, email: payload.email.toLowerCase() };
      } catch {
        throw new ApiError(401, 'unauthenticated', 'Invalid or expired token');
      }
    },
  };
}

export function buildVerifierFromEnv(env: Env): JwtVerifier {
  if (env.SUPABASE_JWKS_URL) {
    return createJoseVerifier({
      key: createRemoteJWKSet(new URL(env.SUPABASE_JWKS_URL)),
      issuer: env.SUPABASE_JWT_ISSUER,
      algorithms: ['ES256', 'RS256'],
    });
  }
  if (!env.SUPABASE_JWT_SECRET) throw new Error('SUPABASE_JWKS_URL or SUPABASE_JWT_SECRET is required');
  return createJoseVerifier({
    key: new TextEncoder().encode(env.SUPABASE_JWT_SECRET),
    issuer: env.SUPABASE_JWT_ISSUER,
    algorithms: ['HS256'],
  });
}
```

`apps/api/src/auth/request.ts`:

```ts
import type { Request } from 'express';
import type { OrgRole } from '@erq/shared';
import type { VerifiedUser } from './jwt-verifier';

export interface OrgContext {
  orgId: string;
  role: OrgRole;
}
export interface AuthedRequest extends Request {
  user?: VerifiedUser;
  org?: OrgContext;
}
```

`apps/api/src/auth/decorators.ts`:

```ts
import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { OrgRole } from '@erq/shared';
import { ApiError } from '../common/api-error';
import type { AuthedRequest } from './request';

export const ROLES_KEY = 'erq:min-role';
/** Minimum role required: `@Roles('admin')` allows admin and owner. */
export const Roles = (min: OrgRole) => SetMetadata(ROLES_KEY, min);

export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext) => {
  const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
  if (!user) throw new ApiError(401, 'unauthenticated', 'Authentication required');
  return user;
});

export const CurrentOrg = createParamDecorator((_d: unknown, ctx: ExecutionContext) => {
  const org = ctx.switchToHttp().getRequest<AuthedRequest>().org;
  if (!org) throw new ApiError(400, 'invalid_org', 'Organization context required');
  return org;
});
```

`apps/api/src/auth/auth.guard.ts`:

```ts
import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import { JWT_VERIFIER, type JwtVerifier } from './jwt-verifier';
import type { AuthedRequest } from './request';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(JWT_VERIFIER) private readonly verifier: JwtVerifier) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer ([A-Za-z0-9._~+/=-]{1,4096})$/.exec(header) : null;
    if (!match?.[1]) throw new ApiError(401, 'unauthenticated', 'Missing or malformed bearer token');
    req.user = await this.verifier.verify(match[1]);
    return true;
  }
}
```

`apps/api/src/auth/org.guard.ts`:

```ts
import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { orgMembers, type TenantDb } from '@erq/db';
import { uuidSchema } from '@erq/shared';
import { ApiError } from '../common/api-error';
import { TENANT_DB } from '../db/db.module';
import type { AuthedRequest } from './request';

@Injectable()
export class OrgGuard implements CanActivate {
  constructor(@Inject(TENANT_DB) private readonly db: TenantDb) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const user = req.user;
    if (!user) throw new ApiError(401, 'unauthenticated', 'Authentication required');

    const header = req.headers['x-org-id'];
    const orgId = (Array.isArray(header) ? header[0] : header)?.toLowerCase();
    if (!orgId || !uuidSchema.safeParse(orgId).success) {
      throw new ApiError(400, 'invalid_org', 'X-Org-Id header must be a valid organization id');
    }
    const param = req.params['orgId']?.toLowerCase();
    if (param && param !== orgId) throw new ApiError(400, 'org_mismatch', 'X-Org-Id does not match the URL');

    // RLS limits this query to the requested org, so a non-member simply gets no rows.
    const rows = await this.db.withTenant(orgId, (tx) =>
      tx.select({ role: orgMembers.role }).from(orgMembers).where(eq(orgMembers.userId, user.userId)),
    );
    const role = rows[0]?.role;
    if (!role) throw new ApiError(403, 'not_a_member', 'You are not a member of this organization');
    req.org = { orgId, role };
    return true;
  }
}
```

`apps/api/src/auth/roles.guard.ts`:

```ts
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hasRole, type OrgRole } from '@erq/shared';
import { ApiError } from '../common/api-error';
import { ROLES_KEY } from './decorators';
import type { AuthedRequest } from './request';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const min = this.reflector.getAllAndOverride<OrgRole | undefined>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!min) return true;
    const role = ctx.switchToHttp().getRequest<AuthedRequest>().org?.role;
    if (!role || !hasRole(role, min)) throw new ApiError(403, 'forbidden', `Requires ${min} role or higher`);
    return true;
  }
}
```

`apps/api/src/auth/auth.module.ts`:

```ts
import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env';
import { buildVerifierFromEnv, JWT_VERIFIER } from './jwt-verifier';

@Global()
@Module({
  providers: [{ provide: JWT_VERIFIER, inject: [APP_CONFIG], useFactory: (env: Env) => buildVerifierFromEnv(env) }],
  exports: [JWT_VERIFIER],
})
export class AuthModule {}
```

Add `AuthModule` to `imports` in `AppModule.register`.

- [ ] **Step 6: Run to verify pass, then commit**

Run: `pnpm turbo run test typecheck --filter=@erq/api`
Expected: PASS.

```bash
git add -A && git commit -m "feat(api): add Supabase JWT auth, org membership and role guards"
```

### Task 12: Org, member and invite endpoints

**Files:**
- Create: `apps/api/src/orgs/{orgs.service.ts,me.controller.ts,orgs.controller.ts,invites.controller.ts,orgs.module.ts}`
- Modify: `apps/api/src/app.module.ts` (import `OrgsModule`)
- Test: `apps/api/test/orgs.test.ts`

**Interfaces:**
- Consumes: `AuthGuard, OrgGuard, RolesGuard, Roles, CurrentUser, CurrentOrg`, `ZodValidationPipe`, `ACCOUNT_API`, `TENANT_DB`, `insertAudit`, `generateInviteToken`, `hashInviteToken`, `InviteInvalidError`, `createOrgInput`, `createInviteInput`.
- Produces (HTTP, all errors in the standard shape):
  - `GET /me` (auth) → `MeResponse`
  - `POST /orgs` (auth) body `{ name }` → 201 `OrgSummary`
  - `GET /orgs/:orgId/members` (org member) → `MemberDto[]`
  - `GET /orgs/:orgId/invites` (admin) → `InviteDto[]` (pending only, never includes tokens)
  - `POST /orgs/:orgId/invites` (admin) body `{ email, role }` → 201 `CreatedInviteDto` (includes `acceptUrl`)
  - `POST /invites/:token/accept` (auth) → `{ orgId, role }`; invalid, used, expired or wrong-email → 400 `invite_invalid`

- [ ] **Step 1: Write the failing tests**

`apps/api/test/orgs.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers/app';

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

const server = () => t.app.getHttpServer();
async function as(sub: string, email: string) {
  const token = await t.signToken({ sub, email });
  return { authorization: `Bearer ${token}` };
}

describe('POST /orgs and GET /me', () => {
  it('creates an org owned by the caller and lists it in /me', async () => {
    const user = randomUUID();
    const h = await as(user, 'owner@example.com');
    const created = await request(server()).post('/orgs').set(h).send({ name: 'Acme Goods' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Acme Goods', slug: 'acme-goods', role: 'owner' });
    const me = await request(server()).get('/me').set(h);
    expect(me.body.user).toEqual({ id: user, email: 'owner@example.com' });
    expect(me.body.orgs.map((o: { orgId: string }) => o.orgId)).toEqual([created.body.orgId]);
  });
  it('validates input with the standard error shape', async () => {
    const h = await as(randomUUID(), 'x@example.com');
    const res = await request(server()).post('/orgs').set(h).send({ name: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'validation_failed' });
    expect((await request(server()).post('/orgs').set(h)).status).toBe(400);
  });
  it('requires authentication', async () => {
    expect((await request(server()).get('/me')).status).toBe(401);
    expect((await request(server()).post('/orgs').send({ name: 'Nope Inc' })).status).toBe(401);
  });
});

describe('members and invites', () => {
  const ownerId = randomUUID();
  const guestId = randomUUID();
  let orgId: string;
  let owner: Record<string, string>;
  let guest: Record<string, string>;

  beforeAll(async () => {
    owner = await as(ownerId, 'owner@invite.test');
    guest = await as(guestId, 'guest@invite.test');
    orgId = (await request(server()).post('/orgs').set(owner).send({ name: 'Invite Test Co' })).body.orgId;
  });

  it('lists members for any member', async () => {
    const res = await request(server()).get(`/orgs/${orgId}/members`).set({ ...owner, 'x-org-id': orgId });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ userId: ownerId, role: 'owner', joinedAt: expect.any(String) }]);
  });
  it('requires the X-Org-Id header to match the URL', async () => {
    const res = await request(server()).get(`/orgs/${orgId}/members`).set({ ...owner, 'x-org-id': randomUUID() });
    expect([400, 403]).toContain(res.status);
  });

  it('full invite flow: create, list (no token), accept, then member', async () => {
    const created = await request(server())
      .post(`/orgs/${orgId}/invites`).set({ ...owner, 'x-org-id': orgId })
      .send({ email: 'Guest@Invite.test', role: 'viewer' });
    expect(created.status).toBe(201);
    expect(created.body.email).toBe('guest@invite.test');
    expect(created.body.acceptUrl).toMatch(/^http:\/\/localhost:3000\/invite\/[A-Za-z0-9_-]{20,}$/);
    const token = created.body.acceptUrl.split('/invite/')[1];

    const listed = await request(server()).get(`/orgs/${orgId}/invites`).set({ ...owner, 'x-org-id': orgId });
    expect(listed.body).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(token);

    const accepted = await request(server()).post(`/invites/${token}/accept`).set(guest);
    expect(accepted.status).toBe(201);
    expect(accepted.body).toEqual({ orgId, role: 'viewer' });

    const members = await request(server()).get(`/orgs/${orgId}/members`).set({ ...guest, 'x-org-id': orgId });
    expect(members.body.map((m: { userId: string }) => m.userId).sort()).toEqual([ownerId, guestId].sort());

    const again = await request(server()).post(`/invites/${token}/accept`).set(guest);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('invite_invalid');
    expect((await request(server()).get(`/orgs/${orgId}/invites`).set({ ...owner, 'x-org-id': orgId })).body).toEqual([]);
  });

  it('refuses acceptance by a different email', async () => {
    const created = await request(server())
      .post(`/orgs/${orgId}/invites`).set({ ...owner, 'x-org-id': orgId })
      .send({ email: 'someone@else.test', role: 'analyst' });
    const token = created.body.acceptUrl.split('/invite/')[1];
    const mallory = await as(randomUUID(), 'mallory@evil.test');
    const res = await request(server()).post(`/invites/${token}/accept`).set(mallory);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invite_invalid');
  });

  it('viewers cannot create or list invites', async () => {
    const h = { ...guest, 'x-org-id': orgId };
    expect((await request(server()).post(`/orgs/${orgId}/invites`).set(h).send({ email: 'a@b.co', role: 'viewer' })).status).toBe(403);
    expect((await request(server()).get(`/orgs/${orgId}/invites`).set(h)).status).toBe(403);
  });
  it('rejects inviting an owner and invalid emails', async () => {
    const h = { ...owner, 'x-org-id': orgId };
    expect((await request(server()).post(`/orgs/${orgId}/invites`).set(h).send({ email: 'a@b.co', role: 'owner' })).status).toBe(400);
    expect((await request(server()).post(`/orgs/${orgId}/invites`).set(h).send({ email: 'nope', role: 'viewer' })).status).toBe(400);
  });
  it('unknown tokens give invite_invalid, not a 500', async () => {
    const res = await request(server()).post('/invites/does-not-exist/accept').set(guest);
    expect(res.status).toBe(400);
  });
  it('writes audit entries for invite creation', async () => {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: t.tdb.ownerUrl });
    const { rows } = await pool.query(`select action from audit_log where org_id = $1 order by created_at`, [orgId]);
    await pool.end();
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['org.created', 'invite.created', 'invite.accepted']));
  });
});

describe('tenant isolation over HTTP', () => {
  it("a user cannot read another org's members even with a valid token", async () => {
    const aOwner = await as(randomUUID(), 'a@a.test');
    const bOwner = await as(randomUUID(), 'b@b.test');
    const orgA = (await request(server()).post('/orgs').set(aOwner).send({ name: 'Org A' })).body.orgId;
    await request(server()).post('/orgs').set(bOwner).send({ name: 'Org B' });
    const res = await request(server()).get(`/orgs/${orgA}/members`).set({ ...bOwner, 'x-org-id': orgA });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm turbo run test --filter=@erq/api`
Expected: FAIL (routes return 404).

- [ ] **Step 3: Implement**

`apps/api/src/orgs/orgs.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { asc, isNull } from 'drizzle-orm';
import {
  generateInviteToken, hashInviteToken, insertAudit, invites, orgMembers,
  type AccountApi, type TenantDb,
} from '@erq/db';
import type { CreatedInviteDto, CreateInviteInput, InviteDto, MeResponse, MemberDto, OrgSummary } from '@erq/shared';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env';
import { ACCOUNT_API, TENANT_DB } from '../db/db.module';
import type { VerifiedUser } from '../auth/jwt-verifier';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class OrgsService {
  constructor(
    @Inject(TENANT_DB) private readonly db: TenantDb,
    @Inject(ACCOUNT_API) private readonly account: AccountApi,
    @Inject(APP_CONFIG) private readonly env: Env,
  ) {}

  async me(user: VerifiedUser): Promise<MeResponse> {
    return { user: { id: user.userId, email: user.email }, orgs: await this.account.listUserOrgs(user.userId) };
  }

  createOrg(user: VerifiedUser, name: string): Promise<OrgSummary> {
    return this.account.createOrg(user.userId, name);
  }

  async listMembers(orgId: string): Promise<MemberDto[]> {
    const rows = await this.db.withTenant(orgId, (tx) =>
      tx.select({ userId: orgMembers.userId, role: orgMembers.role, joinedAt: orgMembers.createdAt })
        .from(orgMembers).orderBy(asc(orgMembers.createdAt)),
    );
    return rows.map((r) => ({ ...r, joinedAt: r.joinedAt.toISOString() }));
  }

  async listPendingInvites(orgId: string): Promise<InviteDto[]> {
    const rows = await this.db.withTenant(orgId, (tx) =>
      tx.select().from(invites).where(isNull(invites.acceptedAt)).orderBy(asc(invites.createdAt)),
    );
    return rows.map((r) => ({
      id: r.id, email: r.email, role: r.role as InviteDto['role'],
      expiresAt: r.expiresAt.toISOString(), acceptedAt: null,
    }));
  }

  async createInvite(orgId: string, actor: VerifiedUser, input: CreateInviteInput): Promise<CreatedInviteDto> {
    const token = generateInviteToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    const row = await this.db.withTenant(orgId, async (tx) => {
      const [inserted] = await tx.insert(invites).values({
        orgId, email: input.email, role: input.role, tokenHash: hashInviteToken(token),
        invitedBy: actor.userId, expiresAt,
      }).returning();
      await insertAudit(tx, {
        orgId, actorUserId: actor.userId, action: 'invite.created', entityType: 'invite',
        entityId: inserted!.id, after: { email: input.email, role: input.role },
      });
      return inserted!;
    });
    // No email provider in Phase 0: the inviter shares this link. The raw token is never stored or listed.
    return {
      id: row.id, email: row.email, role: input.role, expiresAt: expiresAt.toISOString(), acceptedAt: null,
      acceptUrl: `${this.env.WEB_PUBLIC_URL}/invite/${token}`,
    };
  }

  acceptInvite(user: VerifiedUser, token: string) {
    return this.account.acceptInvite(user.userId, user.email, token);
  }
}
```

`apps/api/src/orgs/me.controller.ts`:

```ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { VerifiedUser } from '../auth/jwt-verifier';
import { OrgsService } from './orgs.service';

@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
@UseGuards(AuthGuard)
export class MeController {
  constructor(private readonly orgs: OrgsService) {}

  @Get()
  me(@CurrentUser() user: VerifiedUser) {
    return this.orgs.me(user);
  }
}
```

`apps/api/src/orgs/orgs.controller.ts`:

```ts
import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { createInviteInput, createOrgInput, type CreateInviteInput, type CreateOrgInput } from '@erq/shared';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentOrg, CurrentUser, Roles } from '../auth/decorators';
import type { VerifiedUser } from '../auth/jwt-verifier';
import { OrgGuard } from '../auth/org.guard';
import type { OrgContext } from '../auth/request';
import { RolesGuard } from '../auth/roles.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { OrgsService } from './orgs.service';

// zod-to-json-schema returns a plain JSON schema object; Swagger accepts it as-is.
const bodyOf = (schema: Parameters<typeof zodToJsonSchema>[0]) => ({ schema: zodToJsonSchema(schema) as Record<string, unknown> });

@ApiTags('orgs')
@ApiBearerAuth()
@Controller()
export class OrgsController {
  constructor(private readonly orgs: OrgsService) {}

  @Post('orgs')
  @UseGuards(AuthGuard)
  @ApiBody(bodyOf(createOrgInput))
  create(@CurrentUser() user: VerifiedUser, @Body(new ZodValidationPipe(createOrgInput)) body: CreateOrgInput) {
    return this.orgs.createOrg(user, body.name);
  }

  @Get('orgs/:orgId/members')
  @UseGuards(AuthGuard, OrgGuard, RolesGuard)
  members(@CurrentOrg() org: OrgContext) {
    return this.orgs.listMembers(org.orgId);
  }

  @Get('orgs/:orgId/invites')
  @Roles('admin')
  @UseGuards(AuthGuard, OrgGuard, RolesGuard)
  listInvites(@CurrentOrg() org: OrgContext) {
    return this.orgs.listPendingInvites(org.orgId);
  }

  @Post('orgs/:orgId/invites')
  @Roles('admin')
  @UseGuards(AuthGuard, OrgGuard, RolesGuard)
  @ApiBody(bodyOf(createInviteInput))
  invite(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: VerifiedUser,
    @Body(new ZodValidationPipe(createInviteInput)) body: CreateInviteInput,
  ) {
    return this.orgs.createInvite(org.orgId, user, body);
  }
}
```

`apps/api/src/orgs/invites.controller.ts`:

```ts
import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InviteInvalidError } from '@erq/db';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { VerifiedUser } from '../auth/jwt-verifier';
import { ApiError } from '../common/api-error';
import { OrgsService } from './orgs.service';

@ApiTags('invites')
@ApiBearerAuth()
@Controller('invites')
@UseGuards(AuthGuard)
export class InvitesController {
  constructor(private readonly orgs: OrgsService) {}

  @Post(':token/accept')
  async accept(@CurrentUser() user: VerifiedUser, @Param('token') token: string) {
    try {
      return await this.orgs.acceptInvite(user, token);
    } catch (e) {
      if (e instanceof InviteInvalidError) {
        throw new ApiError(400, 'invite_invalid', 'This invite is invalid, expired, or was sent to a different email');
      }
      throw e;
    }
  }
}
```

`apps/api/src/orgs/orgs.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { InvitesController } from './invites.controller';
import { MeController } from './me.controller';
import { OrgsController } from './orgs.controller';
import { OrgsService } from './orgs.service';

@Module({ controllers: [MeController, OrgsController, InvitesController], providers: [OrgsService] })
export class OrgsModule {}
```

Add `OrgsModule` to `imports` in `AppModule.register`.

- [ ] **Step 4: Run, lint, commit**

Run: `pnpm turbo run test typecheck --filter=@erq/api && pnpm lint`
Expected: PASS.

```bash
git add -A && git commit -m "feat(api): add org, member and invite endpoints with audit logging"
```

---

### Task 13: Worker bootstrap with tenant-scoped jobs

**Files:**
- Create: `apps/worker/{package.json,tsconfig.json,vitest.config.ts}`
- Create: `apps/worker/src/{system-worker.ts,tenant-job.ts,main.ts}`
- Test: `apps/worker/test/tenant-job.test.ts`, `apps/worker/test/system-worker.test.ts`

**Interfaces:**
- Consumes: `TenantDb`, `Tx`, `createTenantDb` from `@erq/db`; `uuidSchema`, `createLogger` from `@erq/shared`.
- Produces: `SYSTEM_QUEUE = 'system'`; `processSystemJob(job): Promise<{ ok: true; at: string }>`; `createSystemWorker(connection): Worker`; `tenantJob<D extends { orgId: string }, R>(db: Pick<TenantDb,'withTenant'>, handler: (job: Job<D>, tx: Tx) => Promise<R>): (job: Job<D>) => Promise<R>`. Every future tenant job uses `tenantJob`, so the org context is always set.

- [ ] **Step 1: Package setup**

`apps/worker/package.json`:

```json
{
  "name": "@erq/worker",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "dev": "tsx watch src/main.ts",
    "start": "node dist/main.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

```bash
pnpm --filter @erq/worker add bullmq ioredis dotenv @erq/shared@workspace:* @erq/db@workspace:*
pnpm --filter @erq/worker add -D tsx vitest typescript @types/node
```

`tsconfig.json`: extends base, `{ "compilerOptions": { "noEmit": true }, "include": ["src", "test", "*.config.ts"] }`. `tsconfig.build.json`: extends `./tsconfig.json` with `{ "compilerOptions": { "noEmit": false, "outDir": "dist" }, "include": ["src"] }`. `vitest.config.ts` same as the db package.

- [ ] **Step 2: Write the failing tests**

`apps/worker/test/tenant-job.test.ts`:

```ts
import { UnrecoverableError, type Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { Tx } from '@erq/db';
import { tenantJob } from '../src/tenant-job';

const ORG = '11111111-1111-4111-8111-111111111111';
const fakeDb = () => ({
  withTenant: vi.fn(async (_org: string, fn: (tx: Tx) => Promise<unknown>) => fn({} as Tx)),
});
const job = (data: unknown) => ({ data }) as Job<{ orgId: string }>;

describe('tenantJob', () => {
  it('runs the handler inside withTenant for the job org', async () => {
    const db = fakeDb();
    const handler = vi.fn(async () => 'done');
    const result = await tenantJob(db, handler)(job({ orgId: ORG }));
    expect(result).toBe('done');
    expect(db.withTenant).toHaveBeenCalledWith(ORG, expect.any(Function));
  });
  it.each([{}, { orgId: 'nope' }, { orgId: null }, undefined])(
    'fails permanently (no retries) when orgId is missing or invalid: %j',
    async (data) => {
      const db = fakeDb();
      const handler = vi.fn();
      await expect(tenantJob(db, handler)(job(data))).rejects.toBeInstanceOf(UnrecoverableError);
      expect(db.withTenant).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    },
  );
  it('propagates handler errors so BullMQ can retry', async () => {
    const db = fakeDb();
    await expect(tenantJob(db, async () => { throw new Error('boom'); })(job({ orgId: ORG }))).rejects.toThrow('boom');
  });
});
```

`apps/worker/test/system-worker.test.ts`:

```ts
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createSystemWorker, SYSTEM_QUEUE } from '../src/system-worker';

let redis: StartedTestContainer;
let connection: IORedis;

beforeAll(async () => {
  redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  connection = new IORedis({ host: redis.getHost(), port: redis.getMappedPort(6379), maxRetriesPerRequest: null });
});
afterAll(async () => {
  await connection.quit();
  await redis.stop();
});

it('processes a health job end to end', async () => {
  const worker = createSystemWorker(connection);
  const queue = new Queue(SYSTEM_QUEUE, { connection });
  const events = new QueueEvents(SYSTEM_QUEUE, { connection });
  try {
    const job = await queue.add('health', {});
    const result = await job.waitUntilFinished(events, 10_000);
    expect(result).toMatchObject({ ok: true });
  } finally {
    await worker.close();
    await queue.close();
    await events.close();
  }
});

it('fails unknown job names', async () => {
  const worker = createSystemWorker(connection);
  const queue = new Queue(SYSTEM_QUEUE, { connection });
  const events = new QueueEvents(SYSTEM_QUEUE, { connection });
  try {
    const job = await queue.add('mystery', {}, { attempts: 1 });
    await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow(/unknown job/);
  } finally {
    await worker.close();
    await queue.close();
    await events.close();
  }
});
```

Add `testcontainers` as a dev dependency of the worker: `pnpm --filter @erq/worker add -D testcontainers`.

- [ ] **Step 3: Run to verify failure**

Run: `pnpm turbo run test --filter=@erq/worker`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement**

`apps/worker/src/tenant-job.ts`:

```ts
import { UnrecoverableError, type Job } from 'bullmq';
import type { TenantDb, Tx } from '@erq/db';
import { uuidSchema } from '@erq/shared';

/**
 * Wraps a job handler so it always runs inside withTenant(job.data.orgId).
 * A job without a valid orgId can never succeed, so it fails without retries.
 */
export function tenantJob<D extends { orgId: string }, R>(
  db: Pick<TenantDb, 'withTenant'>,
  handler: (job: Job<D>, tx: Tx) => Promise<R>,
): (job: Job<D>) => Promise<R> {
  return async (job) => {
    const orgId: unknown = job.data?.orgId;
    if (!uuidSchema.safeParse(orgId).success) {
      throw new UnrecoverableError('job is missing a valid orgId');
    }
    return db.withTenant(orgId as string, (tx) => handler(job, tx));
  };
}
```

`apps/worker/src/system-worker.ts`:

```ts
import { Worker, type ConnectionOptions, type Job } from 'bullmq';

export const SYSTEM_QUEUE = 'system';

export async function processSystemJob(job: Job): Promise<{ ok: true; at: string }> {
  if (job.name !== 'health') throw new Error(`unknown job: ${job.name}`);
  return { ok: true, at: new Date().toISOString() };
}

export function createSystemWorker(connection: ConnectionOptions): Worker {
  return new Worker(SYSTEM_QUEUE, processSystemJob, { connection });
}
```

`apps/worker/src/main.ts`:

```ts
import path from 'node:path';
import { Queue } from 'bullmq';
import dotenv from 'dotenv';
import IORedis from 'ioredis';
import { createLogger } from '@erq/shared';
import { createSystemWorker, SYSTEM_QUEUE } from './system-worker';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

async function main(): Promise<void> {
  const log = createLogger({ level: process.env.LOG_LEVEL ?? 'info' });
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is required');
  const connection = new IORedis(url, { maxRetriesPerRequest: null });

  const worker = createSystemWorker(connection);
  worker.on('completed', (job) => log.info({ job: job.name }, 'job completed'));
  worker.on('failed', (job, err) => log.error({ job: job?.name, err }, 'job failed'));

  // Repeatable health heartbeat. BullMQ job schedulers: https://docs.bullmq.io/guide/job-schedulers
  const queue = new Queue(SYSTEM_QUEUE, { connection });
  await queue.upsertJobScheduler('health-every-minute', { every: 60_000 }, { name: 'health' });

  const shutdown = async () => {
    await worker.close();
    await queue.close();
    await connection.quit();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  log.info('worker started');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 5: Run, then commit**

Run: `pnpm turbo run test typecheck --filter=@erq/worker`
Expected: PASS. If `upsertJobScheduler` does not exist in the installed BullMQ version, check the linked docs and use the version's equivalent repeatable-job API.

```bash
git add -A && git commit -m "feat(worker): bootstrap BullMQ worker with tenant-scoped job wrapper and health job"
```

### Task 14: `@erq/ui` primitives and Next.js app scaffold

**Files:**
- Create: `packages/ui/{package.json,tsconfig.json,tsup.config.ts}`, `packages/ui/src/{cn.ts,button.tsx,input.tsx,label.tsx,card.tsx,skeleton.tsx,theme.css,index.ts}`
- Create: `apps/web/{package.json,tsconfig.json,next.config.ts,postcss.config.mjs,vitest.config.ts,next-env.d.ts}`, `apps/web/src/app/{layout.tsx,globals.css,page.tsx}`
- Test: `packages/ui/test/button.test.tsx`

**Interfaces:**
- Produces (`@erq/ui`): `cn(...classes)`, `Button` (`variant: 'default'|'outline'|'ghost'`, `size: 'default'|'sm'`), `Input`, `Label`, `Card, CardHeader, CardTitle, CardDescription, CardContent`, `Skeleton`; CSS tokens via `@erq/ui/theme.css`.

Dependency rationale: `class-variance-authority`, `clsx`, `tailwind-merge` are the shadcn/ui primitives (CLAUDE.md names shadcn/ui); components are written by hand in shadcn style instead of using the CLI so the setup is reproducible in a monorepo.

- [ ] **Step 1: Write the failing test**

`packages/ui/test/button.test.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button, cn } from '../src';

describe('cn', () => {
  it('merges conflicting tailwind classes, last wins', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });
});

describe('Button', () => {
  it('renders a real button with its label and variant classes', () => {
    const html = renderToStaticMarkup(<Button variant="outline">Save</Button>);
    expect(html).toContain('<button');
    expect(html).toContain('Save');
    expect(html).toContain('border');
  });
  it('forwards disabled and type', () => {
    const html = renderToStaticMarkup(<Button disabled type="submit">Go</Button>);
    expect(html).toContain('disabled');
    expect(html).toContain('type="submit"');
  });
});
```

- [ ] **Step 2: Package files and install**

`packages/ui/package.json`:

```json
{
  "name": "@erq/ui",
  "version": "0.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./theme.css": "./src/theme.css"
  },
  "files": ["dist", "src/theme.css"],
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

`tsup.config.ts`: `entry: ['src/index.ts'], format: ['cjs'], dts: true, clean: true, external: ['react', 'react-dom']`. `tsconfig.json` extends base with `"jsx": "react-jsx"`, `"lib": ["ES2023", "DOM"]`, `include: ["src", "test", "*.config.ts"]`. `vitest.config.ts` includes `test/**/*.test.tsx`.

```bash
pnpm --filter @erq/ui add class-variance-authority clsx tailwind-merge
pnpm --filter @erq/ui add -D react react-dom @types/react @types/react-dom tsup vitest typescript
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @erq/ui test`
Expected: FAIL (cannot resolve `../src`).

- [ ] **Step 4: Implement the primitives**

`packages/ui/src/cn.ts`:

```ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
```

`packages/ui/src/button.tsx`:

```tsx
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from './cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--color-ring] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-[--color-primary] text-[--color-primary-foreground] hover:opacity-90',
        outline: 'border border-[--color-border] bg-transparent hover:bg-[--color-muted]',
        ghost: 'hover:bg-[--color-muted]',
      },
      size: { default: 'h-10 px-4', sm: 'h-8 px-3' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
```

`packages/ui/src/input.tsx`:

```tsx
import type { InputHTMLAttributes } from 'react';
import { cn } from './cn';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-10 w-full rounded-md border border-[--color-border] bg-[--color-background] px-3 text-sm placeholder:text-[--color-muted-foreground] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--color-ring] disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
```

`packages/ui/src/label.tsx`:

```tsx
import type { LabelHTMLAttributes } from 'react';
import { cn } from './cn';

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-sm font-medium', className)} {...props} />;
}
```

`packages/ui/src/card.tsx`:

```tsx
import type { HTMLAttributes } from 'react';
import { cn } from './cn';

type DivProps = HTMLAttributes<HTMLDivElement>;
export const Card = ({ className, ...p }: DivProps) => (
  <div className={cn('rounded-lg border border-[--color-border] bg-[--color-background] shadow-sm', className)} {...p} />
);
export const CardHeader = ({ className, ...p }: DivProps) => <div className={cn('flex flex-col gap-1.5 p-6', className)} {...p} />;
export const CardTitle = ({ className, ...p }: HTMLAttributes<HTMLHeadingElement>) => (
  <h2 className={cn('text-lg font-semibold leading-none', className)} {...p} />
);
export const CardDescription = ({ className, ...p }: HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn('text-sm text-[--color-muted-foreground]', className)} {...p} />
);
export const CardContent = ({ className, ...p }: DivProps) => <div className={cn('p-6 pt-0', className)} {...p} />;
```

`packages/ui/src/skeleton.tsx`:

```tsx
import type { HTMLAttributes } from 'react';
import { cn } from './cn';

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-[--color-muted]', className)} {...props} />;
}
```

`packages/ui/src/theme.css` (Tailwind v4 theme tokens; AA-contrast values):

```css
@theme {
  --color-background: #ffffff;
  --color-foreground: #0f172a;
  --color-muted: #f1f5f9;
  --color-muted-foreground: #475569;
  --color-border: #cbd5e1;
  --color-primary: #1d4ed8;
  --color-primary-foreground: #ffffff;
  --color-destructive: #b91c1c;
  --color-ring: #2563eb;
}

@media (prefers-color-scheme: dark) {
  :root {
    --color-background: #0b1220;
    --color-foreground: #e2e8f0;
    --color-muted: #1e293b;
    --color-muted-foreground: #94a3b8;
    --color-border: #334155;
    --color-primary: #3b82f6;
    --color-primary-foreground: #0b1220;
  }
}
```

`packages/ui/src/index.ts` exports `./cn`, `./button`, `./input`, `./label`, `./card`, `./skeleton`.

Run: `pnpm turbo run test typecheck build --filter=@erq/ui` → PASS.

- [ ] **Step 5: Scaffold `apps/web`**

`apps/web/package.json`:

```json
{
  "name": "@erq/web",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "next build",
    "dev": "next dev -p 3000",
    "start": "next start -p 3000",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:e2e": "playwright test"
  }
}
```

```bash
pnpm --filter @erq/web add next@15 react react-dom @supabase/ssr @supabase/supabase-js server-only @erq/ui@workspace:* @erq/shared@workspace:* zod@^3
pnpm --filter @erq/web add -D tailwindcss @tailwindcss/postcss postcss typescript @types/react @types/react-dom @types/node vitest @playwright/test
```

`apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "preserve",
    "noEmit": true,
    "allowJs": false,
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "src", "e2e", "*.config.ts", ".next/types/**/*.ts"]
}
```

`apps/web/next.config.ts` (loads the repo-root `.env` so one file configures everything):

```ts
import path from 'node:path';
import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';

loadEnvConfig(path.resolve(process.cwd(), '../..'));

const config: NextConfig = {
  eslint: { ignoreDuringBuilds: true }, // linting runs from the repo root
};
export default config;
```

`apps/web/postcss.config.mjs`: `export default { plugins: { '@tailwindcss/postcss': {} } };`

`apps/web/src/app/globals.css`:

```css
@import 'tailwindcss';
@import '@erq/ui/theme.css';
@source '../../../../packages/ui/src';

body {
  background: var(--color-background);
  color: var(--color-foreground);
}
```

`apps/web/src/app/layout.tsx`:

```tsx
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = { title: 'eRetailQuery', description: 'Know what is actually making you money.' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
```

`apps/web/src/app/page.tsx`:

```tsx
import { redirect } from 'next/navigation';

export default function Home() {
  redirect('/dashboard');
}
```

`apps/web/vitest.config.ts`: `include: ['src/**/*.test.ts']`.

- [ ] **Step 6: Verify and commit**

Run: `pnpm turbo run build typecheck --filter=@erq/web`
Expected: build succeeds (the home route only redirects).

```bash
git add -A && git commit -m "feat(ui,web): add UI primitives and Next.js app scaffold with Tailwind v4"
```

---

### Task 15: Web authentication (Supabase sessions, login, signup, safe redirects)

**Files:**
- Create: `apps/web/src/lib/{safe-next.ts,safe-next.test.ts}`, `apps/web/src/lib/supabase/{config.ts,client.ts,server.ts}`
- Create: `apps/web/src/middleware.ts`
- Create: `apps/web/src/components/auth-form.tsx`, `apps/web/src/app/(auth)/{login,signup}/page.tsx`, `apps/web/src/app/auth/callback/route.ts`

**Interfaces:**
- Produces: `safeNextPath(next: string | null | undefined, fallback = '/dashboard'): string`; `supabaseConfig(): { url: string; key: string }`; `createSupabaseBrowserClient()`; `createSupabaseServerClient()` (async); middleware that refreshes the session and redirects unauthenticated users to `/login?next=...`; `AuthForm({ mode, next })`.

- [ ] **Step 1: Write the failing test for the redirect guard (Review Focus 5)**

`apps/web/src/lib/safe-next.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { safeNextPath } from './safe-next';

describe('safeNextPath', () => {
  it.each([
    ['/dashboard', '/dashboard'],
    ['/invite/abc_DEF-123', '/invite/abc_DEF-123'],
    ['/team?tab=members', '/team?tab=members'],
  ])('keeps same-site path %j', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });

  it.each([
    '//evil.com', '///evil.com', 'https://evil.com', 'http://evil.com/x', 'javascript:alert(1)',
    '/\\evil.com', '\\\\evil.com', '/\t/evil.com', '/\n/evil.com', '/\r/evil.com', 'evil.com', ' //evil.com', '',
  ])('falls back for %j', (input) => {
    expect(safeNextPath(input)).toBe('/dashboard');
  });

  it('falls back for null and undefined, and honours a custom fallback', () => {
    expect(safeNextPath(null)).toBe('/dashboard');
    expect(safeNextPath(undefined, '/home')).toBe('/home');
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement**

Run: `pnpm --filter @erq/web test` → FAIL (module missing).

`apps/web/src/lib/safe-next.ts`:

```ts
const BASE = 'http://local.invalid';

/** Returns a same-site path for post-login redirects, or the fallback. Never returns an off-site URL. */
export function safeNextPath(next: string | null | undefined, fallback = '/dashboard'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return fallback;
  try {
    // The URL parser strips tabs/newlines, so "/\t/evil.com" would become "//evil.com"; the origin check catches that.
    const url = new URL(next, BASE);
    if (url.origin !== BASE) return fallback;
    return url.pathname + url.search;
  } catch {
    return fallback;
  }
}
```

Run: `pnpm --filter @erq/web test` → PASS.

- [ ] **Step 3: Supabase clients and middleware**

`apps/web/src/lib/supabase/config.ts`:

```ts
// NEXT_PUBLIC_* must be accessed with literal names so Next can inline them into the browser bundle.
export function supabaseConfig(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set');
  return { url, key };
}
```

`apps/web/src/lib/supabase/client.ts`:

```ts
import { createBrowserClient } from '@supabase/ssr';
import { supabaseConfig } from './config';

export function createSupabaseBrowserClient() {
  const { url, key } = supabaseConfig();
  return createBrowserClient(url, key);
}
```

`apps/web/src/lib/supabase/server.ts`:

```ts
import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { supabaseConfig } from './config';

export async function createSupabaseServerClient() {
  const store = await cookies();
  const { url, key } = supabaseConfig();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          list.forEach(({ name, value, options }) => store.set(name, value, options));
        } catch {
          // Called from a Server Component: the middleware refreshes the session instead.
        }
      },
    },
  });
}
```

`apps/web/src/middleware.ts`:

```ts
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { supabaseConfig } from './lib/supabase/config';

const PUBLIC_PATHS = ['/login', '/signup', '/auth'];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });
  const { url, key } = supabaseConfig();
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        list.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  // getUser() validates the token with Supabase; getSession() alone would trust the cookie.
  const { data: { user } } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
  if (!user && !isPublic) {
    const login = request.nextUrl.clone();
    login.pathname = '/login';
    login.search = '';
    login.searchParams.set('next', path + request.nextUrl.search);
    return NextResponse.redirect(login);
  }
  if (user && (path === '/login' || path === '/signup')) {
    const home = request.nextUrl.clone();
    home.pathname = '/dashboard';
    home.search = '';
    return NextResponse.redirect(home);
  }
  return response;
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
```

- [ ] **Step 4: Auth form, pages and callback**

`apps/web/src/components/auth-form.tsx`:

```tsx
'use client';

import { Button, Input, Label } from '@erq/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

export function AuthForm({ mode, next }: { mode: 'login' | 'signup'; next: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const isLogin = mode === 'login';

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');
    const supabase = createSupabaseBrowserClient();
    const redirectTo = `${location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
    const result = isLogin
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } });
    setPending(false);
    if (result.error) return setError(result.error.message);
    if (!isLogin && !result.data.session) return setNotice('Check your email to confirm your account.');
    router.push(next);
    router.refresh();
  }

  async function google() {
    const supabase = createSupabaseBrowserClient();
    const redirectTo = `${location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
    const { error: e } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
    if (e) setError(e.message);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">Password</Label>
        <Input id="password" name="password" type="password" minLength={8} required
          autoComplete={isLogin ? 'current-password' : 'new-password'} />
      </div>
      {error && <p role="alert" className="text-sm text-[--color-destructive]">{error}</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      <Button type="submit" disabled={pending}>{isLogin ? 'Sign in' : 'Create account'}</Button>
      <Button type="button" variant="outline" onClick={google}>Continue with Google</Button>
      <p className="text-sm text-[--color-muted-foreground]">
        {isLogin ? 'New here? ' : 'Already have an account? '}
        <Link className="underline" href={`${isLogin ? '/signup' : '/login'}?next=${encodeURIComponent(next)}`}>
          {isLogin ? 'Create an account' : 'Sign in'}
        </Link>
      </p>
    </form>
  );
}
```

`apps/web/src/app/(auth)/login/page.tsx` (and `signup/page.tsx` identical with `mode="signup"`, title "Create your account"):

```tsx
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@erq/ui';
import { AuthForm } from '@/components/auth-form';
import { safeNextPath } from '@/lib/safe-next';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNextPath((await searchParams).next);
  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Sign in to eRetailQuery</CardTitle>
          <CardDescription>See what is actually making you money.</CardDescription>
        </CardHeader>
        <CardContent>
          <AuthForm mode="login" next={next} />
        </CardContent>
      </Card>
    </main>
  );
}
```

`apps/web/src/app/auth/callback/route.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { safeNextPath } from '@/lib/safe-next';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const next = safeNextPath(searchParams.get('next'));
  const code = searchParams.get('code');
  if (code) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  }
  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
}
```

- [ ] **Step 5: Verify and commit**

Run: `pnpm turbo run typecheck build test --filter=@erq/web`
Expected: PASS.

```bash
git add -A && git commit -m "feat(web): add Supabase auth pages, session middleware and safe redirect guard"
```

### Task 16: Web app shell (onboarding, org switcher, dashboard shell, team and invites)

**Files:**
- Create: `apps/web/src/lib/{api.ts,app-context.ts}`
- Create: `apps/web/src/app/onboarding/{page.tsx,actions.ts}`
- Create: `apps/web/src/app/(app)/{layout.tsx,actions.ts}`, `apps/web/src/app/(app)/dashboard/{page.tsx,loading.tsx}`, `apps/web/src/app/(app)/team/{page.tsx,loading.tsx,actions.ts}`
- Create: `apps/web/src/components/{org-switcher.tsx,invite-form.tsx}`
- Create: `apps/web/src/app/invite/[token]/{page.tsx,actions.ts}`
- Test: covered by the Playwright test in Task 17 (these are thin UI over the tested API) plus `pnpm typecheck` and `pnpm build`.

**Interfaces:**
- Consumes: API endpoints from Task 12; `MeResponse`, `OrgSummary`, `MemberDto`, `CreatedInviteDto`, `createOrgInput`, `createInviteInput`, `hasRole` from `@erq/shared`.
- Produces: `apiFetch<T>(path, init?: RequestInit & { orgId?: string }): Promise<T>` and `ApiRequestError(status, code, message)`; `ORG_COOKIE = 'erq_org'`; `loadAppContext(): Promise<{ me: MeResponse; active: OrgSummary }>` (redirects to `/onboarding` when the user has no org).

- [ ] **Step 1: API client and app context**

`apps/web/src/lib/api.ts`:

```ts
import 'server-only';
import { createSupabaseServerClient } from './supabase/server';

export const ORG_COOKIE = 'erq_org';

export class ApiRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export async function apiFetch<T>(path: string, init: RequestInit & { orgId?: string } = {}): Promise<T> {
  const supabase = await createSupabaseServerClient();
  // The API verifies this JWT itself; middleware has already validated the session with getUser().
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new ApiRequestError(401, 'unauthenticated', 'Not signed in');

  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${session.access_token}`);
  if (init.orgId) headers.set('x-org-id', init.orgId);
  if (init.body) headers.set('content-type', 'application/json');

  const res = await fetch(`${process.env.API_URL}${path}`, { ...init, headers, cache: 'no-store' });
  const json = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (!res.ok) {
    throw new ApiRequestError(res.status, json?.error?.code ?? 'unknown', json?.error?.message ?? res.statusText);
  }
  return json as T;
}
```

`apps/web/src/lib/app-context.ts`:

```ts
import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { MeResponse, OrgSummary } from '@erq/shared';
import { apiFetch, ORG_COOKIE } from './api';

export async function loadAppContext(): Promise<{ me: MeResponse; active: OrgSummary }> {
  const me = await apiFetch<MeResponse>('/me');
  const first = me.orgs[0];
  if (!first) redirect('/onboarding');
  const saved = (await cookies()).get(ORG_COOKIE)?.value;
  const active = me.orgs.find((o) => o.orgId === saved) ?? first;
  return { me, active };
}

export const orgCookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  secure: process.env.NODE_ENV === 'production',
};
```

- [ ] **Step 2: Onboarding (create the first business)**

`apps/web/src/app/onboarding/actions.ts`:

```ts
'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createOrgInput, type OrgSummary } from '@erq/shared';
import { apiFetch, ApiRequestError, ORG_COOKIE } from '@/lib/api';
import { orgCookieOptions } from '@/lib/app-context';

export interface FormState {
  error?: string;
}

export async function createOrgAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = createOrgInput.safeParse({ name: formData.get('name') });
  if (!parsed.success) return { error: 'Enter your business name (2 to 100 characters).' };
  let org: OrgSummary;
  try {
    org = await apiFetch<OrgSummary>('/orgs', { method: 'POST', body: JSON.stringify(parsed.data) });
  } catch (e) {
    return { error: e instanceof ApiRequestError ? e.message : 'Something went wrong. Please try again.' };
  }
  (await cookies()).set(ORG_COOKIE, org.orgId, orgCookieOptions);
  redirect('/dashboard');
}
```

`apps/web/src/app/onboarding/page.tsx`:

```tsx
'use client';

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '@erq/ui';
import { useActionState } from 'react';
import { createOrgAction, type FormState } from './actions';

export default function OnboardingPage() {
  const [state, action, pending] = useActionState<FormState, FormData>(createOrgAction, {});
  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Set up your business</CardTitle>
          <CardDescription>You can connect your store and ads next. This takes under a minute.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={action} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="name">Business name</Label>
              <Input id="name" name="name" required minLength={2} maxLength={100} autoComplete="organization" />
            </div>
            {state.error && <p role="alert" className="text-sm text-[--color-destructive]">{state.error}</p>}
            <Button type="submit" disabled={pending}>Create business</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
```

- [ ] **Step 3: Authenticated layout, org switcher, dashboard shell**

`apps/web/src/app/(app)/actions.ts`:

```ts
'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { uuidSchema, type MeResponse } from '@erq/shared';
import { apiFetch, ORG_COOKIE } from '@/lib/api';
import { orgCookieOptions } from '@/lib/app-context';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function switchOrgAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get('orgId') ?? '');
  if (!uuidSchema.safeParse(orgId).success) return;
  const me = await apiFetch<MeResponse>('/me');
  if (!me.orgs.some((o) => o.orgId === orgId)) return; // never trust the posted id
  (await cookies()).set(ORG_COOKIE, orgId, orgCookieOptions);
  redirect('/dashboard');
}

export async function signOutAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  (await cookies()).delete(ORG_COOKIE);
  redirect('/login');
}
```

`apps/web/src/components/org-switcher.tsx`:

```tsx
'use client';

import { Label } from '@erq/ui';
import type { OrgSummary } from '@erq/shared';
import { switchOrgAction } from '@/app/(app)/actions';

export function OrgSwitcher({ orgs, activeId }: { orgs: OrgSummary[]; activeId: string }) {
  if (orgs.length < 2) return null;
  return (
    <form action={switchOrgAction} className="flex items-center gap-2">
      <Label htmlFor="orgId" className="sr-only">Business</Label>
      <select
        id="orgId" name="orgId" defaultValue={activeId}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="h-9 rounded-md border border-[--color-border] bg-[--color-background] px-2 text-sm"
      >
        {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
      </select>
    </form>
  );
}
```

`apps/web/src/app/(app)/layout.tsx`:

```tsx
import { Button } from '@erq/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { OrgSwitcher } from '@/components/org-switcher';
import { loadAppContext } from '@/lib/app-context';
import { signOutAction } from './actions';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const { me, active } = await loadAppContext();
  return (
    <div className="min-h-screen">
      <header className="border-b border-[--color-border]">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-4 px-4 py-3">
          <span className="font-semibold">eRetailQuery</span>
          <nav aria-label="Main" className="flex gap-4 text-sm">
            <Link href="/dashboard">Dashboard</Link>
            <Link href="/team">Team</Link>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <OrgSwitcher orgs={me.orgs} activeId={active.orgId} />
            <form action={signOutAction}><Button variant="ghost" size="sm" type="submit">Sign out</Button></form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
    </div>
  );
}
```

`apps/web/src/app/(app)/dashboard/page.tsx` (placeholder with an empty state that explains the next step, per CLAUDE.md §8):

```tsx
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@erq/ui';
import { loadAppContext } from '@/lib/app-context';

export default async function DashboardPage() {
  const { active } = await loadAppContext();
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{active.name}</h1>
      <Card>
        <CardHeader>
          <CardTitle>Connect your store to see your profit</CardTitle>
          <CardDescription>
            Once your Shopify store and ad accounts are connected, this page shows what you earned today,
            which ads to pause, and what is about to run out. Store connections arrive in the next release.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-[--color-muted-foreground]">
          Your role: {active.role}
        </CardContent>
      </Card>
    </div>
  );
}
```

`apps/web/src/app/(app)/dashboard/loading.tsx` and `team/loading.tsx`:

```tsx
import { Skeleton } from '@erq/ui';

export default function Loading() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-label="Loading">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
```

- [ ] **Step 4: Team page and invites**

`apps/web/src/app/(app)/team/actions.ts`:

```ts
'use server';

import { createInviteInput, type CreatedInviteDto } from '@erq/shared';
import { apiFetch, ApiRequestError } from '@/lib/api';
import { loadAppContext } from '@/lib/app-context';

export interface InviteState {
  error?: string;
  acceptUrl?: string;
}

export async function createInviteAction(_prev: InviteState, formData: FormData): Promise<InviteState> {
  const parsed = createInviteInput.safeParse({ email: formData.get('email'), role: formData.get('role') });
  if (!parsed.success) return { error: 'Enter a valid email and choose a role.' };
  const { active } = await loadAppContext();
  try {
    const invite = await apiFetch<CreatedInviteDto>(`/orgs/${active.orgId}/invites`, {
      method: 'POST', orgId: active.orgId, body: JSON.stringify(parsed.data),
    });
    return { acceptUrl: invite.acceptUrl };
  } catch (e) {
    return { error: e instanceof ApiRequestError ? e.message : 'Could not create the invite.' };
  }
}
```

`apps/web/src/components/invite-form.tsx`:

```tsx
'use client';

import { Button, Input, Label } from '@erq/ui';
import { useActionState } from 'react';
import { createInviteAction, type InviteState } from '@/app/(app)/team/actions';

export function InviteForm() {
  const [state, action, pending] = useActionState<InviteState, FormData>(createInviteAction, {});
  return (
    <form action={action} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="flex flex-1 flex-col gap-1.5">
        <Label htmlFor="email">Teammate email</Label>
        <Input id="email" name="email" type="email" required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="role">Role</Label>
        <select id="role" name="role" defaultValue="viewer"
          className="h-10 rounded-md border border-[--color-border] bg-[--color-background] px-2 text-sm">
          <option value="viewer">Viewer</option>
          <option value="analyst">Analyst</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      <Button type="submit" disabled={pending}>Send invite</Button>
      <div className="sm:basis-full" aria-live="polite">
        {state.error && <p role="alert" className="text-sm text-[--color-destructive]">{state.error}</p>}
        {state.acceptUrl && (
          <p className="text-sm">
            Share this link with your teammate (it works once, for 7 days):{' '}
            <code className="break-all">{state.acceptUrl}</code>
          </p>
        )}
      </div>
    </form>
  );
}
```

`apps/web/src/app/(app)/team/page.tsx`:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from '@erq/ui';
import { hasRole, type MemberDto } from '@erq/shared';
import { InviteForm } from '@/components/invite-form';
import { apiFetch } from '@/lib/api';
import { loadAppContext } from '@/lib/app-context';

export default async function TeamPage() {
  const { active } = await loadAppContext();
  const members = await apiFetch<MemberDto[]>(`/orgs/${active.orgId}/members`, { orgId: active.orgId });
  const canInvite = hasRole(active.role, 'admin');
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Team</h1>
      <Card>
        <CardHeader><CardTitle>Members</CardTitle></CardHeader>
        <CardContent>
          <ul className="divide-y divide-[--color-border]">
            {members.map((m) => (
              <li key={m.userId} className="flex justify-between py-2 text-sm">
                <span className="font-mono">{m.userId.slice(0, 8)}</span>
                <span className="capitalize">{m.role}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      {canInvite ? (
        <Card>
          <CardHeader><CardTitle>Invite a teammate</CardTitle></CardHeader>
          <CardContent><InviteForm /></CardContent>
        </Card>
      ) : (
        <p className="text-sm text-[--color-muted-foreground]">Only admins and owners can invite teammates.</p>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Invite acceptance page**

`apps/web/src/app/invite/[token]/actions.ts`:

```ts
'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiFetch, ApiRequestError, ORG_COOKIE } from '@/lib/api';
import { orgCookieOptions } from '@/lib/app-context';

export interface AcceptState {
  error?: string;
}

export async function acceptInviteAction(token: string): Promise<AcceptState> {
  try {
    const { orgId } = await apiFetch<{ orgId: string }>(`/invites/${encodeURIComponent(token)}/accept`, { method: 'POST' });
    (await cookies()).set(ORG_COOKIE, orgId, orgCookieOptions);
  } catch (e) {
    if (e instanceof ApiRequestError) return { error: e.message };
    return { error: 'Could not accept the invite. Please try again.' };
  }
  redirect('/dashboard');
}
```

`apps/web/src/app/invite/[token]/page.tsx`:

```tsx
'use client';

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@erq/ui';
import { use, useState, useTransition } from 'react';
import { acceptInviteAction } from './actions';

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>You have been invited</CardTitle>
          <CardDescription>Accept to join the team. You must be signed in with the email that was invited.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {error && <p role="alert" className="text-sm text-[--color-destructive]">{error}</p>}
          <Button
            disabled={pending}
            onClick={() => start(async () => { const r = await acceptInviteAction(token); if (r?.error) setError(r.error); })}
          >
            Accept invite
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
```

The middleware already sends signed-out visitors from `/invite/<token>` to `/login?next=/invite/<token>`, and `safeNextPath` keeps that path.

- [ ] **Step 6: Verify and commit**

Run: `pnpm turbo run typecheck build --filter=@erq/web && pnpm lint`
Expected: PASS.

```bash
git add -A && git commit -m "feat(web): add onboarding, app shell with org switcher, team page and invite acceptance"
```

---

### Task 17: Playwright end-to-end test with local Supabase Auth

**Files:**
- Create: `supabase/config.toml` (via `supabase init`, then edited)
- Create: `apps/web/playwright.config.ts`, `apps/web/e2e/onboarding.spec.ts`
- Modify: `docs/dev-setup.md` (written in Task 18; the e2e steps are listed there)

**Interfaces:**
- Consumes: the running stack: Docker Postgres/Redis, local Supabase Auth, migrated database, API on :4000, web on :3000.

- [ ] **Step 1: Local Supabase Auth config**

```bash
pnpm dlx supabase init
```

In `supabase/config.toml` set `[auth.email]` `enable_confirmations = false` and `[auth]` `site_url = "http://localhost:3000"`. Then run `pnpm dlx supabase start` and `pnpm dlx supabase status -o env`. Copy `API_URL` to `NEXT_PUBLIC_SUPABASE_URL`, `ANON_KEY` to `NEXT_PUBLIC_SUPABASE_ANON_KEY`. For API verification, check which signing scheme the CLI version uses: if `http://127.0.0.1:54321/auth/v1/.well-known/jwks.json` returns keys, keep `SUPABASE_JWKS_URL`; otherwise set `SUPABASE_JWT_SECRET` to `JWT_SECRET` from the status output and clear `SUPABASE_JWKS_URL`. Set `SUPABASE_JWT_ISSUER` to `<API_URL>/auth/v1`. Google sign-in is not exercised in e2e; it is configured in the Supabase dashboard for hosted environments.

- [ ] **Step 2: Write the e2e test**

`apps/web/playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: { baseURL: 'http://localhost:3000', trace: 'on-first-retry' },
  webServer: [
    { command: 'pnpm --filter @erq/api dev', url: 'http://localhost:4000/health', reuseExistingServer: !process.env.CI, timeout: 120_000 },
    { command: 'pnpm --filter @erq/web dev', url: 'http://localhost:3000/login', reuseExistingServer: !process.env.CI, timeout: 120_000 },
  ],
});
```

`apps/web/e2e/onboarding.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test('a new user signs up, creates a business, and invites a teammate', async ({ page }) => {
  const email = `e2e+${Date.now()}@example.com`;

  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/onboarding/);

  await page.getByLabel('Business name').fill('E2E Outfitters');
  await page.getByRole('button', { name: 'Create business' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole('heading', { name: 'E2E Outfitters' })).toBeVisible();

  await page.getByRole('link', { name: 'Team' }).click();
  await expect(page.getByText('owner')).toBeVisible();
  await page.getByLabel('Teammate email').fill('teammate@example.com');
  await page.getByRole('button', { name: 'Send invite' }).click();
  await expect(page.getByText(/\/invite\//)).toBeVisible();
});

test('signed-out visitors are sent to login and keep their destination safely', async ({ page }) => {
  await page.goto('/team');
  await expect(page).toHaveURL(/\/login\?next=%2Fteam/);
  await page.goto('/login?next=//evil.com');
  await expect(page.getByRole('link', { name: 'Create an account' })).toHaveAttribute('href', /next=%2Fdashboard/);
});
```

- [ ] **Step 3: Run**

```bash
docker compose up -d
pnpm db:migrate
pnpm dlx supabase start
pnpm --filter @erq/web exec playwright install chromium
pnpm test:e2e
```

Expected: both tests PASS. If the sign-up test lands on "Check your email", confirmations are still enabled in `supabase/config.toml`; run `supabase stop && supabase start` after editing it.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test(web): add Playwright e2e for signup, onboarding and invites with local Supabase"
```

---

### Task 18: CI, documentation and decisions log

**Files:**
- Create: `.github/workflows/ci.yml`, `docs/dev-setup.md`, `docs/architecture/tenancy.md`
- Modify: `CLAUDE.md` (append to the Decisions Log)

- [ ] **Step 1: CI workflow**

`.github/workflows/ci.yml`:

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env: { POSTGRES_USER: erq_owner, POSTGRES_PASSWORD: erq_owner, POSTGRES_DB: erq }
        ports: ['54329:5432']
        options: >-
          --health-cmd "pg_isready -U erq_owner" --health-interval 5s --health-timeout 5s --health-retries 10
    env:
      DATABASE_OWNER_URL: postgres://erq_owner:erq_owner@localhost:54329/erq
      APP_USER_PASSWORD: ci_app_user
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - name: Migrations apply cleanly to an empty database
        run: pnpm db:migrate
      - name: Unit and integration tests (Testcontainers uses the runner's Docker)
        run: pnpm test

  e2e:
    runs-on: ubuntu-latest
    needs: verify
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: pnpm }
      - uses: supabase/setup-cli@v1
      - run: pnpm install --frozen-lockfile
      - run: docker compose up -d
      - run: supabase start
      - name: Write .env from local Supabase
        run: |
          cp .env.example .env
          # Drop placeholder lines so the appended values are the only ones (CI uses the HS256 secret path).
          sed -i '/^NEXT_PUBLIC_SUPABASE_ANON_KEY=$/d;/^SUPABASE_JWT_SECRET=$/d;/^SUPABASE_JWKS_URL=/d' .env
          supabase status -o env > supabase.env
          # Map CLI output to the app's variables (names printed by `supabase status -o env`).
          echo "NEXT_PUBLIC_SUPABASE_ANON_KEY=$(grep '^ANON_KEY=' supabase.env | cut -d'"' -f2)" >> .env
          echo "SUPABASE_JWT_SECRET=$(grep '^JWT_SECRET=' supabase.env | cut -d'"' -f2)" >> .env
      - run: pnpm db:migrate
      - run: pnpm --filter @erq/web exec playwright install --with-deps chromium
      - run: pnpm test:e2e
```

- [ ] **Step 2: Documentation**

`docs/dev-setup.md`: prerequisites (Node 22, pnpm via corepack, Docker Desktop); first run (`cp .env.example .env`, generate `ENCRYPTION_KEY` with `openssl rand -base64 32`, `docker compose up -d`, `pnpm install`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm dev`); running tests (`pnpm test` needs Docker); running e2e (Task 17 steps); the table of root scripts from CLAUDE.md §10; the seeded demo org id and user ids from `packages/db/src/seed.ts`.

`docs/architecture/tenancy.md`: the isolation model in prose. Cover: roles (`erq_owner` owns objects and runs migrations; `app_user` serves traffic); `withTenant` and why it uses a transaction-local setting; why policies use `nullif(...,'')`; composite foreign keys; the three `SECURITY DEFINER` functions and the requirement that the migration role be a superuser or BYPASSRLS (Supabase's `postgres` role qualifies); how to add a tenant table (add schema, generate migration, add a custom migration calling `app_secure_tenant_table`, add a fixture in `packages/db/test/fixtures.ts`; the isolation suite fails otherwise); append-only audit log; invite token handling (only a SHA-256 hash is stored; the raw token is shown once).

- [ ] **Step 3: Update the decisions log**

Append to the Decisions Log in `CLAUDE.md`:

```markdown
- 2026-10-05: Phase 0 is specced and planned separately (`docs/superpowers/specs/2026-10-05-phase0-foundations-design.md`). Phase 1 is split into 1a metrics, 1b Shopify + CSV, 1c Meta/Google, 1d dashboard/P&L/Stripe, each with its own spec.
- 2026-10-05: Auth is Supabase Auth (email + Google). The API verifies Supabase JWTs with `jose`; verify key type against current Supabase docs before launch.
- 2026-10-05: Tenant isolation uses a transaction-local `app.org_id` set by `withTenant`, a non-superuser `app_user` role, and RLS with FORCE. Pre-org operations use three SECURITY DEFINER functions; the migration role must be superuser or BYPASSRLS.
- 2026-10-05: Child tables reference parents with composite `(org_id, id)` foreign keys so a row can never point at another tenant's parent.
- 2026-10-05: Internal packages build to CJS with tsup; the API uses NestJS with the SWC builder; zod is pinned to v3 so zod-to-json-schema can generate OpenAPI bodies.
```

- [ ] **Step 4: Final verification**

Run, in order: `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test`
Expected: all PASS (Docker running). Then `pnpm test:e2e` per Task 17.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "ci: add CI workflow, dev setup and tenancy docs, update decisions log"
```

---

## Self-Review Notes

- **Spec coverage:** repo structure (Task 1, 5, 10, 13, 14), tooling and CI (Task 1, 18), data model (Tasks 6, 7), RLS and isolation test (Tasks 5, 6, 7), auth and endpoints (Tasks 10 to 12), web shell and invite page (Tasks 14 to 16), crypto and logging (Task 3), seed (Task 9), e2e (Task 17), docs (Task 18). Roles hiding of cost data is explicitly out of scope per the spec.
- **Order dependencies:** Task 6 creates the isolation harness; Tasks 7 and later must add a fixture for every new tenant table.
- **Known verify-at-implementation items:** Supabase local JWT signing scheme (Task 17), BullMQ `upsertJobScheduler` availability (Task 13), drizzle `tx.execute` typing with raw strings (Task 6), jose pinned to v5 for `KeyLike`.

