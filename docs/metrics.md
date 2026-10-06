# Metrics reference (`@erq/metrics`)

Pure, unit-tested functions for pricing, ad flags, inventory flags and the P&L. The package depends only on `@erq/shared`. This page documents what the code does today; if code and doc disagree, the code is the truth and this page is a bug.

## 1. Conventions

- **Money.** Every amount is a `Money` (`{ cents: integer, currency: ISO code }`) from `@erq/shared`. There are no floats for money. A call works in exactly one currency; mixing currencies throws `currency mismatch`.
- **Percentages are basis points (`Bps`).** `4286` means 42.86%. `Bps` values are always safe integers. `formatBps(4286)` gives `"42.86%"` (display only).
- **ROAS is a plain number.** `3.2` means $3.20 returned per $1.00 spent. It is the one ratio that is not in basis points.
- **`null` instead of `NaN` or `Infinity`.** Division by zero never produces a bad number. Each function documents when it returns `null` (for example `roas` with zero spend, `markup` with zero landed cost).
- **Rounding is half away from zero** (`divRound`, `mulDivRound`, `bigRatioToBps`). `2.5` rounds to `3`, `-2.5` rounds to `-3`. Intermediate products use `bigint`, so nothing overflows; results that do not fit a safe integer throw `RangeError`.
- **Invalid input throws.** Negative spend or revenue, non-integer basis points or counts, negative stock, and weights that do not sum to 1 throw `RangeError`. Bad data is not silently coerced.
- **Dates** are `YYYY-MM-DD` strings. The caller buckets them in the org timezone.

| Helper | Meaning |
|---|---|
| `divRound(n, d)` | bigint division, half away from zero. Throws on `d = 0`. |
| `mulDivRound(a, b, c)` | `(a * b) / c` on safe integers, rounded. |
| `ratioToBps(n, d)` / `bigRatioToBps` | `round(n * 10000 / d)`, `null` when `d = 0`. |
| `moneyRatioBps(part, whole)` | Same on two `Money` values of one currency. |
| `toSafeInteger(bigint)` | Throws `RangeError` outside the safe integer range. |

## 2. Pricing (`pricing.ts`)

### 2.1 `landedCost(components, asOf, currency = 'USD')`

Sums the per-unit cost components in effect on `asOf`. A component counts when

```
effectiveFrom <= asOf < effectiveTo        (effectiveTo = null means open-ended)
```

so `effectiveFrom` is inclusive and `effectiveTo` is exclusive. A component ending on 2026-03-01 does not apply on 2026-03-01, and a replacement starting on 2026-03-01 does. This is how historical orders get the cost that was true on their date. Costs per batch must be converted to per unit by the caller: a component with `perUnit: false` throws `RangeError` (`perUnit` may be `true` or omitted). `asOf`, every `effectiveFrom` and every non-null `effectiveTo` must match `YYYY-MM-DD` (otherwise `RangeError`), and every component must be in `currency`.

`isCostInEffect(component, asOf)` is the single rule for time-versioned costs: a component is in effect when `effectiveFrom <= asOf < effectiveTo` (`effectiveTo` null means open-ended). `landedCost` and the sync engine's order-line cost snapshots both use it.

### 2.2 `skuPricing({ price, discount?, landed, fulfillment?, config? })`

Defaults (`DEFAULT_PRICING_CONFIG`): `targetMarkupLow = 5000` (50%), `targetMarkupHigh = 10000` (100%), `minContribution = 1500` (15%). `config` is a partial override.

**Config validation.** Keys set to `undefined` fall back to the defaults. Invalid values throw `RangeError`: markup bounds must be safe integers `>= 0` with `low <= high`, and `minContribution` a safe integer with `0 <= min < 10000`. `DEFAULT_PRICING_CONFIG` is frozen. Negative landed cost, discount or fixed fulfillment amounts also throw `RangeError`.

```
netPrice        = price - discount                   (throws if price or netPrice is negative)
fixed           = sum of fulfillment.fixed           (pickPack, outboundShipping, paymentFee, fbaFee)
pct             = sum of fulfillment.percentOfPrice  (paymentFee, marketplaceFee, returnsAllowance), bps
variableCost    = landed + fixed + round(netPrice * pct / 10000)
contribution    = netPrice - variableCost
markup          = (price - landed) / landed          null when landed = 0
margin          = (price - landed) / price           null when price = 0
contributionBps = contribution / netPrice            null when netPrice = 0
idealRange      = [landed + landed * low, landed + landed * high]   null when landed = 0
```

Percentage fees apply to the discounted price (`netPrice`), not the list price. Markup and margin use the list `price`.

**Status** (`price` against `idealRange`; both ends of the range count as healthy):

