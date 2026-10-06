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
