# eRetailQuery Phase 1a: Metrics Core — Design Spec

Date: 2026-10-06
Status: Draft, awaiting owner review
Source of truth for product rules: `CLAUDE.md` §7 (this spec does not override it).
Builds on: `docs/superpowers/specs/2026-10-05-phase0-foundations-design.md` (the empty `@erq/metrics` package and `@erq/shared` money utilities).

## 1. Purpose and scope

Phase 1 is split into four sub-projects: 1a metrics core (this spec), 1b Shopify connector and CSV import, 1c Meta and Google Ads connectors, 1d dashboard, P&L report and Stripe. 1a is the pure calculation layer that 1b to 1d call. The API and worker never reimplement a formula.

In scope (CLAUDE.md §7.1, §7.2, §7.3, §7.6):
1. SKU pricing: landed cost, markup, margin, contribution, ideal price range, status, floor price, maximum discount.
2. Advertising: ROAS, blended ROAS, break-even ROAS, CPA, and the winning, losing, watch and learning flags with explanations.
3. Inventory: sales velocity, days of cover, low, over and dead stock flags.
4. Monthly P&L: the full line structure, summing for breakdowns, and period comparison.

Out of scope: customer metrics (§7.4, Phase 2), loyalty (§7.5, Phase 3), suggested reorder quantity (Phase 3), plain-English report call-outs such as "Meta lost $1,240 this quarter" (Phase 1d report layer), any database, network, clock, timezone or currency conversion logic.

Success criteria:
1. Every function listed in section 4 exists, is exported from `@erq/metrics`, and has unit tests that include the edge cases in section 6.
2. `pnpm --filter @erq/metrics test`, `typecheck`, `build` and `pnpm lint` pass.
3. The package has no runtime dependency other than `@erq/shared`.
4. Every flag result carries a `code`, structured `facts`, and a plain-English `explanation`.

## 2. Decisions made while brainstorming

| Decision | Choice | Why |
|---|---|---|
| Scope of 1a | Pricing, advertising, inventory, monthly P&L | Everything Phase 1 screens need; four independent pure modules fit one spec and one plan |
| Percentage representation | Integer basis points (4286 = 42.86%) | No float drift when comparing to thresholds; matches `applyBasisPoints` in `@erq/shared` |
| Multiples (ROAS) | Plain `number` or `null` | They are ratios, not money or percentages |
| Rounding | Half away from zero, integer math | Consistent with `applyBasisPoints` |
| Default minimum contribution | 15% (1500 bps), overridable per org | CLAUDE.md names an owner minimum but gives no default |
| "Losing" rule | Trailing 7-day total ROAS below break-even | Daily ROAS is too noisy for small shops |
| Customer metrics | Not in 1a | Phase 2 in CLAUDE.md |

## 3. Conventions

- **Purity.** No I/O, no `Date.now()`, no timezone logic. Callers pass bucketed data and an `asOf` date (`YYYY-MM-DD` string) where one matters.
- **Types.** Money is `Money` from `@erq/shared`. A percentage is `Bps` (`number`, safe integer). A multiple is `number | null`.
- **No meaningful answer is `null`.** Never `NaN` or `Infinity`. Examples: ROAS with zero spend, CPA with zero conversions, days of cover with zero velocity.
- **Rounding.** Integer division rounds half away from zero, using `BigInt` intermediates like `applyBasisPoints`.
- **Currency.** Mixing currencies throws (already enforced by `@erq/shared` arithmetic). Each function takes one currency; results carry it.
- **Flags.** Every flag result has `{ code, facts, explanation }`. `facts` holds the numbers used (money as `Money`, percentages as `Bps`, multiples as `number`). `explanation` is plain English a non-technical owner can read; it states why the flag fired and what to do.
- **Errors.** Invalid input (negative quantities, non-integer bps, weights that do not sum to 1) throws `RangeError` with a clear message. Missing optional data is not an error; it changes the result as described per function.
- **Files.** `src/bps.ts`, `src/pricing.ts`, `src/ads.ts`, `src/inventory.ts`, `src/pnl.ts`, `src/index.ts`; tests in `test/<module>.test.ts`.

## 4. Modules

### 4.1 `bps.ts`

- `type Bps = number`
- `ratioToBps(numerator: number, denominator: number): Bps | null` — integer inputs; `null` when the denominator is zero; rounds half away from zero.
- `moneyRatioBps(part: Money, whole: Money): Bps | null` — same currency required; `null` when `whole.cents` is zero.
- `formatBps(bps: Bps): string` — `4286 -> "42.86%"`, display only.

### 4.2 `pricing.ts` (CLAUDE.md §7.1)

Types:
- `CostComponent = { componentType: string; amountCents: number; currency: string; effectiveFrom: string; effectiveTo: string | null; perUnit?: boolean }` (per-unit only; `perUnit: false` throws `RangeError`, so the caller converts per-batch costs to per-unit before calling; dates must be `YYYY-MM-DD`).
- `FulfillmentAssumptions = { fixed: { pickPack?: Money; outboundShipping?: Money; paymentFee?: Money; fbaFee?: Money }; percentOfPrice: { paymentFee?: Bps; marketplaceFee?: Bps; returnsAllowance?: Bps } }`
- `PricingConfig = { targetMarkupLow: Bps; targetMarkupHigh: Bps; minContribution: Bps }` with config validation (`RangeError` on invalid values; `undefined` keys fall back to defaults) and `DEFAULT_PRICING_CONFIG = { targetMarkupLow: 5000, targetMarkupHigh: 10000, minContribution: 1500 }`.