| Condition | Code | Message |
|---|---|---|
| landed = 0 | `unknown` | Add the cost of this item |
| `price < low` | `underpriced` | "Underpriced. Raise to at least $X." |
| `price > high` | `premium` | "Premium. Check that it is still selling." |
| otherwise | `healthy` | "Healthy." |

**Warning** `markup_ok_contribution_negative` fires when there is an ideal range, `markup` is not null, `price >= idealRange.low` (markup looks fine) and `contribution < 0` (each sale loses money after fees and shipping). The message states the loss per sale.

**Floor price.** The lowest price whose contribution is at or above `minContribution`:

```
floor = ceil( (landed + fixed) / (1 - pct - minContribution) )          rates as fractions
      = ceil( (landed + fixed) * 10000 / (10000 - pct - minContribution) )   rates in bps
```

If `pct + minContribution >= 10000` no price can work and `floorPrice` is `null`. Because the percentage fee is rounded to a whole cent, the closed form can be off by a cent or two. The code therefore searches a small window around the closed-form guess using the same rounding and the exact integer test

```
contribution * 10000 >= minContribution * net
```

and then walks down to the lowest cent that still passes. The floor is the lowest passing price. Because the percentage fee rounds to whole cents, a few prices just above the floor can fall below the minimum by less than one cent of contribution. The same caveat applies to `maxDiscount`, which is derived from the floor.

**Floor and max discount outcomes:**

| Situation | `floorPrice` | `maxDiscount` |
|---|---|---|
| landed = 0 (cost unknown) | `null`, `floorExplanation` asks for cost data | `null` |
| fees plus minimum leave no room (`pct + minContribution >= 10000`) | `null`, explanation says no price reaches the minimum | zero amount |
| normal, price > 0 | the floor | `max(0, price - floor)` |
| normal, price = 0 | the floor | `null` |

`maxDiscount = price - floor` works because the percentage fees apply to the discounted price, so the floor is the lowest acceptable net price.

### 2.3 Markup versus margin

They are different. Show both and label them.

| Markup `(price - cost) / cost` | Margin `(price - cost) / price` |
|---|---|
| 50% | 33.33% |
| 100% | 50% |
| 150% | 60% |
| 200% | 66.67% |

Example: landed $10.00, price $15.00 gives markup 50.00% and margin 33.33%; ideal range $15.00 to $20.00, status `healthy`. At price $12.00 the status is `underpriced`: "Raise to at least $15.00."

Floor example: landed $10.00, fixed costs $5.00, payment fee 290 bps, minimum contribution 1500 bps. Landed plus fixed is `(1000 + 500) = 1500` cents; that 1500 is a cent amount and is unrelated to the 1500 bps minimum. Closed form: `ceil((1000 + 500) * 10000 / (10000 - 290 - 1500)) = ceil(15,000,000 / 8,210) = 1828` cents. The search confirms $18.28 passes (fee 53, contribution 275, `275 * 10000 >= 1500 * 1828`) and $18.27 does not (contribution 274). Floor: $18.28.

## 3. Advertising (`ads.ts`)

### 3.1 Measures

- `roas(revenue, spend) = revenue / spend`, `null` when spend is zero, throws on negative spend. Platform reported.
- `blendedRoas(totalStoreRevenue, totalAdSpend)`: the same formula on total store revenue and total spend across all platforms (also called MER). This is the honest overall number because platform numbers can overlap and over-claim.
- `breakEvenRoas(contributionBeforeAds) = 10000 / bps`, `null` when bps is zero or negative. Example: 4000 bps (40% contribution) gives 2.5.
- `cpa(spend, conversions)`: spend divided by conversions, rounded to a whole cent, `null` when conversions are zero. Conversions must be a non-negative integer.

### 3.2 `classifyAd({ days, contributionBeforeAds }, config?)`

`days` are `AdDay` rows `{ date, spend, impressions, clicks, conversions, revenue }`. `contributionBeforeAds` is the contribution margin before ads in bps, or `null` when no cost data exists.

Defaults (`DEFAULT_AD_FLAG_CONFIG`): `minSpendCents = 5000`, `minImpressions = 1000`, `winningMultiple = 1.5`, `declineThreshold = 2000` (20%), `genericBands = { poor: 1.5, good: 3 }`. `genericBands` merges per key with the defaults. `DEFAULT_AD_FLAG_CONFIG` (and its `genericBands`) is frozen.

**Config validation.** Keys set to `undefined` fall back to the defaults. Invalid values throw `RangeError`: `minSpendCents` and `minImpressions` must be non-negative safe integers, `winningMultiple` finite and `>= 1`, `declineThreshold` a safe integer in `[0, 10000]`, and `genericBands.poor` / `.good` finite with `0 <= poor <= good`.

