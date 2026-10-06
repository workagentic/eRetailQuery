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
  const contributionMargin = subtract(
    subtract(subtract(grossProfit, fulfillment), base.paymentFees),
    base.marketplaceFees,
  );
  const byPlatform = { ...base.adSpendByPlatform };
  const adTotal = sum(Object.values(byPlatform), currency);
  const netContributionAfterMarketing = subtract(contributionMargin, adTotal);
  const estimatedOperatingProfit = subtract(netContributionAfterMarketing, base.otherOpex);

  const share = (line: Money): Bps | null =>
    netSales.cents > 0 ? moneyRatioBps(line, netSales) : null;
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
  if (value.currency !== currency)
    throw new Error(`currency mismatch: ${name} is ${value.currency}, expected ${currency}`);
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
