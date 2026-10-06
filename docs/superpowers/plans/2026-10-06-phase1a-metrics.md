# eRetailQuery Phase 1a: Metrics Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@erq/metrics`, the pure calculation layer for SKU pricing, advertising flags, inventory flags and the monthly P&L.

**Architecture:** Pure TypeScript functions with no I/O, clock or timezone logic. Money is `Money` from `@erq/shared` (integer cents); percentages are integer basis points (`Bps`); multiples such as ROAS are plain `number | null`. All integer division goes through one `BigInt` helper that rounds half away from zero. Every flag returns `{ code, facts, explanation }`.

**Tech Stack:** TypeScript strict, Vitest, tsup (CJS), `@erq/shared` (only runtime dependency).

**Spec:** `docs/superpowers/specs/2026-10-06-phase1a-metrics-design.md` (product rules: `CLAUDE.md` §7)

## Global Constraints

- Money is integer cents with an ISO currency. Never floats for money. Mixing currencies throws.
- Percentages are `Bps` (safe integers, 4286 = 42.86%). ROAS and break-even ROAS are plain numbers or `null`.
- Integer division rounds half away from zero, using `BigInt` intermediates. Values that leave the safe integer range throw `RangeError`.
- No meaningful answer is `null`, never `NaN` or `Infinity`.
- No I/O, no `Date.now()`, no timezone logic. Dates are `YYYY-MM-DD` strings passed in by the caller.
- No runtime dependency except `@erq/shared`.
- Every flag result has `code`, `facts` and a plain-English `explanation`.
- Markup is `(price - cost) / cost`; margin is `(price - cost) / price`. They are different; both are always returned.
- Every function has unit tests with edge cases: zero revenue, zero spend, missing cost, refunds exceeding sales, exact boundaries.
- Package config files use `.mts` (`vitest.config.mts`); packages build to CJS with tsup. Tests import source with `../src/<module>`.
- Run tests with `pnpm turbo run test --filter=@erq/metrics` so `@erq/shared` is built first. The dev disk is small: run one package at a time.
- Conventional Commits, one task per commit. Every commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Plan-level clarifications where the spec is silent: the default stock safety buffer is 7 days (`DEFAULT_BUFFER_DAYS`, configurable per call); `floorPrice` and `maxDiscount` are `null` with an explanation when the landed cost is zero (cost unknown); the no-room case gives `floorPrice: null` and `maxDiscount` of zero money.

## Review Focus

Failure modes the spec implies but no happy-path test would catch; each has a pinning test in the task named.

1. Rounding symmetry: negative numerators and denominators round half away from zero, not toward positive infinity (Task 1).
2. Exact boundaries for ROAS: "at break-even" and "exactly 1.5x break-even" must use integer cross-multiplication, not float division (Task 5).
3. Empty or zero inputs: zero spend, zero conversions, empty day lists, an all-zero P&L and zero velocity return `null` or zero values, never `NaN` or `Infinity` (Tasks 4, 5, 6, 7).
4. Refunds exceeding gross sales: net sales go negative, nothing is clamped, margins become `null` (Task 7).
5. Floor price and maximum discount agree with the contribution that `skuPricing` reports at that price, including percentage-fee rounding (Task 3).

## File Structure

```
packages/metrics/
  package.json            add dependency @erq/shared (workspace:*)
  src/
    bps.ts                Bps type, divRound, ratioToBps, moneyRatioBps, formatBps
    pricing.ts            landedCost, skuPricing (+ floor price, max discount)
    ads.ts                roas, blendedRoas, breakEvenRoas, cpa, classifyAd
    inventory.ts          salesVelocity, daysOfCover, stockFlags, stockByLocation
    pnl.ts                buildPnl, sumPnl, comparePnl
    index.ts              re-exports
  test/
    bps.test.ts  pricing.test.ts  ads.test.ts  inventory.test.ts  pnl.test.ts
docs/metrics.md           formulas and usage reference (Task 9)
```

---

### Task 1: Package setup and `bps.ts`

**Files:**
- Modify: `packages/metrics/package.json` (add dependency)
- Modify: `packages/metrics/src/index.ts` (replace placeholder)
- Delete: `packages/metrics/test/smoke.test.ts`
- Create: `packages/metrics/src/bps.ts`
- Test: `packages/metrics/test/bps.test.ts`

**Interfaces:**
- Produces (from `@erq/metrics`): `type Bps = number`; `divRound(numerator: bigint, denominator: bigint): bigint`; `toSafeInteger(value: bigint): number`; `mulDivRound(a: number, b: number, c: number): number`; `bigRatioToBps(numerator: bigint, denominator: bigint): Bps | null`; `ratioToBps(numerator: number, denominator: number): Bps | null`; `moneyRatioBps(part: Money, whole: Money): Bps | null`; `formatBps(bps: Bps): string`.

- [ ] **Step 1: Add the dependency and replace the placeholder**

In `packages/metrics/package.json` add (next to the existing fields, keep the rest unchanged):

```json
  "dependencies": {
    "@erq/shared": "workspace:*"
  },
```

Run: `pnpm install`

Replace `packages/metrics/src/index.ts` with:

```ts
export * from './bps';
```

Delete `packages/metrics/test/smoke.test.ts`.

- [ ] **Step 2: Write the failing tests**

`packages/metrics/test/bps.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { money } from '@erq/shared';
import {
  bigRatioToBps, divRound, formatBps, moneyRatioBps, mulDivRound, ratioToBps, toSafeInteger,
} from '../src/bps';

describe('divRound (half away from zero)', () => {
  it.each([
    [7n, 2n, 4n], [-7n, 2n, -4n], [7n, -2n, -4n], [-7n, -2n, 4n],
    [5n, 2n, 3n], [-5n, 2n, -3n], [1n, 3n, 0n], [2n, 3n, 1n], [0n, 5n, 0n], [0n, -5n, 0n],
  ])('%s / %s = %s', (n, d, expected) => {
    expect(divRound(n, d)).toBe(expected);
  });
  it('throws on division by zero', () => {
    expect(() => divRound(1n, 0n)).toThrow(RangeError);
  });
});

describe('toSafeInteger', () => {
  it('converts safe values and rejects unsafe ones', () => {
    expect(toSafeInteger(42n)).toBe(42);
    expect(() => toSafeInteger(BigInt(Number.MAX_SAFE_INTEGER) + 2n)).toThrow(RangeError);
  });
});

describe('mulDivRound', () => {
  it('multiplies then divides with half-away-from-zero rounding', () => {
    expect(mulDivRound(3, 5000, 10000)).toBe(2); // 1.5 -> 2
    expect(mulDivRound(-3, 5000, 10000)).toBe(-2); // -1.5 -> -2
    expect(mulDivRound(1, 4999, 10000)).toBe(0);
  });
  it('rejects division by zero and non-integers', () => {
    expect(() => mulDivRound(7, 1, 0)).toThrow(RangeError);
    expect(() => mulDivRound(1.5, 1, 1)).toThrow(RangeError);
  });
});

describe('ratioToBps', () => {
  it.each([
    [1, 3, 3333], [2, 3, 6667], [1, 2, 5000], [1, 8, 1250], [0, 5, 0], [3, 3, 10000],
    [-1, 3, -3333], [1, -3, -3333], [-2, 3, -6667], [-1, -3, 3333],
    [1, 32, 313], [-1, 32, -313], // 312.5 rounds away from zero
  ])('%s / %s = %s bps', (n, d, expected) => {
    expect(ratioToBps(n, d)).toBe(expected);
  });
  it('returns null for a zero denominator', () => {
    expect(ratioToBps(5, 0)).toBeNull();
    expect(ratioToBps(0, 0)).toBeNull();
  });
  it('rejects non-integers and results outside the safe range', () => {
    expect(() => ratioToBps(1.5, 2)).toThrow(RangeError);
    expect(() => ratioToBps(Number.MAX_SAFE_INTEGER, 1)).toThrow(RangeError);
  });
});

describe('bigRatioToBps', () => {
  it('matches ratioToBps and returns null on zero', () => {
    expect(bigRatioToBps(1n, 3n)).toBe(3333);
    expect(bigRatioToBps(1n, 0n)).toBeNull();
  });
});

describe('moneyRatioBps', () => {
  it('computes a percentage of two money values', () => {
    expect(moneyRatioBps(money(50), money(150))).toBe(3333);
    expect(moneyRatioBps(money(-50), money(100))).toBe(-5000);
  });
  it('returns null when the whole is zero and throws on mixed currencies', () => {
    expect(moneyRatioBps(money(5), money(0))).toBeNull();
    expect(() => moneyRatioBps(money(1, 'USD'), money(1, 'EUR'))).toThrow(/currency mismatch/);
  });
});

describe('formatBps', () => {
  it.each([
    [4286, '42.86%'], [0, '0.00%'], [-5, '-0.05%'], [5, '0.05%'], [10000, '100.00%'], [-12345, '-123.45%'],
  ])('%s -> %s', (bps, text) => {
    expect(formatBps(bps)).toBe(text);
  });
  it('rejects non-integers', () => {
    expect(() => formatBps(1.5)).toThrow(RangeError);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm turbo run test --filter=@erq/metrics`
Expected: FAIL, cannot resolve `../src/bps`.

- [ ] **Step 4: Implement**

`packages/metrics/src/bps.ts`:

```ts
import type { Money } from '@erq/shared';

/** A percentage in basis points: 4286 means 42.86%. Always a safe integer. */
export type Bps = number;

/** Integer division rounding half away from zero. */
export function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('division by zero');
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  let quotient = n / d;
  if ((n % d) * 2n >= d) quotient += 1n;
  return negative ? -quotient : quotient;
}

export function toSafeInteger(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`value out of safe integer range: ${value}`);
  return n;
}

function assertInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer, got ${value}`);
  }
}

/** (a * b) / c in integer math, rounded half away from zero. */
export function mulDivRound(a: number, b: number, c: number): number {
  assertInteger('a', a);
  assertInteger('b', b);
  assertInteger('c', c);
  return toSafeInteger(divRound(BigInt(a) * BigInt(b), BigInt(c)));
}

export function bigRatioToBps(numerator: bigint, denominator: bigint): Bps | null {
  if (denominator === 0n) return null;
  return toSafeInteger(divRound(numerator * 10000n, denominator));
}

export function ratioToBps(numerator: number, denominator: number): Bps | null {
  assertInteger('numerator', numerator);
  assertInteger('denominator', denominator);
  return bigRatioToBps(BigInt(numerator), BigInt(denominator));
}

export function moneyRatioBps(part: Money, whole: Money): Bps | null {
  if (part.currency !== whole.currency) {
    throw new Error(`currency mismatch: ${part.currency} vs ${whole.currency}`);
  }
  return ratioToBps(part.cents, whole.cents);
}

/** Display only: 4286 -> "42.86%". */
export function formatBps(bps: Bps): string {
  assertInteger('bps', bps);
  const sign = bps < 0 ? '-' : '';
  const abs = Math.abs(bps);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}%`;
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm turbo run test typecheck build --filter=@erq/metrics` then `pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(metrics): add basis-point helpers with half-away-from-zero rounding"
```

---

### Task 2: `pricing.ts` part 1: landed cost and SKU pricing core

**Files:**
- Create: `packages/metrics/src/pricing.ts`
- Modify: `packages/metrics/src/index.ts` (add `export * from './pricing';`)
- Test: `packages/metrics/test/pricing.test.ts`

**Interfaces:**
- Consumes: `Bps`, `moneyRatioBps` from `./bps`; `Money`, `money`, `add`, `subtract`, `negate`, `sum`, `applyBasisPoints`, `formatMoney` from `@erq/shared`.
- Produces: `CostComponent`, `FulfillmentAssumptions`, `PricingConfig`, `DEFAULT_PRICING_CONFIG`, `landedCost(components, asOf, currency?)`, `SkuPricing`, `skuPricing(input)`. Task 3 extends `SkuPricing` and `skuPricing`.

- [ ] **Step 1: Write the failing tests**