**Days must be consecutive calendar dates.** Each `date` must match `YYYY-MM-DD`. After sorting, every day must be exactly one calendar day after the previous one, with no gaps and no duplicates, otherwise `classifyAd` throws `RangeError`. Ad platforms such as Meta omit days with no delivery, so callers zero-fill missing days through the last date (and merge duplicate pulls per date first). The **recent window is the last 7 days** and the **previous window is the 7 days before those**.

- The week-over-week trend needs **two full 7-day windows (14 days)**. With fewer, `trend` is `null`. Generic-band ads ignore the trend.
- `minSpendCents` is in **the currency of the days** (the currency of the first row; every row must match it, otherwise it throws). The default 5000 means $50.00 for USD rows.
- Pass `Pnl.marginsBps.contributionMargin` as `contributionBeforeAds` only when `cogsComplete` is true; otherwise pass `null` so the generic bands apply.

Evaluation order (first match wins). Let `S` = recent spend cents, `R` = recent revenue cents, `c` = `contributionBeforeAds`, `days` = rows in the recent window.

1. **Learning.** `S == 0` or `S < minSpendCents` or recent impressions `< minImpressions`. Never judged, never losing. No trend, no loss estimate.
2. **Generic bands.** When `c` is `null` or `c <= 0` (no usable cost data), with `scaled = R * 10000` and bands converted to bps (`round(band * 10000)`):
   - `scaled < poor * S` (ROAS below 1.5): `losing`
   - `scaled <= good * S` (ROAS from 1.5 up to and including 3): `watch`
   - otherwise (ROAS above 3): `winning`

   `usedGenericBands` is true, `breakEven` and `estimatedDailyLoss` are `null`, and the explanation asks the owner to add product costs. **Generic-band ads ignore the trend**: `trend` is still reported, but a decline never changes the flag.
3. **Losing.** `R * c < 10000 * S`, that is ROAS strictly below break-even. This uses the trailing 7-row total, not any single day. `estimatedDailyLoss = round((S * 10000 - R * c) / (10000 * days))` as Money: spend minus what the revenue earns at the contribution margin, divided by the number of rows in the window (7 when a full week exists, fewer if fewer rows were passed).
4. **Watch.** `R * c < round(winningMultiple * 10000) * S` (ROAS at or above break-even but below 1.5 times it), or the trend is below `-declineThreshold` (strictly lower than -2000 bps).
5. **Winning.** Everything else: ROAS at least `winningMultiple * breakEven` and no decline over 20%.

Boundaries: exactly at break-even is not losing (it is `watch`); exactly 1.5 times break-even is `winning`; a decline of exactly 20% is not a decline. All comparisons are integer comparisons, so there is no float rounding at the edges.

**Trend.** Only when both windows have 7 rows and the previous window has spend > 0 and revenue > 0 (otherwise `null`):

```
trend = (R1 / S1) / (R0 / S0) - 1 = (R1 * S0 - R0 * S1) / (R0 * S1)     in bps
```

where `R1, S1` are the recent window and `R0, S0` the previous one. -2500 means ROAS fell 25% week over week.

**Output.** `AdFlag` carries `code`, `roas`, `breakEven`, `trend`, `estimatedDailyLoss`, `usedGenericBands`, `facts` (currency, `daysUsed`, spend, revenue, impressions, conversions, `contributionBeforeAds`) and a plain-English `explanation` that says why the flag fired and what to do.

Example: 7 days, spend $700.00, revenue $1,400.00, contribution 4000 bps. ROAS 2.00, break-even 2.50. `1,400 * 4000 = 5,600,000 < 10000 * 700 = 7,000,000`, so `losing`. Estimated loss per day is `(700 - 1400 * 0.4) / 7 = $20.00`.

## 4. Inventory (`inventory.ts`)

- **`salesVelocity({ units7, units30, units90, weights? })`** gives units per day: `w7 * units7 / 7 + w30 * units30 / 30 + w90 * units90 / 90`. Default weights are 0.5, 0.3, 0.2, weighted toward recent sales. Weights must be non-negative and sum to 1 (within 1e-9); inputs must be non-negative.
- **`daysOfCover(available, velocity) = available / velocity`**, `null` when velocity is 0. `available` is on hand minus reserved.
- **`stockByLocation(levels)`**: per location `max(0, onHand - reserved)`, plus the total across locations.
- **`stockFlags({ available, velocity, unitsSold90, reorderPoint?, leadTimeDays?, bufferDays?, overstockDays? })`** returns `{ facts, low, overstock, dead }`; each flag is `{ fired, explanation }`. `facts` is `{ available, velocity, daysOfCover (number or null), lowThresholdDays, reorderPoint (number or null), overstockDays, unitsSold90 }`, the values the flags were computed from. When given, `reorderPoint`, `leadTimeDays`, `bufferDays` and `overstockDays` must be finite and `>= 0` (`RangeError` otherwise). When `low` does not fire and `available` is 0, its explanation is "Out of stock, and nothing has sold in a while."

