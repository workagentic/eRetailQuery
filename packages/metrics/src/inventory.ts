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
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative number, got ${value}`);
}

/** Weighted average of units per day over the trailing 7, 30 and 90 days. */
export function salesVelocity(input: {
  units7: number;
  units30: number;
  units90: number;
  weights?: VelocityWeights;
}): number {
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
  return (
    weights.w7 * (input.units7 / 7) +
    weights.w30 * (input.units30 / 30) +
    weights.w90 * (input.units90 / 90)
  );
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
    input.leadTimeDays === undefined
      ? UNKNOWN_LEAD_TIME_DAYS
      : input.leadTimeDays + (input.bufferDays ?? DEFAULT_BUFFER_DAYS);
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
      ? {
          fired: true,
          explanation: `Overstocked: about ${Math.floor(cover)} days of stock on hand, more than ${overstockDays}. Consider a promotion and hold off reordering.`,
        }
      : { fired: false, explanation: 'Not overstocked.' };

  const dead: StockFlag =
    input.unitsSold90 === 0 && input.available > 0
      ? {
          fired: true,
          explanation: `Dead stock: ${input.available} on hand and no sales in 90 days. Consider a discount or bundle to clear it.`,
        }
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
