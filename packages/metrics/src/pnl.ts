import { add, money, subtract, sum, type Money } from '@erq/shared';
import { bigRatioToBps, moneyRatioBps, type Bps } from './bps';

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
interface PnlBase {
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

function assemble(base: PnlBase, cogsComplete: boolean): Pnl {
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

/** Adds P&Ls line by line, for breakdowns by channel, product, category or segment. */
export function sumPnl(items: Pnl[], currency: string): Pnl {
  const zero = money(0, currency);
  const base: PnlBase = {
    currency,
    grossSales: zero,
    discounts: zero,
    refunds: zero,
    cogs: zero,
    shipping: zero,
    pickPack: zero,
    paymentFees: zero,
    marketplaceFees: zero,
    adSpendByPlatform: {},
    otherOpex: zero,
  };
  let complete = true;
  for (const p of items) {
    if (p.currency !== currency)
      throw new Error(`currency mismatch: P&L is ${p.currency}, expected ${currency}`);
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
  | 'grossSales'
  | 'discounts'
  | 'refunds'
  | 'netSales'
  | 'cogs'
  | 'grossProfit'
  | 'fulfillment'
  | 'paymentFees'
  | 'marketplaceFees'
  | 'contributionMargin'
  | 'adSpend'
  | 'netContributionAfterMarketing'
  | 'otherOpex'
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
  'grossSales',
  'discounts',
  'refunds',
  'netSales',
  'cogs',
  'grossProfit',
  'fulfillment',
  'paymentFees',
  'marketplaceFees',
  'contributionMargin',
  'adSpend',
  'netContributionAfterMarketing',
  'otherOpex',
  'estimatedOperatingProfit',
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
