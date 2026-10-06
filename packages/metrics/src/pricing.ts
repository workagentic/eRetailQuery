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
  };
}