`packages/metrics/test/pricing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { money } from '@erq/shared';
import { DEFAULT_PRICING_CONFIG, landedCost, skuPricing, type CostComponent } from '../src/pricing';

const comp = (
  amountCents: number, effectiveFrom: string, effectiveTo: string | null = null, currency = 'USD',
): CostComponent => ({ componentType: 'product_cost', amountCents, currency, effectiveFrom, effectiveTo });

describe('landedCost (time-versioned)', () => {
  const components = [
    comp(1000, '2025-01-01', '2025-07-01'),
    comp(1200, '2025-07-01'),
    { ...comp(100, '2025-01-01'), componentType: 'inbound_freight' },
  ];
  it.each([
    ['2024-12-31', 0], ['2025-01-01', 1100], ['2025-06-30', 1100], ['2025-07-01', 1300], ['2030-01-01', 1300],
  ])('as of %s costs %s cents', (asOf, cents) => {
    expect(landedCost(components, asOf)).toEqual(money(cents));
  });
  it('returns zero for no components, in the requested currency', () => {
    expect(landedCost([], '2025-01-01')).toEqual(money(0));
    expect(landedCost([], '2025-01-01', 'EUR')).toEqual(money(0, 'EUR'));
  });
  it('rejects mixed currencies, bad dates and fractional amounts', () => {
    expect(() => landedCost([comp(100, '2025-01-01', null, 'EUR')], '2025-01-01')).toThrow(/currency mismatch/);
    expect(() => landedCost([], '01/02/2025')).toThrow(RangeError);
    expect(() => landedCost([comp(10.5, '2025-01-01')], '2025-01-01')).toThrow(RangeError);
  });
});

describe('DEFAULT_PRICING_CONFIG', () => {
  it('uses a 50% to 100% markup range and a 15% minimum contribution', () => {
    expect(DEFAULT_PRICING_CONFIG).toEqual({ targetMarkupLow: 5000, targetMarkupHigh: 10000, minContribution: 1500 });
  });
});

describe('skuPricing: markup, margin, ideal range, status', () => {
  const landed = money(2000);
  it('shows markup and margin side by side (50% markup = 33.33% margin)', () => {
    const r = skuPricing({ price: money(3000), landed });
    expect(r.markup).toBe(5000);
    expect(r.margin).toBe(3333);
  });
  it('shows 100% markup = 50% margin', () => {
    const r = skuPricing({ price: money(4000), landed });
    expect(r.markup).toBe(10000);
    expect(r.margin).toBe(5000);
  });
  it('computes the ideal range from landed cost', () => {
    const r = skuPricing({ price: money(3000), landed });
    expect(r.idealRange).toEqual({ low: money(3000), high: money(4000) });
  });
  it.each([
    [2999, 'underpriced'], [3000, 'healthy'], [3500, 'healthy'], [4000, 'healthy'], [4001, 'premium'],
  ])('price %s is %s', (price, code) => {
    expect(skuPricing({ price: money(price), landed }).status.code).toBe(code);
  });
  it('tells the owner what to do', () => {
    expect(skuPricing({ price: money(2500), landed }).status.explanation).toBe('Underpriced. Raise to at least $30.00.');
    expect(skuPricing({ price: money(5000), landed }).status.explanation).toBe('Premium. Check that it is still selling.');
    expect(skuPricing({ price: money(3500), landed }).status.explanation).toBe('Healthy.');
  });
  it('honours a custom markup range', () => {
    const r = skuPricing({ price: money(3000), landed, config: { targetMarkupLow: 8000, targetMarkupHigh: 12000 } });
    expect(r.idealRange).toEqual({ low: money(3600), high: money(4400) });
    expect(r.status.code).toBe('underpriced');
  });
  it('has an unknown status and null markup and range when cost is missing', () => {
    const r = skuPricing({ price: money(3000), landed: money(0) });
    expect(r.status.code).toBe('unknown');
    expect(r.markup).toBeNull();
    expect(r.idealRange).toBeNull();
    expect(r.margin).toBe(10000);
  });
  it('handles a zero price', () => {
    const r = skuPricing({ price: money(0), landed });
    expect(r.margin).toBeNull();
    expect(r.contributionBps).toBeNull();
    expect(r.markup).toBe(-10000);
  });
});

describe('skuPricing: contribution', () => {
  const fulfillment = {
    fixed: { outboundShipping: money(500), pickPack: money(200), paymentFee: money(30) },
    percentOfPrice: { paymentFee: 290, returnsAllowance: 200 },
  };
  it('subtracts landed cost, fixed costs and percentage costs at the net price', () => {
    const r = skuPricing({ price: money(5000), landed: money(2000), fulfillment });
    expect(r.variableCost).toEqual(money(2975));
    expect(r.contribution).toEqual(money(2025));
    expect(r.contributionBps).toBe(4050);
    expect(r.netPrice).toEqual(money(5000));
  });
  it('applies percentage fees to the discounted price', () => {
    const r = skuPricing({ price: money(5000), discount: money(1000), landed: money(2000), fulfillment });
    // net 4000: percent cost 196, variable 2000 + 730 + 196 = 2926, contribution 1074
    expect(r.netPrice).toEqual(money(4000));
    expect(r.contribution).toEqual(money(1074));
    expect(r.contributionBps).toBe(2685);
  });
  it('warns when markup looks fine but each sale loses money', () => {
    const r = skuPricing({
      price: money(3000), landed: money(2000), fulfillment: { fixed: { outboundShipping: money(1500) } },
    });
    expect(r.markup).toBe(5000);
    expect(r.contribution).toEqual(money(-500));
    expect(r.warning?.code).toBe('markup_ok_contribution_negative');
    expect(r.warning?.explanation).toContain('$5.00');
    expect(r.warning?.explanation).toContain('50.00%');
  });
  it('has no warning when contribution is not negative', () => {
    expect(skuPricing({ price: money(3000), landed: money(2000) }).warning).toBeNull();
  });
  it('has no warning when markup is below the target range', () => {
    const r = skuPricing({ price: money(2200), landed: money(2000), fulfillment: { fixed: { outboundShipping: money(1500) } } });
    expect(r.warning).toBeNull();
  });
  it('treats missing fulfillment assumptions as zero', () => {
    const r = skuPricing({ price: money(3000), landed: money(2000) });
    expect(r.contribution).toEqual(money(1000));
  });
});

describe('skuPricing: validation', () => {
  it('rejects a discount larger than the price', () => {
    expect(() => skuPricing({ price: money(1000), discount: money(1001), landed: money(500) })).toThrow(RangeError);
  });
  it('rejects mixed currencies', () => {
    expect(() => skuPricing({ price: money(1000), landed: money(500, 'EUR') })).toThrow(/currency mismatch/);
    expect(() =>
      skuPricing({ price: money(1000), landed: money(500), fulfillment: { fixed: { pickPack: money(1, 'EUR') } } }),
    ).toThrow(/currency mismatch/);
  });
  it('rejects negative or fractional percentage fees', () => {
    expect(() => skuPricing({ price: money(1000), landed: money(500), fulfillment: { percentOfPrice: { paymentFee: -1 } } })).toThrow(RangeError);
    expect(() => skuPricing({ price: money(1000), landed: money(500), fulfillment: { percentOfPrice: { paymentFee: 1.5 } } })).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm turbo run test --filter=@erq/metrics`
Expected: FAIL, cannot resolve `../src/pricing`.

- [ ] **Step 3: Implement**

`packages/metrics/src/pricing.ts`:

```ts
import { add, applyBasisPoints, formatMoney, money, negate, subtract, sum, type Money } from '@erq/shared';
import { formatBps, moneyRatioBps, type Bps } from './bps';

export interface CostComponent {
  componentType: string;
  amountCents: number;
  currency: string;
  /** Inclusive, YYYY-MM-DD. */
  effectiveFrom: string;
  /** Exclusive, YYYY-MM-DD, or null for open-ended. */
  effectiveTo: string | null;
}

export interface FulfillmentAssumptions {
  fixed?: { pickPack?: Money; outboundShipping?: Money; paymentFee?: Money; fbaFee?: Money };
  /** Basis points of the (discounted) selling price. */
  percentOfPrice?: { paymentFee?: Bps; marketplaceFee?: Bps; returnsAllowance?: Bps };
}

export interface PricingConfig {
  targetMarkupLow: Bps;
  targetMarkupHigh: Bps;
  minContribution: Bps;
}

export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  targetMarkupLow: 5000,
  targetMarkupHigh: 10000,
  minContribution: 1500,
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Per-unit landed cost in effect on `asOf`. Per-batch costs must be converted to per-unit by the caller. */
export function landedCost(components: CostComponent[], asOf: string, currency = 'USD'): Money {
  if (!ISO_DATE.test(asOf)) throw new RangeError(`asOf must be YYYY-MM-DD, got ${asOf}`);
  let total = money(0, currency);
  for (const c of components) {
    if (c.currency !== currency) throw new Error(`currency mismatch: ${c.currency} vs ${currency}`);
    const amount = money(c.amountCents, c.currency);
    if (c.effectiveFrom <= asOf && (c.effectiveTo === null || asOf < c.effectiveTo)) {
      total = add(total, amount);
    }
  }
  return total;
}

export function fixedTotal(fixed: FulfillmentAssumptions['fixed'], currency: string): Money {
  const values = Object.values(fixed ?? {}).filter((m): m is Money => m !== undefined);
  return sum(values, currency);
}

export function percentTotal(percent: FulfillmentAssumptions['percentOfPrice']): Bps {
  let total = 0;
  for (const [name, bps] of Object.entries(percent ?? {})) {
    if (bps === undefined) continue;
    if (!Number.isSafeInteger(bps) || bps < 0) {
      throw new RangeError(`${name} must be a non-negative integer in basis points, got ${bps}`);
    }
    total += bps;
  }
  return total;
}

export interface SkuPricing {
  currency: string;
  netPrice: Money;
  landed: Money;
  variableCost: Money;
  contribution: Money;
  /** (price - landed) / landed, null when landed cost is zero. */
  markup: Bps | null;
  /** (price - landed) / price, null when the price is zero. */
  margin: Bps | null;
  /** Contribution as a share of the net price, null when the net price is zero. */
  contributionBps: Bps | null;
  idealRange: { low: Money; high: Money } | null;
  status: { code: 'underpriced' | 'healthy' | 'premium' | 'unknown'; explanation: string };
  warning: { code: 'markup_ok_contribution_negative'; explanation: string } | null;
}

export function skuPricing(input: {
  price: Money;
  discount?: Money;
  landed: Money;
  fulfillment?: FulfillmentAssumptions;
  config?: Partial<PricingConfig>;
}): SkuPricing {
  const config: PricingConfig = { ...DEFAULT_PRICING_CONFIG, ...input.config };
  const { price, landed } = input;
  const currency = price.currency;
  const discount = input.discount ?? money(0, currency);
  const fulfillment = input.fulfillment ?? {};

  const fixed = fixedTotal(fulfillment.fixed, currency);
  const pct = percentTotal(fulfillment.percentOfPrice);
  const netPrice = subtract(price, discount);
  if (price.cents < 0 || netPrice.cents < 0) {
    throw new RangeError('price and discount must leave a non-negative net price');
  }

  const percentCost = applyBasisPoints(netPrice, pct);
  const variableCost = add(add(landed, fixed), percentCost);
  const contribution = subtract(netPrice, variableCost);

  const profitOverLanded = subtract(price, landed);
  const markup = landed.cents === 0 ? null : moneyRatioBps(profitOverLanded, landed);
  const margin = price.cents === 0 ? null : moneyRatioBps(profitOverLanded, price);
  const contributionBps = netPrice.cents === 0 ? null : moneyRatioBps(contribution, netPrice);

  const idealRange =
    landed.cents === 0
      ? null
      : {
          low: add(landed, applyBasisPoints(landed, config.targetMarkupLow)),
          high: add(landed, applyBasisPoints(landed, config.targetMarkupHigh)),
        };

  let status: SkuPricing['status'];
  if (!idealRange) {
    status = { code: 'unknown', explanation: 'No cost data yet. Add the cost of this item to see whether the price is healthy.' };
  } else if (price.cents < idealRange.low.cents) {
    status = { code: 'underpriced', explanation: `Underpriced. Raise to at least ${formatMoney(idealRange.low)}.` };
  } else if (price.cents > idealRange.high.cents) {
    status = { code: 'premium', explanation: 'Premium. Check that it is still selling.' };
  } else {
    status = { code: 'healthy', explanation: 'Healthy.' };
  }

  const warning =
    idealRange && markup !== null && price.cents >= idealRange.low.cents && contribution.cents < 0
      ? {
          code: 'markup_ok_contribution_negative' as const,
          explanation: `Markup looks healthy (${formatBps(markup)}) but after fees and shipping each sale loses ${formatMoney(negate(contribution))}. Raise the price or lower the costs.`,
        }
      : null;

  return { currency, netPrice, landed, variableCost, contribution, markup, margin, contributionBps, idealRange, status, warning };
}
```