| Flag | Fires when |
|---|---|
| `low` | `available <= reorderPoint` (when a reorder point is given), or `daysOfCover < threshold`. Cover that is `null` (no sales) never fires the cover test. |
| `overstock` | `daysOfCover > overstockDays` (default 180, `DEFAULT_OVERSTOCK_DAYS`). Exactly 180 does not fire. |
| `dead` | `unitsSold90 === 0` and `available > 0` (no sales in 90 days, but stock on hand). |

The low-stock **threshold** is:

```
threshold = UNKNOWN_LEAD_TIME_DAYS (14)                              when leadTimeDays is not given
threshold = leadTimeDays + (bufferDays ?? DEFAULT_BUFFER_DAYS (7))   when it is
```

So the buffer only applies when a lead time is known; with an unknown lead time the total is a flat 14 days, per CLAUDE.md section 7.2. When both tests would fire, the explanation names the reorder point. Explanations quote days as whole numbers (rounded down).

Example: velocity 2/day, available 20, lead time 10 days, default buffer. Cover is 10 days, threshold 17, so `low` fires: "about 10 days of stock left, and you need 17 days to restock safely."

## 5. P&L (`pnl.ts`)

`buildPnl(input)` takes `grossSales, discounts, refunds, cogs, shipping, pickPack, paymentFees, marketplaceFees, adSpendByPlatform, otherOpex`, all non-negative and in the input currency (otherwise it throws). Lines and identities, in order:

```
grossSales
- discounts
- refunds
= netSales                       = grossSales - discounts - refunds
- cogs
= grossProfit                    = netSales - cogs
- fulfillment                    = shipping + pickPack
- paymentFees
- marketplaceFees
= contributionMargin             = grossProfit - fulfillment - paymentFees - marketplaceFees
- adSpend                        = sum of adSpendByPlatform (total and per platform kept)
= netContributionAfterMarketing  = contributionMargin - adSpend.total
- otherOpex
= estimatedOperatingProfit       = netContributionAfterMarketing - otherOpex
```

- **`cogsComplete`.** `cogs: null` means COGS data is missing. It is treated as zero in the arithmetic and `cogsComplete` is `false`, so every profit line is an overestimate that ignores cost of goods. The UI must show that warning. `cogsComplete` is `true` only when `cogs` was provided.
- **`marginsBps`.** `grossProfit`, `contributionMargin`, `netContributionAfterMarketing` and `estimatedOperatingProfit` as a share of `netSales`; `null` when net sales are not positive.
- **`sumPnl(items, currency)`** adds P&Ls line by line for breakdowns (by channel, product, category, segment), merges `adSpend.byPlatform` keys, recomputes every derived line and the margins from the summed bases, and sets `cogsComplete` to true only if every item was complete. An empty list gives an all-zero P&L. Currency mismatches throw.
- **`comparePnl(current, previous)`** returns, for each of the 14 lines (`adSpend` compares the totals), `{ current, previous, change, changeBps }` where `change = current - previous` and

  ```
  changeBps = change / |previous|        (null when previous is zero)
  ```

  Dividing by the absolute value keeps the sign meaningful when the previous value is negative: going from -$100 to -$50 is a change of +$50 and +5000 bps (an improvement), not -5000.
- Reports are management estimates, not accounting or tax filings.

## 6. Assumptions to validate with early users

These defaults are judgement calls, not facts. Revisit them after real merchants use the app:

1. **Minimum contribution 15%** (`minContribution = 1500`) for the floor price and maximum discount.
2. **Stock buffer 7 days** on top of supplier lead time (`DEFAULT_BUFFER_DAYS`). With unknown lead time the flat 14 days from CLAUDE.md applies.
3. **Velocity weights 50/30/20** over the trailing 7, 30 and 90 days.
4. **"Losing" means the trailing-7-day total ROAS is below break-even**, using platform-reported revenue and the average contribution margin before ads. A single bad day does not make an ad losing; a week below break-even does. This reading of CLAUDE.md section 7.3 ("ROAS < break-even for 7 days") is the main thing to confirm.
5. **Ad flag thresholds:** $50 and 1,000 impressions before judging, winning at 1.5 times break-even, a decline of more than 20% week over week.
