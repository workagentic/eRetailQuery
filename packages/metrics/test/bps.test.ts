import { describe, expect, it } from 'vitest';
import { money } from '@erq/shared';
import {
  bigRatioToBps,
  divRound,
  formatBps,
  moneyRatioBps,
  mulDivRound,
  ratioToBps,
  toSafeInteger,
} from '../src/bps';

describe('divRound (half away from zero)', () => {
  it.each([
    [7n, 2n, 4n],
    [-7n, 2n, -4n],
    [7n, -2n, -4n],
    [-7n, -2n, 4n],
    [5n, 2n, 3n],
    [-5n, 2n, -3n],
    [1n, 3n, 0n],
    [2n, 3n, 1n],
    [0n, 5n, 0n],
    [0n, -5n, 0n],
  ])('%s / %s = %s', (n, d, expected) => {
    expect(divRound(n, d)).toBe(expected);
  });
  it('throws on division by zero', () => {
    expect(() => divRound(1n, 0n)).toThrow(RangeError);
  });
});

describe('toSafeInteger', () => {
  it('converts safe values and rejects unsafe ones', () => {
    expect(toSafeInteger(42n)).toBe(42);
    expect(() => toSafeInteger(BigInt(Number.MAX_SAFE_INTEGER) + 2n)).toThrow(RangeError);
  });
});

describe('mulDivRound', () => {
  it('multiplies then divides with half-away-from-zero rounding', () => {
    expect(mulDivRound(3, 5000, 10000)).toBe(2); // 1.5 -> 2
    expect(mulDivRound(-3, 5000, 10000)).toBe(-2); // -1.5 -> -2
    expect(mulDivRound(1, 4999, 10000)).toBe(0);
  });
  it('rejects division by zero and non-integers', () => {
    expect(() => mulDivRound(7, 1, 0)).toThrow(RangeError);
    expect(() => mulDivRound(1.5, 1, 1)).toThrow(RangeError);
  });
});

describe('ratioToBps', () => {
  it.each([
    [1, 3, 3333],
    [2, 3, 6667],
    [1, 2, 5000],
    [1, 8, 1250],
    [0, 5, 0],
    [3, 3, 10000],
    [-1, 3, -3333],
    [1, -3, -3333],
    [-2, 3, -6667],
    [-1, -3, 3333],
    [1, 32, 313],
    [-1, 32, -313], // 312.5 rounds away from zero
  ])('%s / %s = %s bps', (n, d, expected) => {
    expect(ratioToBps(n, d)).toBe(expected);
  });
  it('returns null for a zero denominator', () => {
    expect(ratioToBps(5, 0)).toBeNull();
    expect(ratioToBps(0, 0)).toBeNull();
  });
  it('rejects non-integers and results outside the safe range', () => {
    expect(() => ratioToBps(1.5, 2)).toThrow(RangeError);
    expect(() => ratioToBps(Number.MAX_SAFE_INTEGER, 1)).toThrow(RangeError);
  });
});

describe('bigRatioToBps', () => {
  it('matches ratioToBps and returns null on zero', () => {
    expect(bigRatioToBps(1n, 3n)).toBe(3333);
    expect(bigRatioToBps(1n, 0n)).toBeNull();
  });
});

describe('moneyRatioBps', () => {
  it('computes a percentage of two money values', () => {
    expect(moneyRatioBps(money(50), money(150))).toBe(3333);
    expect(moneyRatioBps(money(-50), money(100))).toBe(-5000);
  });
  it('returns null when the whole is zero and throws on mixed currencies', () => {
    expect(moneyRatioBps(money(5), money(0))).toBeNull();
    expect(() => moneyRatioBps(money(1, 'USD'), money(1, 'EUR'))).toThrow(/currency mismatch/);
  });
});

describe('formatBps', () => {
  it.each([
    [4286, '42.86%'],
    [0, '0.00%'],
    [-5, '-0.05%'],
    [5, '0.05%'],
    [10000, '100.00%'],
    [-12345, '-123.45%'],
  ])('%s -> %s', (bps, text) => {
    expect(formatBps(bps)).toBe(text);
  });
  it('rejects non-integers', () => {
    expect(() => formatBps(1.5)).toThrow(RangeError);
  });
});