Append to `packages/metrics/src/index.ts`: `export * from './pricing';`

- [ ] **Step 4: Run to verify pass**

Run: `pnpm turbo run test typecheck build --filter=@erq/metrics` then `pnpm lint`
Expected: PASS. If a `contributionBps` or other expected value differs by one because of rounding, recompute by hand from the test comments before changing code; do not loosen the expectations without reporting.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(metrics): add landed cost and SKU pricing with markup, margin, range and status"
```

---

### Task 3: `pricing.ts` part 2: floor price and maximum discount

**Files:**
- Modify: `packages/metrics/src/pricing.ts`
- Modify: `packages/metrics/test/pricing.test.ts` (append tests)

**Interfaces:**
- Consumes: Task 2's `skuPricing`, `fixedTotal`, `percentTotal`, `SkuPricing`; `mulDivRound`, `toSafeInteger` from `./bps`.
- Produces: `SkuPricing` gains `floorPrice: Money | null`, `floorExplanation: string | null`, `maxDiscount: Money | null`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/metrics/test/pricing.test.ts`:

```ts
const fulfillmentFull = {
  fixed: { outboundShipping: money(500), pickPack: money(200), paymentFee: money(30) },
  percentOfPrice: { paymentFee: 290, returnsAllowance: 200 },
};

describe('skuPricing: floor price and maximum discount', () => {
  const base = { price: money(5000), landed: money(2000), fulfillment: fulfillmentFull };
  it('finds the lowest price that keeps the minimum contribution', () => {
    const r = skuPricing(base);
    expect(r.floorPrice).toEqual(money(3409));
    expect(r.floorExplanation).toBeNull();
  });
  it('allows a discount down to the floor, and no further', () => {
    const r = skuPricing(base);
    expect(r.maxDiscount).toEqual(money(1591));
    const atMax = skuPricing({ ...base, discount: money(1591) });
    const pastMax = skuPricing({ ...base, discount: money(1592) });
    expect(atMax.contributionBps).toBe(1502);
    expect(pastMax.contributionBps).toBe(1499);
  });
  it('has a zero maximum discount when the price is already at or below the floor', () => {
    expect(skuPricing({ ...base, price: money(3409) }).maxDiscount).toEqual(money(0));
    expect(skuPricing({ ...base, price: money(3000) }).maxDiscount).toEqual(money(0));
  });
  it('has no floor when percentage fees plus the minimum leave no room', () => {
    const r = skuPricing({
      price: money(5000), landed: money(2000),
      fulfillment: { percentOfPrice: { paymentFee: 9000 } }, // 90% + 15% minimum >= 100%
    });
    expect(r.floorPrice).toBeNull();
    expect(r.floorExplanation).toContain('no price reaches the minimum');
    expect(r.maxDiscount).toEqual(money(0));
  });
  it('has no floor or maximum discount when cost is unknown', () => {
    const r = skuPricing({ price: money(5000), landed: money(0), fulfillment: fulfillmentFull });
    expect(r.floorPrice).toBeNull();
    expect(r.floorExplanation).toBe('Add cost data to calculate a floor price.');
    expect(r.maxDiscount).toBeNull();
  });
  it('has no maximum discount for a zero price', () => {
    expect(skuPricing({ price: money(0), landed: money(2000) }).maxDiscount).toBeNull();
  });
  it('honours a custom minimum contribution', () => {
    const r = skuPricing({ ...base, config: { minContribution: 0 } });
    // smallest price with contribution >= 0: (2000 + 730) / (1 - 4.9%) ~ 2870.6
    expect(r.floorPrice?.cents).toBeGreaterThanOrEqual(2870);
    expect(r.floorPrice?.cents).toBeLessThanOrEqual(2872);
  });
});

describe('skuPricing: the floor price agrees with the contribution reported at that price', () => {
  const landeds = [500, 2000, 12345];
  const shippings = [0, 730];
  const pcts = [0, 490, 2900];
  const mins = [0, 1500, 3000];
  for (const landed of landeds) {
    for (const ship of shippings) {
      for (const pct of pcts) {
        for (const minC of mins) {
          it(`landed ${landed}, fixed ${ship}, pct ${pct}, min ${minC}`, () => {
            const fulfillment = { fixed: { outboundShipping: money(ship) }, percentOfPrice: { paymentFee: pct } };
            const config = { minContribution: minC };
            const r = skuPricing({ price: money(100000), landed: money(landed), fulfillment, config });
            const f = r.floorPrice;
            expect(f).not.toBeNull();
            const at = (cents: number) => skuPricing({ price: money(cents), landed: money(landed), fulfillment, config });
            const meets = (cents: number) => at(cents).contribution.cents * 10000 >= minC * cents;
            expect(meets(f!.cents)).toBe(true);
            if (f!.cents > 1) expect(meets(f!.cents - 1)).toBe(false);
            expect(r.maxDiscount).toEqual(money(100000 - f!.cents));
          });
        }
      }
    }
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm turbo run test --filter=@erq/metrics`
Expected: the new tests FAIL (`floorPrice` is undefined).

- [ ] **Step 3: Implement**

In `packages/metrics/src/pricing.ts` change the import from `./bps` to:

```ts
import { formatBps, moneyRatioBps, mulDivRound, toSafeInteger, type Bps } from './bps';
```

Extend the `SkuPricing` interface with:

```ts
  /** Lowest price whose contribution is at or above the minimum, null when unknown or impossible. */
  floorPrice: Money | null;
  floorExplanation: string | null;
  /** Largest discount that keeps contribution at or above the minimum. */
  maxDiscount: Money | null;
```

Add these helpers above `skuPricing`:

```ts
/** Does a net price of `net` cents reach the minimum contribution? Same rounding as skuPricing. */
function meetsMinimum(net: number, landedCents: number, fixedCents: number, pct: Bps, minContribution: Bps): boolean {
  const contribution = net - landedCents - fixedCents - mulDivRound(net, pct, 10000);
  return BigInt(contribution) * 10000n >= BigInt(minContribution) * BigInt(net);
}

function findFloor(landedCents: number, fixedCents: number, pct: Bps, minContribution: Bps): number | null {
  const rate = pct + minContribution;
  if (rate >= 10000) return null;
  const divisor = BigInt(10000 - rate);
  const base = BigInt(landedCents + fixedCents) * 10000n;
  const guess = toSafeInteger((base + divisor - 1n) / divisor); // ceil, ignores fee rounding
  // Fee rounding can move the true floor by up to ~1 / (1 - rate) cents; search a window around the guess.
  const window = Math.ceil(10000 / (10000 - rate)) + 2;
  const meets = (cents: number) => meetsMinimum(cents, landedCents, fixedCents, pct, minContribution);
  for (let f = Math.max(1, guess - window); f <= guess + window; f++) {
    if (meets(f)) {
      let lowest = f;
      while (lowest > 1 && meets(lowest - 1)) lowest--;
      return lowest;
    }
  }
  throw new Error('floor price search failed');
}
```

Inside `skuPricing`, after `warning` is computed and before the `return`, add:

```ts
  let floorPrice: Money | null = null;
  let floorExplanation: string | null = null;
  let maxDiscount: Money | null = null;
  if (landed.cents === 0) {
    floorExplanation = 'Add cost data to calculate a floor price.';
  } else {
    const floor = findFloor(landed.cents, fixed.cents, pct, config.minContribution);
    if (floor === null) {
      floorExplanation =
        'Fees and your minimum profit add up to 100% of the price or more, so no price reaches the minimum. Lower the fees or the minimum.';
      maxDiscount = money(0, currency);
    } else {
      floorPrice = money(floor, currency);
      if (price.cents > 0) maxDiscount = money(Math.max(0, price.cents - floor), currency);
    }
  }
```

Include the new fields in the returned object: `{ ..., warning, floorPrice, floorExplanation, maxDiscount }`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm turbo run test typecheck build --filter=@erq/metrics` then `pnpm lint`
Expected: PASS, including every grid case (the loops are generated tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(metrics): add floor price and maximum discount to SKU pricing"
```

### Task 4: `ads.ts` part 1: ROAS, blended ROAS, break-even ROAS, CPA

**Files:**
- Create: `packages/metrics/src/ads.ts`
- Modify: `packages/metrics/src/index.ts` (add `export * from './ads';`)
- Test: `packages/metrics/test/ads.test.ts`

**Interfaces:**
- Consumes: `divRound`, `toSafeInteger`, `Bps` from `./bps`; `Money`, `money` from `@erq/shared`.
- Produces: `roas(revenue: Money, spend: Money): number | null`, `blendedRoas(totalStoreRevenue: Money, totalAdSpend: Money): number | null`, `breakEvenRoas(contributionBeforeAds: Bps): number | null`, `cpa(spend: Money, conversions: number): Money | null`. Task 5 appends `classifyAd` to the same files.

- [ ] **Step 1: Write the failing tests**

`packages/metrics/test/ads.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { money } from '@erq/shared';
import { blendedRoas, breakEvenRoas, cpa, roas } from '../src/ads';

describe('roas', () => {
  it('divides platform revenue by spend', () => {
    expect(roas(money(14000), money(7000))).toBe(2);
    expect(roas(money(0), money(7000))).toBe(0);
    expect(roas(money(10500), money(7000))).toBe(1.5);
  });
  it('returns null (not Infinity or NaN) when spend is zero', () => {
    expect(roas(money(5000), money(0))).toBeNull();
    expect(roas(money(0), money(0))).toBeNull();
  });
  it('rejects negative spend and mixed currencies', () => {
    expect(() => roas(money(1), money(-1))).toThrow(RangeError);
    expect(() => roas(money(1, 'USD'), money(1, 'EUR'))).toThrow(/currency mismatch/);
  });
});

describe('blendedRoas (MER)', () => {
  it('divides total store revenue by total ad spend', () => {
    expect(blendedRoas(money(90000), money(30000))).toBe(3);
  });
  it('returns null when there was no ad spend', () => {
    expect(blendedRoas(money(90000), money(0))).toBeNull();
  });
});

describe('breakEvenRoas', () => {
  it.each([
    [4000, 2.5], [10000, 1], [5000, 2], [2500, 4],
  ])('contribution %s bps -> %s', (bps, expected) => {
    expect(breakEvenRoas(bps)).toBe(expected);
  });
  it('returns null when there is no positive margin to pay for ads', () => {
    expect(breakEvenRoas(0)).toBeNull();
    expect(breakEvenRoas(-500)).toBeNull();
  });
  it('rejects fractional basis points', () => {
    expect(() => breakEvenRoas(33.5)).toThrow(RangeError);
  });
});

describe('cpa', () => {
  it('divides spend by conversions, rounding half away from zero', () => {
    expect(cpa(money(1000), 4)).toEqual(money(250));
    expect(cpa(money(1000), 3)).toEqual(money(333));
    expect(cpa(money(1001), 2)).toEqual(money(501));
  });
  it('returns null with zero conversions', () => {
    expect(cpa(money(1000), 0)).toBeNull();
    expect(cpa(money(0), 0)).toBeNull();
  });
  it('is zero when spend is zero but there were conversions', () => {
    expect(cpa(money(0), 5)).toEqual(money(0));
  });
  it('rejects negative or fractional conversions and negative spend', () => {
    expect(() => cpa(money(1000), -1)).toThrow(RangeError);
    expect(() => cpa(money(1000), 1.5)).toThrow(RangeError);
    expect(() => cpa(money(-1), 1)).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm turbo run test --filter=@erq/metrics`