Functions:
- `landedCost(components: CostComponent[], asOf: string, currency?: string): Money` — sums components where `effectiveFrom <= asOf` and (`effectiveTo` is null or `asOf < effectiveTo`). Empty list gives zero. Components in another currency throw.
- `skuPricing(input: { price: Money; discount?: Money; landed: Money; fulfillment: FulfillmentAssumptions; config?: Partial<PricingConfig> }): SkuPricing` returning:
  - `landed`, `variableCost` (landed + fixed costs + percentage costs at the net price), `netPrice` (price minus discount);
  - `markup` and `margin` as `Bps | null` (null when landed or price is zero);
  - `contribution: Money` and `contributionBps: Bps | null` on the net price;
  - `idealRange: { low: Money; high: Money } | null` (`landed × (1 + markup)`, null when landed is zero);
  - `status: { code: 'underpriced' | 'healthy' | 'premium' | 'unknown'; explanation: string }` — underpriced says "Raise to at least $X"; premium says "Check that it is still selling"; unknown when there is no cost data;
  - `floorPrice: Money | null` — the lowest price with contribution at or above `minContribution`: `ceil((landed + fixed) / (1 - pctFees - minContribution))`; null with `floorExplanation` when the percentage fees plus the minimum leave no room (denominator at or below zero), and null with a `floorExplanation` asking for cost data when landed cost is zero (cost unknown);
  - `warning: { code: 'markup_ok_contribution_negative'; explanation: string } | null`;
  - `maxDiscount: Money | null` — the largest discount keeping contribution at or above `minContribution`. It equals `price − floorPrice` (percentage fees apply to the discounted price, so the floor price is the lowest acceptable net price). It is zero when the price is already at or below the floor, a zero amount when no price can reach the minimum (fees plus the minimum leave no room), and null when landed cost is zero (cost unknown) or the price is zero.

### 4.3 `ads.ts` (CLAUDE.md §7.3)

Measures:
- `roas(revenue: Money, spend: Money): number | null`
- `blendedRoas(totalStoreRevenue: Money, totalAdSpend: Money): number | null`
- `breakEvenRoas(contributionBeforeAds: Bps): number | null` — `10000 / bps`; null when bps is zero or negative.
- `cpa(spend: Money, conversions: number): Money | null`

Flags:
- `AdDay = { date: string; spend: Money; impressions: number; clicks: number; conversions: number; revenue: Money }`
- `AdFlagConfig = { minSpendCents: number; minImpressions: number; winningMultiple: number; declineThreshold: Bps; genericBands: { poor: number; good: number } }` with defaults: `minSpendCents` 5000 (interpreted in the currency of the days), 1,000 impressions, winning multiple 1.5, decline threshold 2000 bps (20%), generic bands 1.5 and 3.
- `classifyAd(input: { days: AdDay[]; contributionBeforeAds: Bps | null }, config?: Partial<AdFlagConfig>): AdFlag`. `days` must be consecutive calendar dates (no gaps, no duplicates, otherwise `RangeError`; callers zero-fill missing days). The recent window is the last 7 days and the previous window the 7 before them; fewer days are allowed and the week-over-week trend is then `null`. Config keys set to `undefined` fall back to defaults and invalid config values throw `RangeError`.
- `AdFlag = { code: 'learning' | 'losing' | 'watch' | 'winning'; roas: number | null; breakEven: number | null; trend: Bps | null; estimatedDailyLoss: Money | null; usedGenericBands: boolean; facts; explanation }`.

Rules, evaluated in this order:
1. **Learning:** trailing-7-day spend below `minSpendCents` or impressions below `minImpressions`. Never flagged losing.
2. **Generic bands** (when `contributionBeforeAds` is null or not positive): ROAS below the poor band is `losing`, from the poor band up to the good band is `watch`, above the good band is `winning`; `usedGenericBands: true` and the explanation asks the owner to add costs for accurate flags. Estimated daily loss is `null` in this mode.
3. **Losing:** trailing-7-day ROAS below break-even. `estimatedDailyLoss = max(0, spend - revenue × contributionBeforeAds) / days`, as Money, where `days` is the number of days in the trailing window (7 when a full week exists).
4. **Watch:** ROAS at least break-even but below `winningMultiple × break-even`, or week-over-week ROAS change below `-declineThreshold`.
5. **Winning:** ROAS at least `winningMultiple × break-even` and trend not below `-declineThreshold`.

### 4.4 `inventory.ts` (CLAUDE.md §7.2)

