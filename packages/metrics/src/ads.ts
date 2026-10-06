import { formatMoney, money, type Money } from '@erq/shared';
import { bigRatioToBps, divRound, toSafeInteger, type Bps } from './bps';

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency)
    throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`);
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
    throw new RangeError(
      `contributionBeforeAds must be an integer in basis points, got ${contributionBeforeAds}`,
    );
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
    throw new Error(
      `currency mismatch: ${day.spend.currency}/${day.revenue.currency} vs ${currency}`,
    );
  }
  if (day.spend.cents < 0 || day.revenue.cents < 0)
    throw new RangeError('spend and revenue cannot be negative');
  for (const [name, value] of [
    ['impressions', day.impressions],
    ['clicks', day.clicks],
    ['conversions', day.conversions],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError(`${name} must be a non-negative integer, got ${value}`);
  }
}

function aggregate(days: AdDay[]): {
  spend: number;
  revenue: number;
  impressions: number;
  conversions: number;
} {
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
      code: 'learning',
      roas: roasValue,
      breakEven,
      trend: null,
      estimatedDailyLoss: null,
      usedGenericBands: false,
      facts,
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
        code: 'losing',
        roas: roasValue,
        breakEven: null,
        trend,
        estimatedDailyLoss: null,
        usedGenericBands: true,
        facts,
        explanation: `This ad returns only $${roasText} for every $1.00 spent, which is poor. Add your product costs so we can calculate your exact break-even point.`,
      };
    }
    if (scaled <= good * S) {
      return {
        code: 'watch',
        roas: roasValue,
        breakEven: null,
        trend,
        estimatedDailyLoss: null,
        usedGenericBands: true,
        facts,
        explanation: `This ad returns $${roasText} for every $1.00 spent, which is average. Add your product costs so we can calculate your exact break-even point.`,
      };
    }
    return {
      code: 'winning',
      roas: roasValue,
      breakEven: null,
      trend,
      estimatedDailyLoss: null,
      usedGenericBands: true,
      facts,
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
      code: 'losing',
      roas: roasValue,
      breakEven,
      trend,
      estimatedDailyLoss,
      usedGenericBands: false,
      facts,
      explanation:
        `Pause or fix this ad. It returned $${roasText} for every $1.00 spent over the last ${days} day${days === 1 ? '' : 's'}, ` +
        `but you need $${beText} to break even. Estimated loss: about ${formatMoney(estimatedDailyLoss)} per day.`,
    };
  }
  // ROAS >= winningMultiple x break-even  <=>  revenue x contribution >= multiple(bps) x spend.
  if (earned < asBps(cfg.winningMultiple) * S || declining) {
    const winningRoas = fmt(Number(breakEven) * cfg.winningMultiple);
    return {
      code: 'watch',
      roas: roasValue,
      breakEven,
      trend,
      estimatedDailyLoss: null,
      usedGenericBands: false,
      facts,
      explanation: declining
        ? `Keep an eye on this ad. Its return dropped ${Math.abs(Math.round(Number(trend) / 100))}% compared with the week before ($${roasText} per $1.00 now).`
        : `Keep an eye on this ad. It is above break-even ($${beText}) but below the $${winningRoas} level where we call it winning.`,
    };
  }
  return {
    code: 'winning',
    roas: roasValue,
    breakEven,
    trend,
    estimatedDailyLoss: null,
    usedGenericBands: false,
    facts,
    explanation: `Scale this ad. It returns $${roasText} for every $1.00 spent, well above the $${beText} you need to break even.`,
  };
}