Expected: FAIL, cannot resolve `../src/ads`.

- [ ] **Step 3: Implement**

`packages/metrics/src/ads.ts`:

```ts
import { money, type Money } from '@erq/shared';
import { divRound, toSafeInteger, type Bps } from './bps';

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`);
}

/** Platform-reported revenue divided by spend. Null when nothing was spent. */
export function roas(revenue: Money, spend: Money): number | null {
  assertSameCurrency(revenue, spend);
  if (spend.cents < 0) throw new RangeError('spend cannot be negative');
  if (spend.cents === 0) return null;
  return revenue.cents / spend.cents;
}

/** Total store revenue divided by total ad spend across all platforms (also called MER). */
export function blendedRoas(totalStoreRevenue: Money, totalAdSpend: Money): number | null {
  return roas(totalStoreRevenue, totalAdSpend);
}

/** 1 / contribution margin before ads. Null when there is no positive margin. */
export function breakEvenRoas(contributionBeforeAds: Bps): number | null {
  if (!Number.isSafeInteger(contributionBeforeAds)) {
    throw new RangeError(`contributionBeforeAds must be an integer in basis points, got ${contributionBeforeAds}`);
  }
  if (contributionBeforeAds <= 0) return null;
  return 10000 / contributionBeforeAds;
}

/** Cost per acquisition. Null when there were no conversions. */
export function cpa(spend: Money, conversions: number): Money | null {
  if (!Number.isSafeInteger(conversions) || conversions < 0) {
    throw new RangeError(`conversions must be a non-negative integer, got ${conversions}`);
  }
  if (spend.cents < 0) throw new RangeError('spend cannot be negative');
  if (conversions === 0) return null;
  return money(toSafeInteger(divRound(BigInt(spend.cents), BigInt(conversions))), spend.currency);
}
```

Append `export * from './ads';` to `packages/metrics/src/index.ts`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm turbo run test typecheck build --filter=@erq/metrics` then `pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(metrics): add ROAS, blended ROAS, break-even ROAS and CPA"
```

---

### Task 5: `ads.ts` part 2: ad flags

**Files:**
- Modify: `packages/metrics/src/ads.ts`
- Modify: `packages/metrics/test/ads.test.ts` (append)

**Interfaces:**
- Consumes: Task 4 exports; `bigRatioToBps`, `divRound`, `toSafeInteger`, `Bps` from `./bps`; `formatMoney`, `money`, `Money` from `@erq/shared`.
- Produces: `AdDay`, `AdFlagConfig` (`minSpendCents: number`, `minImpressions`, `winningMultiple`, `declineThreshold: Bps`, `genericBands: { poor: number; good: number }`), `DEFAULT_AD_FLAG_CONFIG` (5000, 1000, 1.5, 2000, `{ poor: 1.5, good: 3 }`), `AdFlagCode`, `AdFlag`, `classifyAd(input: { days: AdDay[]; contributionBeforeAds: Bps | null }, config?: Partial<AdFlagConfig>): AdFlag`. `minSpendCents` replaces the spec's `minSpend: Money` so the default does not depend on currency; it is interpreted in the currency of the days.

- [ ] **Step 1: Write the failing tests**

Append to `packages/metrics/test/ads.test.ts` (and add `classifyAd` and `type AdDay` to the existing import from `../src/ads`):

```ts
const day = (n: number, p: Partial<AdDay> = {}): AdDay => ({
  date: `2026-09-${String(n).padStart(2, '0')}`,
  spend: money(0), impressions: 0, clicks: 0, conversions: 0, revenue: money(0), ...p,
});
/** Seven days that carry the totals on the first day, so only the totals matter. */
const week = (startDay: number, spend: number, revenue: number, impressions = 3500): AdDay[] =>
  Array.from({ length: 7 }, (_, i) =>
    day(startDay + i, i === 0 ? { spend: money(spend), revenue: money(revenue), impressions } : {}),
  );

describe('classifyAd with cost data (contribution before ads 40% -> break-even 2.5)', () => {
  const c = 4000;
  it('flags losing, with the estimated daily loss', () => {
    const f = classifyAd({ days: week(8, 7000, 14000), contributionBeforeAds: c });
    expect(f.code).toBe('losing');
    expect(f.roas).toBe(2);
    expect(f.breakEven).toBe(2.5);
    expect(f.estimatedDailyLoss).toEqual(money(200));
    expect(f.usedGenericBands).toBe(false);
    expect(f.explanation).toContain('Pause or fix this ad');
    expect(f.explanation).toContain('$2.00');
  });
  it('loses the whole spend when revenue is zero', () => {
    const f = classifyAd({ days: week(8, 7000, 0), contributionBeforeAds: c });
    expect(f.code).toBe('losing');
    expect(f.estimatedDailyLoss).toEqual(money(1000));
  });
  it('is not losing exactly at break-even (integer boundary)', () => {
    const f = classifyAd({ days: week(8, 7000, 17500), contributionBeforeAds: c });
    expect(f.roas).toBe(2.5);
    expect(f.code).toBe('watch');
    expect(f.estimatedDailyLoss).toBeNull();
    expect(f.explanation).toContain('above break-even');
  });
  it('is one cent of revenue below break-even -> losing', () => {
    expect(classifyAd({ days: week(8, 7000, 17499), contributionBeforeAds: c }).code).toBe('losing');
  });
  it('watches the band between break-even and 1.5x break-even', () => {
    expect(classifyAd({ days: week(8, 7000, 21000), contributionBeforeAds: c }).code).toBe('watch');
  });
  it('is winning at exactly 1.5x break-even (integer boundary) and above', () => {
    expect(classifyAd({ days: week(8, 7000, 26250), contributionBeforeAds: c }).code).toBe('winning');
    expect(classifyAd({ days: week(8, 7000, 26249), contributionBeforeAds: c }).code).toBe('watch');
    const f = classifyAd({ days: week(8, 7000, 28000), contributionBeforeAds: c });
    expect(f.code).toBe('winning');
    expect(f.explanation).toContain('Scale');
  });
  it('honours a custom winning multiple', () => {
    const f = classifyAd({ days: week(8, 7000, 28000), contributionBeforeAds: c }, { winningMultiple: 2 });
    expect(f.code).toBe('watch');
  });
});

describe('classifyAd trend (week over week)', () => {
  // contribution 50% -> break-even 2.0; 1.5x = 3.0
  it('watches a winning ad that dropped more than 20% from the week before', () => {
    const days = [...week(1, 7000, 31500), ...week(8, 7000, 21000)]; // 4.5 -> 3.0
    const f = classifyAd({ days, contributionBeforeAds: 5000 });
    expect(f.trend).toBe(-3333);
    expect(f.code).toBe('watch');
    expect(f.explanation).toContain('dropped');
  });
  it('keeps a winning ad winning when the drop is small', () => {
    const days = [...week(1, 7000, 23100), ...week(8, 7000, 21000)]; // 3.3 -> 3.0
    const f = classifyAd({ days, contributionBeforeAds: 5000 });
    expect(f.trend).toBe(-909);
    expect(f.code).toBe('winning');
  });
  it('has a null trend without a full previous week or with a zero-revenue previous week', () => {
    expect(classifyAd({ days: week(8, 7000, 21000), contributionBeforeAds: 5000 }).trend).toBeNull();
    const zeroPrev = [...week(1, 7000, 0), ...week(8, 7000, 21000)];
    expect(classifyAd({ days: zeroPrev, contributionBeforeAds: 5000 }).trend).toBeNull();
    const noSpendPrev = [...week(1, 0, 0), ...week(8, 7000, 21000)];
    expect(classifyAd({ days: noSpendPrev, contributionBeforeAds: 5000 }).trend).toBeNull();
  });
  it('shows a rising trend as positive basis points', () => {
    const days = [...week(1, 7000, 14000), ...week(8, 7000, 21000)];
    expect(classifyAd({ days, contributionBeforeAds: 5000 }).trend).toBe(5000);
  });
});

describe('classifyAd learning (never flagged losing)', () => {
  it('is learning below the minimum spend', () => {
    const f = classifyAd({ days: week(8, 4900, 0), contributionBeforeAds: 4000 });
    expect(f.code).toBe('learning');
    expect(f.explanation).toContain('Not enough data');
  });
  it('is not learning at exactly the minimum spend and impressions', () => {
    expect(classifyAd({ days: week(8, 5000, 20000, 1000), contributionBeforeAds: 4000 }).code).toBe('winning');
    expect(classifyAd({ days: week(8, 5000, 20000, 999), contributionBeforeAds: 4000 }).code).toBe('learning');
  });
  it('is learning with no spend, with null ROAS', () => {
    const f = classifyAd({ days: week(8, 0, 0), contributionBeforeAds: 4000 });
    expect(f.code).toBe('learning');
    expect(f.roas).toBeNull();
  });
  it('is learning with no days at all', () => {
    const f = classifyAd({ days: [], contributionBeforeAds: 4000 });
    expect(f.code).toBe('learning');
    expect(f.facts.daysUsed).toBe(0);
    expect(f.roas).toBeNull();
  });
  it('is learning even with no spend when the minimum spend is configured as zero', () => {
    expect(classifyAd({ days: week(8, 0, 0), contributionBeforeAds: 4000 }, { minSpendCents: 0, minImpressions: 0 }).code).toBe('learning');
  });
});

describe('classifyAd fewer than seven days', () => {
  it('judges on the days available and leaves the trend null', () => {
    const f = classifyAd({
      days: [day(1, { spend: money(6000), impressions: 2000 })], contributionBeforeAds: 4000,
    });
    expect(f.code).toBe('losing');
    expect(f.estimatedDailyLoss).toEqual(money(6000));
    expect(f.trend).toBeNull();
  });
});

describe('classifyAd generic bands (no usable cost data)', () => {
  it.each([
    [7000, 'losing'], [10499, 'losing'], [10500, 'watch'], [14000, 'watch'], [21000, 'watch'], [21001, 'winning'], [24500, 'winning'],
  ])('revenue %s -> %s', (revenue, code) => {
    const f = classifyAd({ days: week(8, 7000, revenue), contributionBeforeAds: null });
    expect(f.code).toBe(code);
    expect(f.usedGenericBands).toBe(true);
    expect(f.estimatedDailyLoss).toBeNull();
    expect(f.breakEven).toBeNull();
    expect(f.explanation).toContain('Add your product costs');
  });
  it('uses generic bands when the contribution is zero or negative', () => {
    expect(classifyAd({ days: week(8, 7000, 7000), contributionBeforeAds: 0 }).usedGenericBands).toBe(true);
    expect(classifyAd({ days: week(8, 7000, 7000), contributionBeforeAds: -300 }).usedGenericBands).toBe(true);
  });
  it('still never calls a low-data ad losing', () => {
    expect(classifyAd({ days: week(8, 100, 0), contributionBeforeAds: null }).code).toBe('learning');
  });
});

describe('classifyAd input handling', () => {
  it('sorts days by date', () => {
    const forward = classifyAd({ days: week(8, 7000, 14000), contributionBeforeAds: 4000 });
    const reversed = classifyAd({ days: [...week(8, 7000, 14000)].reverse(), contributionBeforeAds: 4000 });
    expect(reversed).toEqual(forward);
  });
  it('rejects mixed currencies, negative spend and bad counts', () => {
    expect(() => classifyAd({ days: [day(1), day(2, { spend: money(1, 'EUR') })], contributionBeforeAds: 4000 })).toThrow(/currency mismatch/);
    expect(() => classifyAd({ days: [day(1, { spend: money(-1) })], contributionBeforeAds: 4000 })).toThrow(RangeError);
    expect(() => classifyAd({ days: [day(1, { impressions: -1 })], contributionBeforeAds: 4000 })).toThrow(RangeError);
    expect(() => classifyAd({ days: [day(1)], contributionBeforeAds: 40.5 })).toThrow(RangeError);
  });
  it('reports its facts', () => {
    const f = classifyAd({ days: week(8, 7000, 14000), contributionBeforeAds: 4000 });
    expect(f.facts).toMatchObject({
      currency: 'USD', daysUsed: 7, spend: money(7000), revenue: money(14000), impressions: 3500, contributionBeforeAds: 4000,
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm turbo run test --filter=@erq/metrics`
Expected: the new tests FAIL (`classifyAd` is not exported).