- `salesVelocity(input: { units7: number; units30: number; units90: number; weights?: { w7: number; w30: number; w90: number } }): number` — weighted average of daily rates (units divided by 7, 30 and 90); default weights 0.5, 0.3, 0.2; weights must sum to 1 (else `RangeError`).
- `daysOfCover(available: number, velocity: number): number | null` — null when velocity is zero; `available` is on hand minus reserved and may not be negative (negative throws).
- `stockFlags(input: { available: number; velocity: number; unitsSold90: number; reorderPoint?: number; leadTimeDays?: number; bufferDays?: number; overstockDays?: number }): StockFlags` returning `{ facts, low, overstock, dead }` (`facts` holds the inputs and thresholds used; optional numeric inputs must be finite and non-negative), where each flag is `{ fired: boolean; explanation: string }`:
  - low: days of cover below `leadTimeDays + bufferDays` (`bufferDays` defaults to `DEFAULT_BUFFER_DAYS = 7`; the threshold is `UNKNOWN_LEAD_TIME_DAYS = 14` in total when lead time is unknown) or `available <= reorderPoint`;
  - overstock: days of cover above 180;
  - dead: `unitsSold90 === 0` and `available > 0`.
- `stockByLocation(levels: { locationId: string; onHand: number; reserved: number }[]): { byLocation: { locationId: string; available: number }[]; totalAvailable: number }` — available is on hand minus reserved, floored at zero per location.

### 4.5 `pnl.ts` (CLAUDE.md §7.6)

- `PnlInput = { currency: string; grossSales; discounts; refunds; cogs: Money | null; shipping; pickPack; paymentFees; marketplaceFees; adSpendByPlatform: Record<string, Money>; otherOpex: Money }` — all `Money` in one currency. `cogs: null` means COGS data is missing.
- `buildPnl(input: PnlInput): Pnl` returns every line in the CLAUDE.md order: `grossSales`, `discounts`, `refunds`, `netSales` (gross − discounts − refunds), `cogs`, `grossProfit`, `fulfillment` (shipping + pick and pack), `paymentFees`, `marketplaceFees`, `contributionMargin`, `adSpend` (total and by platform), `netContributionAfterMarketing`, `otherOpex`, `estimatedOperatingProfit`, plus `cogsComplete: boolean` and `marginsBps` (each profit line as a share of net sales, `null` when net sales are not positive).
- Refunds greater than sales give negative net sales; nothing is clamped.
- When `cogs` is null the COGS line is zero, `cogsComplete` is false, and profit lines are marked as estimates.
- `sumPnl(items: Pnl[], currency: string): Pnl` — line-by-line addition for breakdowns by channel, product, category or segment; platform ad spend maps merge by key; `cogsComplete` is the AND of the inputs.
- `comparePnl(current: Pnl, previous: Pnl): PnlComparison` — per line: `{ current, previous, change: Money, changeBps: Bps | null }` (`changeBps` null when the previous value is zero).

## 5. Dependencies and packaging

- Runtime dependency: `@erq/shared` (`workspace:*`). No new third-party packages.
- Build and test setup already exist (tsup CJS, `vitest.config.mts`); the placeholder export `METRICS_PACKAGE` and its smoke test are removed once real exports exist.
- Type-only `Bps` and result types are exported for the API and web.

## 6. Testing

Vitest unit tests per module with, at minimum:
- Zero revenue, zero spend, zero conversions, zero velocity, zero landed cost, zero price.
- Missing cost data: `landedCost([])`, `classifyAd` with `contributionBeforeAds: null`, `buildPnl` with `cogs: null`.
- Refunds exceeding sales, negative net sales, negative contribution.
- Exact boundaries: markup exactly 50% and 100%, ROAS exactly at break-even and exactly 1.5× break-even, spend exactly at the minimum, days of cover exactly at lead time plus buffer, exactly 180 days.
- Cost time-versioning boundaries: `asOf` equal to `effectiveFrom` and to `effectiveTo`.
- The 33.3% margin to 50% markup relationship from CLAUDE.md §4 (markup 50% gives margin 3333 bps; markup 100% gives 5000 bps).
- Floor price: round trip (pricing at the floor gives contribution at or above the minimum, one cent less gives below); the no-room case returns null.
- Maximum discount: round trip likewise; already-below-minimum returns zero.
- Rounding: half away from zero for positive and negative values; large values near the safe integer limit throw rather than lose precision.
- Currency mismatch throws.
- Flags: each of the four codes, the learning guard overriding everything, the generic-band path, week-over-week decline above and below 20%, estimated daily loss value.
- Property-style checks (loops over fixed input grids, no new dependency): P&L identities hold (net sales − COGS = gross profit; contribution minus ad spend minus opex = operating profit), `sumPnl` of one item equals the item.

## 7. Risks and open items

- The CLAUDE.md wording "ROAS below break-even for 7 days" is interpreted as the trailing 7-day total; confirm with early users.
- Default minimum contribution (15%) and velocity weights (50/30/20) are assumptions to validate with early users; both are configurable.
- Cost components that are not per unit (`per_unit = false` in the schema) are not handled here; Phase 1b must convert them before calling `landedCost`.
- The per-org and per-category configuration lookup (which config applies to which SKU) belongs to the API layer in 1d; 1a only accepts a resolved config.
