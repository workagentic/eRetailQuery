import { money, type Money } from '@erq/shared';
import { divRound, toSafeInteger, type Bps } from './bps';

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