- [ ] **Step 3: Implement**

In `packages/metrics/src/ads.ts` change the imports to:

```ts
import { formatMoney, money, type Money } from '@erq/shared';
import { bigRatioToBps, divRound, toSafeInteger, type Bps } from './bps';
```

Append:

```ts
export interface AdDay {
  /** YYYY-MM-DD, already bucketed in the org timezone by the caller. */
  date: string;
  spend: Money;
  impressions: number;
  clicks: number;
  conversions: number;
  /** Platform-reported revenue. */
  revenue: Money;
}

export interface AdFlagConfig {
  /** Interpreted in the currency of the days. */
  minSpendCents: number;
  minImpressions: number;
  winningMultiple: number;
  declineThreshold: Bps;
  genericBands: { poor: number; good: number };
}

export const DEFAULT_AD_FLAG_CONFIG: AdFlagConfig = {
  minSpendCents: 5000,
  minImpressions: 1000,
  winningMultiple: 1.5,
  declineThreshold: 2000,
  genericBands: { poor: 1.5, good: 3 },
};

export type AdFlagCode = 'learning' | 'losing' | 'watch' | 'winning';

export interface AdFlag {
  code: AdFlagCode;
  roas: number | null;
  breakEven: number | null;
  /** Week-over-week change in ROAS, null unless two full weeks of data exist. */
  trend: Bps | null;
  /** Spend minus what the revenue earns at the contribution margin, per day. Only for losing ads with cost data. */
  estimatedDailyLoss: Money | null;
  usedGenericBands: boolean;
  facts: {
    currency: string;
    daysUsed: number;
    spend: Money;
    revenue: Money;
    impressions: number;
    conversions: number;
    contributionBeforeAds: Bps | null;
  };
  explanation: string;
}

function validateDay(day: AdDay, currency: string): void {
  if (day.spend.currency !== currency || day.revenue.currency !== currency) {
    throw new Error(`currency mismatch: ${day.spend.currency}/${day.revenue.currency} vs ${currency}`);
  }
  if (day.spend.cents < 0 || day.revenue.cents < 0) throw new RangeError('spend and revenue cannot be negative');
  for (const [name, value] of [['impressions', day.impressions], ['clicks', day.clicks], ['conversions', day.conversions]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer, got ${value}`);
  }
}

function aggregate(days: AdDay[]): { spend: number; revenue: number; impressions: number; conversions: number } {
  return days.reduce(
    (acc, d) => ({
      spend: acc.spend + d.spend.cents,
      revenue: acc.revenue + d.revenue.cents,
      impressions: acc.impressions + d.impressions,
      conversions: acc.conversions + d.conversions,
    }),
    { spend: 0, revenue: 0, impressions: 0, conversions: 0 },
  );
}

const fmt = (n: number): string => n.toFixed(2);

