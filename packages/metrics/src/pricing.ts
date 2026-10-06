import {
  add,
  applyBasisPoints,
  formatMoney,
  money,
  negate,
  subtract,
  sum,
  type Money,
} from '@erq/shared';
import { withDefaults } from './internal';
import { formatBps, moneyRatioBps, mulDivRound, toSafeInteger, type Bps } from './bps';

export interface CostComponent {
  componentType: string;
  amountCents: number;
  currency: string;
  /** Inclusive, YYYY-MM-DD. */
  effectiveFrom: string;
  /** Exclusive, YYYY-MM-DD, or null for open-ended. */
  effectiveTo: string | null;
  /** Must be true or omitted. Per-batch costs must be converted to per-unit first. */
  perUnit?: boolean;
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

export const DEFAULT_PRICING_CONFIG: Readonly<PricingConfig> = Object.freeze({
  targetMarkupLow: 5000,
  targetMarkupHigh: 10000,
  minContribution: 1500,
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Per-unit landed cost in effect on `asOf`. Per-batch costs must be converted to per-unit by the caller. */
export function landedCost(components: CostComponent[], asOf: string, currency = 'USD'): Money {
  if (!ISO_DATE.test(asOf)) throw new RangeError(`asOf must be YYYY-MM-DD, got ${asOf}`);
  let total = money(0, currency);
  for (const c of components) {
    if (c.perUnit === false) {
      throw new RangeError(
        'per-batch costs must be converted to per-unit first; landedCost only sums per-unit components',
      );
    }
    if (
      !ISO_DATE.test(c.effectiveFrom) ||
      (c.effectiveTo !== null && !ISO_DATE.test(c.effectiveTo))
    ) {
      throw new RangeError(
        `effectiveFrom and effectiveTo must be YYYY-MM-DD, got ${c.effectiveFrom} / ${c.effectiveTo}`,
      );
    }
    if (c.currency !== currency) throw new Error(`currency mismatch: ${c.currency} vs ${currency}`);
    const amount = money(c.amountCents, c.currency);
    if (c.effectiveFrom <= asOf && (c.effectiveTo === null || asOf < c.effectiveTo)) {
      total = add(total, amount);
    }
  }
  return total;
}

function fixedTotal(fixed: FulfillmentAssumptions['fixed'], currency: string): Money {
  const values = Object.values(fixed ?? {}).filter((m): m is Money => m !== undefined);
  return sum(values, currency);
}

function percentTotal(percent: FulfillmentAssumptions['percentOfPrice']): Bps {
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
  /** Lowest price whose contribution is at or above the minimum, null when unknown or impossible. */
  floorPrice: Money | null;
  floorExplanation: string | null;
  /** Largest discount that keeps contribution at or above the minimum. */
  maxDiscount: Money | null;
}

/** Does a net price of `net` cents reach the minimum contribution? Same rounding as skuPricing. */
function meetsMinimum(
  net: number,
  landedCents: number,
  fixedCents: number,
  pct: Bps,
  minContribution: Bps,
): boolean {
  const contribution = net - landedCents - fixedCents - mulDivRound(net, pct, 10000);
  return BigInt(contribution) * 10000n >= BigInt(minContribution) * BigInt(net);
}

function findFloor(
  landedCents: number,
  fixedCents: number,
  pct: Bps,
  minContribution: Bps,
): number | null {
  const rate = pct + minContribution;
  if (rate >= 10000) return null;
  const divisor = BigInt(10000 - rate);
  const base = BigInt(landedCents + fixedCents) * 10000n;
  const guess = toSafeInteger((base + divisor - 1n) / divisor); // ceil, ignores fee rounding
  // Fee rounding can move the true floor by up to ~1 / (1 - rate) cents; search a window around the guess.
  const window = Math.ceil(10000 / (10000 - rate)) + 2;
  const meets = (cents: number) =>
    meetsMinimum(cents, landedCents, fixedCents, pct, minContribution);
  for (let f = Math.max(1, guess - window); f <= guess + window; f++) {
    if (meets(f)) {
      let lowest = f;
      while (lowest > 1 && meets(lowest - 1)) lowest--;
      return lowest;
    }
  }
  throw new Error('floor price search failed');
}

function assertPricingConfig(c: PricingConfig): void {
  const { targetMarkupLow: low, targetMarkupHigh: high, minContribution: min } = c;
  if (
    !Number.isSafeInteger(low) ||
    low < 0 ||
    !Number.isSafeInteger(high) ||
    high < 0 ||
    low > high
  ) {
    throw new RangeError(
      `target markup must be non-negative integers with low <= high, got ${low} / ${high}`,
    );
  }
  if (!Number.isSafeInteger(min) || min < 0 || min >= 10000) {
    throw new RangeError(`minContribution must be an integer in [0, 10000), got ${min}`);
  }
}

export function skuPricing(input: {
  price: Money;
  discount?: Money;
  landed: Money;
  fulfillment?: FulfillmentAssumptions;
  config?: Partial<PricingConfig>;
}): SkuPricing {
  const config = withDefaults<PricingConfig>(DEFAULT_PRICING_CONFIG, input.config);
  assertPricingConfig(config);
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

  if (landed.cents < 0) throw new RangeError('landed cost cannot be negative');
  if (discount.cents < 0) throw new RangeError('discount cannot be negative');
  for (const m of Object.values(fulfillment.fixed ?? {})) {
    if (m !== undefined && m.cents < 0) {
      throw new RangeError('fixed fulfillment amounts cannot be negative');
    }
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
    status = {
      code: 'unknown',
      explanation:
        'No cost data yet. Add the cost of this item to see whether the price is healthy.',
    };
  } else if (price.cents < idealRange.low.cents) {
    status = {
      code: 'underpriced',
      explanation: `Underpriced. Raise to at least ${formatMoney(idealRange.low)}.`,
    };
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

  return {
    currency,
    netPrice,
    landed,
    variableCost,
    contribution,
    markup,
    margin,
    contributionBps,
    idealRange,
    status,
    warning,
    floorPrice,
    floorExplanation,
    maxDiscount,
  };
}