export function classifyAd(
  input: { days: AdDay[]; contributionBeforeAds: Bps | null },
  config: Partial<AdFlagConfig> = {},
): AdFlag {
  const cfg: AdFlagConfig = {
    ...DEFAULT_AD_FLAG_CONFIG,
    ...config,
    genericBands: { ...DEFAULT_AD_FLAG_CONFIG.genericBands, ...config.genericBands },
  };
  const c = input.contributionBeforeAds;
  if (c !== null && !Number.isSafeInteger(c)) {
    throw new RangeError(`contributionBeforeAds must be an integer in basis points, got ${c}`);
  }

  const sorted = [...input.days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const currency = sorted[0]?.spend.currency ?? 'USD';
  sorted.forEach((d) => validateDay(d, currency));

  const recent = sorted.slice(-7);
  const previous = sorted.slice(-14, -7);
  const r = aggregate(recent);
  const facts: AdFlag['facts'] = {
    currency,
    daysUsed: recent.length,
    spend: money(r.spend, currency),
    revenue: money(r.revenue, currency),
    impressions: r.impressions,
    conversions: r.conversions,
    contributionBeforeAds: c,
  };
  const days = recent.length;
  const useGeneric = c === null || c <= 0;
  const breakEven = useGeneric ? null : breakEvenRoas(c);
  const roasValue = roas(facts.revenue, facts.spend);

  // Learning: never judged, never flagged losing.
  if (r.spend === 0 || r.spend < cfg.minSpendCents || r.impressions < cfg.minImpressions) {
    return {
      code: 'learning', roas: roasValue, breakEven, trend: null, estimatedDailyLoss: null, usedGenericBands: false, facts,
      explanation:
        `Not enough data yet: in the last ${days} day${days === 1 ? '' : 's'} this ad spent ${formatMoney(facts.spend)} ` +
        `and had ${r.impressions} impressions. We wait for at least ${formatMoney(money(cfg.minSpendCents, currency))} ` +
        `and ${cfg.minImpressions} impressions before judging it.`,
    };
  }

  const R = BigInt(r.revenue);
  const S = BigInt(r.spend);

  // Week-over-week change in ROAS: (R1/S1) / (R0/S0) - 1 = (R1*S0 - R0*S1) / (R0*S1).
  let trend: Bps | null = null;
  if (recent.length === 7 && previous.length === 7) {
    const p = aggregate(previous);
    if (p.spend > 0 && p.revenue > 0) {
      const R0 = BigInt(p.revenue);
      const S0 = BigInt(p.spend);
      trend = bigRatioToBps(R * S0 - R0 * S, R0 * S);
    }
  }
  const declining = trend !== null && trend < -cfg.declineThreshold;
  const asBps = (x: number): bigint => BigInt(Math.round(x * 10000));

  if (useGeneric) {
    const poor = asBps(cfg.genericBands.poor);
    const good = asBps(cfg.genericBands.good);
    const scaled = R * 10000n;
    const roasText = fmt(Number(roasValue));
    if (scaled < poor * S) {
      return {
        code: 'losing', roas: roasValue, breakEven: null, trend, estimatedDailyLoss: null, usedGenericBands: true, facts,
        explanation: `This ad returns only $${roasText} for every $1.00 spent, which is poor. Add your product costs so we can calculate your exact break-even point.`,
      };
    }
    if (scaled <= good * S) {
      return {
        code: 'watch', roas: roasValue, breakEven: null, trend, estimatedDailyLoss: null, usedGenericBands: true, facts,
        explanation: `This ad returns $${roasText} for every $1.00 spent, which is average. Add your product costs so we can calculate your exact break-even point.`,
      };
    }
    return {
      code: 'winning', roas: roasValue, breakEven: null, trend, estimatedDailyLoss: null, usedGenericBands: true, facts,
      explanation: `This ad returns $${roasText} for every $1.00 spent, which is good. Add your product costs so we can confirm it is profitable.`,
    };
  }

  const cBig = BigInt(c);
  const roasText = fmt(Number(roasValue));
  const beText = fmt(Number(breakEven));
  const earned = R * cBig; // revenue scaled by the contribution margin (x10000)

  if (earned < 10000n * S) {
    const loss = toSafeInteger(divRound(S * 10000n - earned, 10000n * BigInt(days)));
    const estimatedDailyLoss = money(loss, currency);
    return {
      code: 'losing', roas: roasValue, breakEven, trend, estimatedDailyLoss, usedGenericBands: false, facts,
      explanation:
        `Pause or fix this ad. It returned $${roasText} for every $1.00 spent over the last ${days} day${days === 1 ? '' : 's'}, ` +
        `but you need $${beText} to break even. Estimated loss: about ${formatMoney(estimatedDailyLoss)} per day.`,
    };
  }
  // ROAS >= winningMultiple x break-even  <=>  revenue x contribution >= multiple(bps) x spend.
  if (earned < asBps(cfg.winningMultiple) * S || declining) {
    const winningRoas = fmt(Number(breakEven) * cfg.winningMultiple);
    return {
      code: 'watch', roas: roasValue, breakEven, trend, estimatedDailyLoss: null, usedGenericBands: false, facts,
      explanation: declining
        ? `Keep an eye on this ad. Its return dropped ${Math.abs(Math.round(Number(trend) / 100))}% compared with the week before ($${roasText} per $1.00 now).`
        : `Keep an eye on this ad. It is above break-even ($${beText}) but below the $${winningRoas} level where we call it winning.`,
    };
  }
  return {
    code: 'winning', roas: roasValue, breakEven, trend, estimatedDailyLoss: null, usedGenericBands: false, facts,
    explanation: `Scale this ad. It returns $${roasText} for every $1.00 spent, well above the $${beText} you need to break even.`,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm turbo run test typecheck build --filter=@erq/metrics` then `pnpm lint`
Expected: PASS. Hand-check one boundary if anything fails: for contribution 4000 bps and spend 7000, revenue 17500 gives `R*c = 70,000,000 = 10000*S`, so it is not losing; revenue 26250 gives `R*c = 105,000,000 = 15000*S`, so it is winning.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(metrics): add ad flags (learning, losing, watch, winning) with generic-band fallback"
```

---

### Task 6: `inventory.ts`

**Files:**
- Create: `packages/metrics/src/inventory.ts`
- Modify: `packages/metrics/src/index.ts` (add `export * from './inventory';`)
- Test: `packages/metrics/test/inventory.test.ts`

**Interfaces:**
- Produces: `DEFAULT_BUFFER_DAYS = 7`, `UNKNOWN_LEAD_TIME_DAYS = 14`, `DEFAULT_OVERSTOCK_DAYS = 180`, `VelocityWeights`, `salesVelocity(input)`, `daysOfCover(available, velocity)`, `StockFlag`, `StockFlags`, `stockFlags(input)`, `stockByLocation(levels)`.

- [ ] **Step 1: Write the failing tests**

`packages/metrics/test/inventory.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { daysOfCover, salesVelocity, stockByLocation, stockFlags } from '../src/inventory';

describe('salesVelocity', () => {
  it('weights recent windows more (50/30/20)', () => {
    expect(salesVelocity({ units7: 14, units30: 30, units90: 90 })).toBeCloseTo(1.5, 10);
  });
  it('is zero with no sales', () => {
    expect(salesVelocity({ units7: 0, units30: 0, units90: 0 })).toBe(0);
  });
  it('honours custom weights', () => {
    expect(salesVelocity({ units7: 14, units30: 0, units90: 0, weights: { w7: 1, w30: 0, w90: 0 } })).toBe(2);
  });
  it('rejects weights that do not sum to 1, negative weights and negative units', () => {
    expect(() => salesVelocity({ units7: 1, units30: 1, units90: 1, weights: { w7: 0.5, w30: 0.5, w90: 0.5 } })).toThrow(RangeError);
    expect(() => salesVelocity({ units7: 1, units30: 1, units90: 1, weights: { w7: 1.5, w30: -0.5, w90: 0 } })).toThrow(RangeError);
    expect(() => salesVelocity({ units7: -1, units30: 0, units90: 0 })).toThrow(RangeError);
    expect(() => salesVelocity({ units7: Number.NaN, units30: 0, units90: 0 })).toThrow(RangeError);
  });
});

describe('daysOfCover', () => {
  it('divides available stock by velocity', () => {
    expect(daysOfCover(30, 1.5)).toBeCloseTo(20, 10);
    expect(daysOfCover(0, 2)).toBe(0);
  });
  it('is null (not Infinity) when nothing sells', () => {
    expect(daysOfCover(10, 0)).toBeNull();
    expect(daysOfCover(0, 0)).toBeNull();
  });
  it('rejects negative stock or velocity', () => {
    expect(() => daysOfCover(-1, 1)).toThrow(RangeError);
    expect(() => daysOfCover(1, -1)).toThrow(RangeError);
  });
});

describe('stockFlags: low stock', () => {
  it('fires when days of cover are below lead time plus the default 7-day buffer', () => {
    // lead 21 + buffer 7 = 28 days
    const low = stockFlags({ available: 27, velocity: 1, unitsSold90: 90, leadTimeDays: 21 });
    expect(low.low.fired).toBe(true);
    expect(low.low.explanation).toContain('27 days');
    expect(stockFlags({ available: 28, velocity: 1, unitsSold90: 90, leadTimeDays: 21 }).low.fired).toBe(false);
  });
  it('uses 14 days in total when the lead time is unknown', () => {
    expect(stockFlags({ available: 13, velocity: 1, unitsSold90: 90 }).low.fired).toBe(true);
    expect(stockFlags({ available: 14, velocity: 1, unitsSold90: 90 }).low.fired).toBe(false);
  });
  it('honours an explicit buffer', () => {
    expect(stockFlags({ available: 9, velocity: 1, unitsSold90: 90, leadTimeDays: 10, bufferDays: 0 }).low.fired).toBe(true);
    expect(stockFlags({ available: 10, velocity: 1, unitsSold90: 90, leadTimeDays: 10, bufferDays: 0 }).low.fired).toBe(false);
  });
  it('fires at or below the reorder point even with plenty of cover', () => {
    const f = stockFlags({ available: 5, velocity: 0.1, unitsSold90: 9, reorderPoint: 5 });
    expect(f.low.fired).toBe(true);
    expect(f.low.explanation).toContain('reorder point');
    expect(stockFlags({ available: 6, velocity: 0.1, unitsSold90: 9, reorderPoint: 5 }).low.fired).toBe(false);
  });
  it('fires when out of stock but selling', () => {
    expect(stockFlags({ available: 0, velocity: 2, unitsSold90: 100 }).low.fired).toBe(true);
  });
  it('does not fire for zero stock and zero sales', () => {
    const f = stockFlags({ available: 0, velocity: 0, unitsSold90: 0 });
    expect(f.low.fired).toBe(false);
    expect(f.overstock.fired).toBe(false);
    expect(f.dead.fired).toBe(false);
  });
});

describe('stockFlags: overstock and dead stock', () => {
  it('fires overstock above 180 days of cover, not at exactly 180', () => {
    expect(stockFlags({ available: 181, velocity: 1, unitsSold90: 90 }).overstock.fired).toBe(true);
    expect(stockFlags({ available: 180, velocity: 1, unitsSold90: 90 }).overstock.fired).toBe(false);
  });
  it('does not call zero-velocity stock overstock (it is dead stock)', () => {
    const f = stockFlags({ available: 500, velocity: 0, unitsSold90: 0 });
    expect(f.overstock.fired).toBe(false);
    expect(f.dead.fired).toBe(true);
  });
  it('honours a custom overstock threshold', () => {
    expect(stockFlags({ available: 91, velocity: 1, unitsSold90: 90, overstockDays: 90 }).overstock.fired).toBe(true);
  });
  it('fires dead stock only with stock on hand and no sales in 90 days', () => {
    const dead = stockFlags({ available: 10, velocity: 0, unitsSold90: 0 });
    expect(dead.dead.fired).toBe(true);
    expect(dead.dead.explanation).toContain('no sales in 90 days');
    expect(stockFlags({ available: 10, velocity: 0.01, unitsSold90: 1 }).dead.fired).toBe(false);
  });
  it('rejects invalid input', () => {
    expect(() => stockFlags({ available: -1, velocity: 1, unitsSold90: 1 })).toThrow(RangeError);
    expect(() => stockFlags({ available: 1, velocity: -1, unitsSold90: 1 })).toThrow(RangeError);
    expect(() => stockFlags({ available: 1, velocity: 1, unitsSold90: -1 })).toThrow(RangeError);
  });
});

describe('stockByLocation', () => {
  it('subtracts reserved stock per location and totals it', () => {
    const r = stockByLocation([
      { locationId: 'A', onHand: 10, reserved: 3 },
      { locationId: 'B', onHand: 5, reserved: 8 },
    ]);
    expect(r.byLocation).toEqual([{ locationId: 'A', available: 7 }, { locationId: 'B', available: 0 }]);
    expect(r.totalAvailable).toBe(7);
  });
  it('handles no locations', () => {
    expect(stockByLocation([])).toEqual({ byLocation: [], totalAvailable: 0 });
  });
  it('rejects negative quantities', () => {
    expect(() => stockByLocation([{ locationId: 'A', onHand: -1, reserved: 0 }])).toThrow(RangeError);
    expect(() => stockByLocation([{ locationId: 'A', onHand: 1, reserved: -1 }])).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm turbo run test --filter=@erq/metrics`
Expected: FAIL, cannot resolve `../src/inventory`.

- [ ] **Step 3: Implement**

`packages/metrics/src/inventory.ts`:

```ts
export const DEFAULT_BUFFER_DAYS = 7;
/** Used instead of lead time plus buffer when the supplier lead time is unknown (CLAUDE.md §7.2). */
export const UNKNOWN_LEAD_TIME_DAYS = 14;
export const DEFAULT_OVERSTOCK_DAYS = 180;

export interface VelocityWeights {
  w7: number;
  w30: number;
  w90: number;
}
const DEFAULT_WEIGHTS: VelocityWeights = { w7: 0.5, w30: 0.3, w90: 0.2 };

function assertNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a non-negative number, got ${value}`);
}

/** Weighted average of units per day over the trailing 7, 30 and 90 days. */
export function salesVelocity(input: { units7: number; units30: number; units90: number; weights?: VelocityWeights }): number {
  const weights = input.weights ?? DEFAULT_WEIGHTS;
  assertNonNegative('units7', input.units7);
  assertNonNegative('units30', input.units30);
  assertNonNegative('units90', input.units90);
  assertNonNegative('w7', weights.w7);
  assertNonNegative('w30', weights.w30);
  assertNonNegative('w90', weights.w90);
  if (Math.abs(weights.w7 + weights.w30 + weights.w90 - 1) > 1e-9) {
    throw new RangeError('velocity weights must sum to 1');
  }
  return weights.w7 * (input.units7 / 7) + weights.w30 * (input.units30 / 30) + weights.w90 * (input.units90 / 90);
}

/** Available stock divided by daily velocity. Null when nothing sells. */
export function daysOfCover(available: number, velocity: number): number | null {
  assertNonNegative('available', available);
  assertNonNegative('velocity', velocity);
  if (velocity === 0) return null;
  return available / velocity;
}

export interface StockFlag {
  fired: boolean;
  explanation: string;
}
export interface StockFlags {
  low: StockFlag;
  overstock: StockFlag;
  dead: StockFlag;
}

export function stockFlags(input: {
  available: number;
  velocity: number;
  unitsSold90: number;
  reorderPoint?: number;
  leadTimeDays?: number;
  bufferDays?: number;
  overstockDays?: number;
}): StockFlags {
  assertNonNegative('unitsSold90', input.unitsSold90);
  const cover = daysOfCover(input.available, input.velocity);
  const threshold =
    input.leadTimeDays === undefined ? UNKNOWN_LEAD_TIME_DAYS : input.leadTimeDays + (input.bufferDays ?? DEFAULT_BUFFER_DAYS);
  const overstockDays = input.overstockDays ?? DEFAULT_OVERSTOCK_DAYS;

  const belowCover = cover !== null && cover < threshold;
  const atReorderPoint = input.reorderPoint !== undefined && input.available <= input.reorderPoint;
  let low: StockFlag;
  if (atReorderPoint) {
    low = {
      fired: true,
      explanation: `Running low: ${input.available} left, at or below your reorder point of ${input.reorderPoint}. Reorder now.`,
    };
  } else if (belowCover) {
    low = {
      fired: true,
      explanation: `Running low: about ${Math.floor(cover)} days of stock left, and you need ${threshold} days to restock safely. Reorder now.`,
    };
  } else {
    low = { fired: false, explanation: 'Stock level is fine.' };
  }

  const overstock: StockFlag =
    cover !== null && cover > overstockDays
      ? { fired: true, explanation: `Overstocked: about ${Math.floor(cover)} days of stock on hand, more than ${overstockDays}. Consider a promotion and hold off reordering.` }
      : { fired: false, explanation: 'Not overstocked.' };

  const dead: StockFlag =
    input.unitsSold90 === 0 && input.available > 0
      ? { fired: true, explanation: `Dead stock: ${input.available} on hand and no sales in 90 days. Consider a discount or bundle to clear it.` }
      : { fired: false, explanation: 'Selling normally or out of stock.' };

  return { low, overstock, dead };
}

export function stockByLocation(
  levels: { locationId: string; onHand: number; reserved: number }[],
): { byLocation: { locationId: string; available: number }[]; totalAvailable: number } {
  const byLocation = levels.map((l) => {
    assertNonNegative('onHand', l.onHand);
    assertNonNegative('reserved', l.reserved);
    return { locationId: l.locationId, available: Math.max(0, l.onHand - l.reserved) };
  });
  return { byLocation, totalAvailable: byLocation.reduce((total, l) => total + l.available, 0) };
}
```

Note: `stockFlags` calls `daysOfCover`, which also validates `available` and `velocity`, so negative values throw `RangeError` as the tests expect.

Append `export * from './inventory';` to `packages/metrics/src/index.ts`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm turbo run test typecheck build --filter=@erq/metrics` then `pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(metrics): add sales velocity, days of cover and stock flags"
```

### Task 7: `pnl.ts` part 1: `buildPnl`

**Files:**
- Create: `packages/metrics/src/pnl.ts`
- Modify: `packages/metrics/src/index.ts` (add `export * from './pnl';`)
- Test: `packages/metrics/test/pnl.test.ts`

**Interfaces:**
- Consumes: `moneyRatioBps`, `Bps` from `./bps`; `add`, `money`, `subtract`, `sum`, `Money` from `@erq/shared`.
- Produces: `PnlInput`, `PnlMargins`, `Pnl`, `buildPnl(input: PnlInput): Pnl`. Task 8 adds `sumPnl` and `comparePnl` using the internal `assemble` function exported from this file.

- [ ] **Step 1: Write the failing tests**

`packages/metrics/test/pnl.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { money } from '@erq/shared';
import { buildPnl, type PnlInput } from '../src/pnl';

const input = (over: Partial<PnlInput> = {}): PnlInput => ({
  currency: 'USD',
  grossSales: money(100000), discounts: money(5000), refunds: money(3000), cogs: money(40000),
  shipping: money(6000), pickPack: money(2000), paymentFees: money(3000), marketplaceFees: money(1000),
  adSpendByPlatform: { meta: money(15000), google: money(5000) },
  otherOpex: money(12000),
  ...over,
});

describe('buildPnl: the CLAUDE.md §7.6 structure', () => {
  const p = buildPnl(input());
  it('computes every line in order', () => {
    expect(p.netSales).toEqual(money(92000));
    expect(p.cogs).toEqual(money(40000));
    expect(p.grossProfit).toEqual(money(52000));
    expect(p.fulfillment).toEqual(money(8000));
    expect(p.contributionMargin).toEqual(money(40000));
    expect(p.adSpend.total).toEqual(money(20000));
    expect(p.adSpend.byPlatform).toEqual({ meta: money(15000), google: money(5000) });
    expect(p.netContributionAfterMarketing).toEqual(money(20000));
    expect(p.estimatedOperatingProfit).toEqual(money(8000));
    expect(p.cogsComplete).toBe(true);
  });
  it('reports each profit line as basis points of net sales', () => {
    expect(p.marginsBps).toEqual({
      grossProfit: 5652, contributionMargin: 4348, netContributionAfterMarketing: 2174, estimatedOperatingProfit: 870,
    });
  });
  it('does not alias the input platform map', () => {
    const map = { meta: money(1) };
    const q = buildPnl(input({ adSpendByPlatform: map }));
    map.meta = money(999);
    expect(q.adSpend.byPlatform.meta).toEqual(money(1));
  });
});

describe('buildPnl: edge cases', () => {
  it('lets net sales go negative when refunds exceed sales, and gives null margins', () => {
    const p = buildPnl(input({
      grossSales: money(1000), discounts: money(0), refunds: money(1500), cogs: money(0),
      shipping: money(0), pickPack: money(0), paymentFees: money(0), marketplaceFees: money(0),
      adSpendByPlatform: {}, otherOpex: money(0),
    }));
    expect(p.netSales).toEqual(money(-500));
    expect(p.estimatedOperatingProfit).toEqual(money(-500));
    expect(p.marginsBps).toEqual({
      grossProfit: null, contributionMargin: null, netContributionAfterMarketing: null, estimatedOperatingProfit: null,
    });
  });
  it('marks profit as incomplete when COGS is missing, and counts COGS as zero', () => {
    const p = buildPnl(input({ cogs: null }));
    expect(p.cogsComplete).toBe(false);
    expect(p.cogs).toEqual(money(0));
    expect(p.grossProfit).toEqual(money(92000));
  });
  it('handles an all-zero period', () => {
    const zero = money(0);
    const p = buildPnl({
      currency: 'USD', grossSales: zero, discounts: zero, refunds: zero, cogs: zero, shipping: zero, pickPack: zero,
      paymentFees: zero, marketplaceFees: zero, adSpendByPlatform: {}, otherOpex: zero,
    });
    expect(p.netSales).toEqual(zero);
    expect(p.adSpend.total).toEqual(zero);
    expect(p.marginsBps.grossProfit).toBeNull();
  });
  it('shows a loss as negative profit with a negative margin', () => {
    const p = buildPnl(input({ otherOpex: money(50000) }));
    expect(p.estimatedOperatingProfit).toEqual(money(-30000));
    expect(p.marginsBps.estimatedOperatingProfit).toBe(-3261);
  });
  it('rejects mixed currencies and negative inputs', () => {
    expect(() => buildPnl(input({ refunds: money(1, 'EUR') }))).toThrow(/currency mismatch/);
    expect(() => buildPnl(input({ adSpendByPlatform: { meta: money(1, 'EUR') } }))).toThrow(/currency mismatch/);
    expect(() => buildPnl(input({ cogs: money(1, 'EUR') }))).toThrow(/currency mismatch/);
    expect(() => buildPnl(input({ discounts: money(-1) }))).toThrow(RangeError);
    expect(() => buildPnl(input({ shipping: money(-1) }))).toThrow(RangeError);
  });
});

describe('buildPnl: identities hold across a grid of inputs', () => {
  const grosses = [0, 1000, 100000];
  const discountList = [0, 500];
  const refundList = [0, 300, 2000];
  const cogsList: (number | null)[] = [null, 0, 400];
  for (const g of grosses) {
    for (const d of discountList) {
      for (const r of refundList) {
        for (const c of cogsList) {
          it(`gross ${g}, discounts ${d}, refunds ${r}, cogs ${c}`, () => {
            const p = buildPnl(input({
              grossSales: money(g), discounts: money(d), refunds: money(r), cogs: c === null ? null : money(c),
            }));
            expect(p.netSales.cents).toBe(g - d - r);
            expect(p.grossProfit.cents).toBe(p.netSales.cents - p.cogs.cents);
            expect(p.contributionMargin.cents).toBe(p.grossProfit.cents - p.fulfillment.cents - p.paymentFees.cents - p.marketplaceFees.cents);
            expect(p.netContributionAfterMarketing.cents).toBe(p.contributionMargin.cents - p.adSpend.total.cents);
            expect(p.estimatedOperatingProfit.cents).toBe(p.netContributionAfterMarketing.cents - p.otherOpex.cents);
          });
        }
      }
    }
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm turbo run test --filter=@erq/metrics`
Expected: FAIL, cannot resolve `../src/pnl`.

- [ ] **Step 3: Implement**

`packages/metrics/src/pnl.ts`:

```ts
import { add, money, subtract, sum, type Money } from '@erq/shared';
import { moneyRatioBps, type Bps } from './bps';

export interface PnlInput {
  currency: string;
  grossSales: Money;
  discounts: Money;
  refunds: Money;
  /** Landed cost of units sold. Null means COGS data is missing. */
  cogs: Money | null;
  shipping: Money;
  pickPack: Money;
  paymentFees: Money;
  marketplaceFees: Money;
  adSpendByPlatform: Record<string, Money>;
  otherOpex: Money;
}

export interface PnlMargins {
  grossProfit: Bps | null;
  contributionMargin: Bps | null;
  netContributionAfterMarketing: Bps | null;
  estimatedOperatingProfit: Bps | null;
}

export interface Pnl {
  currency: string;
  grossSales: Money;
  discounts: Money;
  refunds: Money;
  netSales: Money;
  cogs: Money;
  grossProfit: Money;
  shipping: Money;
  pickPack: Money;
  fulfillment: Money;
  paymentFees: Money;
  marketplaceFees: Money;
  contributionMargin: Money;
  adSpend: { total: Money; byPlatform: Record<string, Money> };
  netContributionAfterMarketing: Money;
  otherOpex: Money;
  estimatedOperatingProfit: Money;
  /** False when COGS was missing: profit lines are estimates that ignore cost of goods. */
  cogsComplete: boolean;
  /** Each profit line as a share of net sales; null when net sales are not positive. */
  marginsBps: PnlMargins;
}

/** The additive lines a P&L is built from. */
export interface PnlBase {
  currency: string;
  grossSales: Money;
  discounts: Money;
  refunds: Money;
  cogs: Money;
  shipping: Money;
  pickPack: Money;
  paymentFees: Money;
  marketplaceFees: Money;
  adSpendByPlatform: Record<string, Money>;
  otherOpex: Money;
}

export function assemble(base: PnlBase, cogsComplete: boolean): Pnl {
  const { currency } = base;
  const netSales = subtract(subtract(base.grossSales, base.discounts), base.refunds);
  const grossProfit = subtract(netSales, base.cogs);
  const fulfillment = add(base.shipping, base.pickPack);
  const contributionMargin = subtract(subtract(subtract(grossProfit, fulfillment), base.paymentFees), base.marketplaceFees);
  const byPlatform = { ...base.adSpendByPlatform };
  const adTotal = sum(Object.values(byPlatform), currency);
  const netContributionAfterMarketing = subtract(contributionMargin, adTotal);
  const estimatedOperatingProfit = subtract(netContributionAfterMarketing, base.otherOpex);

  const share = (line: Money): Bps | null => (netSales.cents > 0 ? moneyRatioBps(line, netSales) : null);
  return {
    currency,
    grossSales: base.grossSales,
    discounts: base.discounts,
    refunds: base.refunds,
    netSales,
    cogs: base.cogs,
    grossProfit,
    shipping: base.shipping,
    pickPack: base.pickPack,
    fulfillment,
    paymentFees: base.paymentFees,
    marketplaceFees: base.marketplaceFees,
    contributionMargin,
    adSpend: { total: adTotal, byPlatform },
    netContributionAfterMarketing,
    otherOpex: base.otherOpex,
    estimatedOperatingProfit,
    cogsComplete,
    marginsBps: {
      grossProfit: share(grossProfit),
      contributionMargin: share(contributionMargin),
      netContributionAfterMarketing: share(netContributionAfterMarketing),
      estimatedOperatingProfit: share(estimatedOperatingProfit),
    },
  };
}

function checked(name: string, value: Money, currency: string): Money {
  if (value.currency !== currency) throw new Error(`currency mismatch: ${name} is ${value.currency}, expected ${currency}`);
  if (value.cents < 0) throw new RangeError(`${name} cannot be negative`);
  return value;
}

export function buildPnl(input: PnlInput): Pnl {
  const { currency } = input;
  const adSpendByPlatform: Record<string, Money> = {};
  for (const [platform, spend] of Object.entries(input.adSpendByPlatform)) {
    adSpendByPlatform[platform] = checked(`adSpend.${platform}`, spend, currency);
  }
  return assemble(
    {
      currency,
      grossSales: checked('grossSales', input.grossSales, currency),
      discounts: checked('discounts', input.discounts, currency),
      refunds: checked('refunds', input.refunds, currency),
      cogs: input.cogs === null ? money(0, currency) : checked('cogs', input.cogs, currency),
      shipping: checked('shipping', input.shipping, currency),
      pickPack: checked('pickPack', input.pickPack, currency),
      paymentFees: checked('paymentFees', input.paymentFees, currency),
      marketplaceFees: checked('marketplaceFees', input.marketplaceFees, currency),
      adSpendByPlatform,
      otherOpex: checked('otherOpex', input.otherOpex, currency),
    },
    input.cogs !== null,
  );
}
```

Append `export * from './pnl';` to `packages/metrics/src/index.ts`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm turbo run test typecheck build --filter=@erq/metrics` then `pnpm lint`
Expected: PASS. (Margin check: 8000 / 92000 = 869.57 -> 870; -30000 / 92000 = -3260.87 -> -3261.)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(metrics): add monthly P&L builder with margins and missing-COGS marker"
```

---

### Task 8: `pnl.ts` part 2: `sumPnl` and `comparePnl`

**Files:**
- Modify: `packages/metrics/src/pnl.ts`
- Modify: `packages/metrics/test/pnl.test.ts` (append)

**Interfaces:**
- Consumes: `assemble`, `Pnl` from this file; `bigRatioToBps` from `./bps`.
- Produces: `sumPnl(items: Pnl[], currency: string): Pnl`, `PnlLineName`, `LineComparison`, `PnlComparison`, `comparePnl(current: Pnl, previous: Pnl): PnlComparison`.

- [ ] **Step 1: Write the failing tests**

Update the import in `packages/metrics/test/pnl.test.ts` to `import { buildPnl, comparePnl, sumPnl, type PnlInput } from '../src/pnl';` and append:

```ts
describe('sumPnl (breakdowns)', () => {
  const a = buildPnl(input());
  const b = buildPnl(input({
    grossSales: money(50000), cogs: null, adSpendByPlatform: { meta: money(1000), tiktok: money(2000) },
  }));
  it('adds every line and merges platform ad spend by key', () => {
    const s = sumPnl([a, b], 'USD');
    expect(s.grossSales).toEqual(money(150000));
    expect(s.netSales).toEqual(money(a.netSales.cents + b.netSales.cents));
    expect(s.estimatedOperatingProfit).toEqual(money(a.estimatedOperatingProfit.cents + b.estimatedOperatingProfit.cents));
    expect(s.adSpend.byPlatform).toEqual({ meta: money(16000), google: money(5000), tiktok: money(2000) });
    expect(s.adSpend.total).toEqual(money(23000));
  });
  it('is incomplete when any input is incomplete', () => {
    expect(sumPnl([a, b], 'USD').cogsComplete).toBe(false);
    expect(sumPnl([a, a], 'USD').cogsComplete).toBe(true);
  });
  it('returns the single item unchanged', () => {
    expect(sumPnl([a], 'USD')).toEqual(a);
  });
  it('returns an all-zero, complete P&L for no items', () => {
    const s = sumPnl([], 'USD');
    expect(s.netSales).toEqual(money(0));
    expect(s.cogsComplete).toBe(true);
    expect(s.adSpend.byPlatform).toEqual({});
  });
  it('recomputes margins from the summed lines', () => {
    const s = sumPnl([a, a], 'USD');
    expect(s.marginsBps).toEqual(a.marginsBps);
  });
  it('rejects a P&L in another currency', () => {
    const eur = buildPnl({ ...input(), currency: 'EUR',
      grossSales: money(1, 'EUR'), discounts: money(0, 'EUR'), refunds: money(0, 'EUR'), cogs: money(0, 'EUR'),
      shipping: money(0, 'EUR'), pickPack: money(0, 'EUR'), paymentFees: money(0, 'EUR'), marketplaceFees: money(0, 'EUR'),
      adSpendByPlatform: {}, otherOpex: money(0, 'EUR') });
    expect(() => sumPnl([a, eur], 'USD')).toThrow(/currency mismatch/);
  });
});

describe('comparePnl', () => {
  const previous = buildPnl(input({ grossSales: money(88000) })); // net 80000
  const current = buildPnl(input());                              // net 92000
  it('gives the change in money and basis points for every line', () => {
    const c = comparePnl(current, previous);
    expect(c.netSales).toEqual({ current: money(92000), previous: money(80000), change: money(12000), changeBps: 1500 });
    expect(c.adSpend.change).toEqual(money(0));
    expect(c.adSpend.changeBps).toBe(0);
    expect(Object.keys(c).sort()).toEqual([
      'adSpend', 'cogs', 'contributionMargin', 'discounts', 'estimatedOperatingProfit', 'fulfillment', 'grossProfit',
      'grossSales', 'marketplaceFees', 'netContributionAfterMarketing', 'netSales', 'otherOpex', 'paymentFees', 'refunds',
    ]);
  });
  it('shows a decrease as negative basis points', () => {
    const c = comparePnl(previous, current);
    expect(c.netSales.change).toEqual(money(-12000));
    expect(c.netSales.changeBps).toBe(-1304);
  });
  it('has null basis points when the previous value is zero', () => {
    const none = buildPnl(input({ discounts: money(0) }));
    const c = comparePnl(current, none);
    expect(c.discounts.changeBps).toBeNull();
    expect(c.discounts.change).toEqual(money(5000));
  });
  it('measures change against the size of a negative previous value', () => {
    const loss = buildPnl(input({ grossSales: money(8500), cogs: money(0) })); // net 500, op profit well below zero
    const gain = buildPnl(input({ grossSales: money(9500), cogs: money(0) })); // net 1500
    expect(comparePnl(gain, loss).netSales.changeBps).toBe(20000);
    const negPrev = buildPnl(input({ grossSales: money(7500), cogs: money(0) })); // net -500
    const c = comparePnl(loss, negPrev);
    expect(c.netSales.previous).toEqual(money(-500));
    expect(c.netSales.change).toEqual(money(1000));
    expect(c.netSales.changeBps).toBe(20000);
  });
  it('rejects different currencies', () => {
    const eurZero = money(0, 'EUR');
    const eur = buildPnl({
      currency: 'EUR', grossSales: eurZero, discounts: eurZero, refunds: eurZero, cogs: eurZero, shipping: eurZero,
      pickPack: eurZero, paymentFees: eurZero, marketplaceFees: eurZero, adSpendByPlatform: {}, otherOpex: eurZero,
    });
    expect(() => comparePnl(current, eur)).toThrow(/currency mismatch/);
  });
});
```

(Hand check: net 92000 vs 80000 -> +12000 / 80000 = 15.00% = 1500 bps; reverse: -12000 / 92000 = -13.04% = -1304 bps; 500 -> 1500: +1000/500 = 20000 bps; -500 -> 500: +1000 / |-500| = 20000 bps.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm turbo run test --filter=@erq/metrics`
Expected: the new tests FAIL (`sumPnl` and `comparePnl` are not exported).

- [ ] **Step 3: Implement**

In `packages/metrics/src/pnl.ts` change the first two imports to:

```ts
import { add, money, subtract, sum, type Money } from '@erq/shared';
import { bigRatioToBps, moneyRatioBps, type Bps } from './bps';
```

Append:

```ts
/** Adds P&Ls line by line, for breakdowns by channel, product, category or segment. */
export function sumPnl(items: Pnl[], currency: string): Pnl {
  const zero = money(0, currency);
  const base: PnlBase = {
    currency, grossSales: zero, discounts: zero, refunds: zero, cogs: zero, shipping: zero, pickPack: zero,
    paymentFees: zero, marketplaceFees: zero, adSpendByPlatform: {}, otherOpex: zero,
  };
  let complete = true;
  for (const p of items) {
    if (p.currency !== currency) throw new Error(`currency mismatch: P&L is ${p.currency}, expected ${currency}`);
    base.grossSales = add(base.grossSales, p.grossSales);
    base.discounts = add(base.discounts, p.discounts);
    base.refunds = add(base.refunds, p.refunds);
    base.cogs = add(base.cogs, p.cogs);
    base.shipping = add(base.shipping, p.shipping);
    base.pickPack = add(base.pickPack, p.pickPack);
    base.paymentFees = add(base.paymentFees, p.paymentFees);
    base.marketplaceFees = add(base.marketplaceFees, p.marketplaceFees);
    base.otherOpex = add(base.otherOpex, p.otherOpex);
    for (const [platform, spend] of Object.entries(p.adSpend.byPlatform)) {
      base.adSpendByPlatform[platform] = add(base.adSpendByPlatform[platform] ?? zero, spend);
    }
    complete = complete && p.cogsComplete;
  }
  return assemble(base, complete);
}

export type PnlLineName =
  | 'grossSales' | 'discounts' | 'refunds' | 'netSales' | 'cogs' | 'grossProfit' | 'fulfillment' | 'paymentFees'
  | 'marketplaceFees' | 'contributionMargin' | 'adSpend' | 'netContributionAfterMarketing' | 'otherOpex'
  | 'estimatedOperatingProfit';

export interface LineComparison {
  current: Money;
  previous: Money;
  change: Money;
  /** Change relative to the size of the previous value; null when the previous value is zero. */
  changeBps: Bps | null;
}
export type PnlComparison = Record<PnlLineName, LineComparison>;

const LINE_NAMES: PnlLineName[] = [
  'grossSales', 'discounts', 'refunds', 'netSales', 'cogs', 'grossProfit', 'fulfillment', 'paymentFees',
  'marketplaceFees', 'contributionMargin', 'adSpend', 'netContributionAfterMarketing', 'otherOpex', 'estimatedOperatingProfit',
];

function lineValue(p: Pnl, name: PnlLineName): Money {
  return name === 'adSpend' ? p.adSpend.total : p[name];
}

export function comparePnl(current: Pnl, previous: Pnl): PnlComparison {
  const result = {} as PnlComparison;
  for (const name of LINE_NAMES) {
    const cur = lineValue(current, name);
    const prev = lineValue(previous, name);
    const change = subtract(cur, prev);
    result[name] = {
      current: cur,
      previous: prev,
      change,
      changeBps: bigRatioToBps(BigInt(change.cents), BigInt(Math.abs(prev.cents))),
    };
  }
  return result;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm turbo run test typecheck build --filter=@erq/metrics` then `pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(metrics): add P&L summing for breakdowns and period comparison"
```

---

### Task 9: Public exports check, reference docs and project notes

**Files:**
- Create: `packages/metrics/test/exports.test.ts`, `docs/metrics.md`
- Modify: `docs/superpowers/specs/2026-10-06-phase1a-metrics-design.md` (record plan-level clarifications), `CLAUDE.md` (§16 only)

**Interfaces:**
- Produces: a test that pins the public API of `@erq/metrics`; `docs/metrics.md` reference.

- [ ] **Step 1: Write the exports test**

`packages/metrics/test/exports.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as metrics from '../src';

describe('@erq/metrics public API', () => {
  it.each([
    'divRound', 'toSafeInteger', 'mulDivRound', 'bigRatioToBps', 'ratioToBps', 'moneyRatioBps', 'formatBps',
    'landedCost', 'skuPricing',
    'roas', 'blendedRoas', 'breakEvenRoas', 'cpa', 'classifyAd',
    'salesVelocity', 'daysOfCover', 'stockFlags', 'stockByLocation',
    'buildPnl', 'sumPnl', 'comparePnl',
  ])('exports the function %s', (name) => {
    expect(typeof (metrics as Record<string, unknown>)[name]).toBe('function');
  });
  it.each(['DEFAULT_PRICING_CONFIG', 'DEFAULT_AD_FLAG_CONFIG', 'DEFAULT_BUFFER_DAYS', 'UNKNOWN_LEAD_TIME_DAYS', 'DEFAULT_OVERSTOCK_DAYS'])(
    'exports the constant %s',
    (name) => {
      expect((metrics as Record<string, unknown>)[name]).toBeDefined();
    },
  );
  it('depends only on @erq/shared at runtime', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['@erq/shared']);
  });
});
```

Run: `pnpm turbo run test typecheck --filter=@erq/metrics`
Expected: PASS (every export already exists; this test pins the API so a later refactor cannot silently drop one).

- [ ] **Step 2: Write `docs/metrics.md`**

Create `docs/metrics.md` with these sections, each with the real formulas from this plan (write them out; do not leave outlines):
1. **Conventions:** `Money`, `Bps`, `null` instead of `NaN`/`Infinity`, rounding half away from zero, one currency per call.
2. **Pricing:** `landedCost` time-versioning rule (`effectiveFrom <= asOf < effectiveTo`), the `skuPricing` fields, the floor price formula `ceil((landed + fixed) / (1 − pct − minContribution))` and the rounding search, `maxDiscount = price − floor`, the markup versus margin table (50% markup = 33.33% margin, 100% = 50%).
3. **Advertising:** ROAS, blended ROAS (MER), break-even ROAS `10000 / contribution bps`, CPA, the five flag rules in order with the default thresholds, the integer boundary comparisons (`revenue × contribution` against `10000 × spend`), the generic-band fallback, the trend formula.
4. **Inventory:** velocity weights (50/30/20), days of cover, the three flags and thresholds (14 days unknown lead time, 7-day default buffer, 180 days overstock, 90 days dead).
5. **P&L:** the line order and identities, `cogsComplete`, `sumPnl` for breakdowns, `comparePnl` semantics (change relative to `|previous|`).
6. **Assumptions to validate with early users:** 15% minimum contribution, 7-day buffer, 50/30/20 weights, the trailing-7-day reading of "losing".

- [ ] **Step 3: Record the plan-level clarifications in the spec**

In `docs/superpowers/specs/2026-10-06-phase1a-metrics-design.md`:
- §4.3: change `AdFlagConfig` to use `minSpendCents: number` (default 5000, interpreted in the currency of the days) instead of `minSpend: Money`, and state that estimated daily loss divides by the number of days in the trailing window (7 when a full week exists).
- §4.4: add `DEFAULT_BUFFER_DAYS = 7` and `UNKNOWN_LEAD_TIME_DAYS = 14` to the `stockFlags` description.
- §4.2: state that `floorPrice` and `maxDiscount` are `null` (with an explanation for the floor) when landed cost is zero, and that `maxDiscount` is a zero amount when no price can reach the minimum.

- [ ] **Step 4: Update CLAUDE.md §16**

In `CLAUDE.md` section 16: in "Built", change `metrics (empty)` to `metrics (pricing, ad flags, inventory flags, monthly P&L: see docs/metrics.md)`; add to the Decisions Log one line dated 2026-10-06 recording: percentages are integer basis points, ROAS is a plain number, "losing" means the trailing-7-day total ROAS is below break-even, default minimum contribution 15%, default stock buffer 7 days, velocity weights 50/30/20. Change nothing else in the file.

- [ ] **Step 5: Final verification and commit**

Run: `pnpm turbo run test typecheck build --filter=@erq/metrics`, then `pnpm lint`
Expected: PASS.

```bash
git add -A && git commit -m "docs(metrics): add API pin test, metrics reference and decisions"
```

---

## Self-Review Notes

- **Spec coverage:** §4.1 bps (Task 1), §4.2 pricing (Tasks 2, 3), §4.3 ads (Tasks 4, 5), §4.4 inventory (Task 6), §4.5 P&L (Tasks 7, 8), packaging, docs and decisions (Task 9). Out-of-scope items (customers, reorder quantity, report call-outs) have no task, as specified.
- **Success criteria:** 1 (every function exported and tested) by Tasks 1 to 8 plus the Task 9 export pin; 2 (test, typecheck, build, lint) in every task's verification; 3 (only `@erq/shared` dependency) pinned by the Task 9 test; 4 (code, facts, explanation on every flag) by the `classifyAd` tests (facts and explanation asserted) and the `stockFlags` tests (explanation asserted).
- **Known judgement calls recorded in the plan:** `minSpendCents` instead of `minSpend: Money`; 7-day default stock buffer; floor and discount behaviour when cost is unknown; ratio-of-ROAS trend with null when either week lacks revenue or spend.

