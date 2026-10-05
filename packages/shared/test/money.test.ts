import { describe, expect, it } from 'vitest';
import {
  add,
  applyBasisPoints,
  formatMoney,
  fromDecimalString,
  money,
  negate,
  subtract,
  sum,
} from '../src/money';

describe('money()', () => {
  it('creates integer-cent values defaulting to USD', () => {
    expect(money(1234)).toEqual({ cents: 1234, currency: 'USD' });
  });
  it('rejects fractional, NaN, and unsafe cents', () => {
    expect(() => money(12.5)).toThrow(RangeError);
    expect(() => money(Number.NaN)).toThrow(RangeError);
    expect(() => money(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
  });
  it('rejects malformed currency codes', () => {
    expect(() => money(1, 'usd')).toThrow(RangeError);
    expect(() => money(1, 'US')).toThrow(RangeError);
  });
  it('allows negative values (refunds exceeding sales)', () => {
    expect(money(-500).cents).toBe(-500);
  });
});

describe('arithmetic', () => {
  it('adds, subtracts, negates', () => {
    expect(add(money(100), money(250))).toEqual(money(350));
    expect(subtract(money(100), money(250))).toEqual(money(-150));
    expect(negate(money(100))).toEqual(money(-100));
  });
  it('throws on currency mismatch', () => {
    expect(() => add(money(1, 'USD'), money(1, 'EUR'))).toThrow(/currency mismatch/);
  });
  it('sum of empty list is zero in the given currency', () => {
    expect(sum([], 'EUR')).toEqual(money(0, 'EUR'));
  });
  it('sums a list', () => {
    expect(sum([money(1), money(2), money(3)])).toEqual(money(6));
  });
  it('throws when an addition overflows safe range', () => {
    expect(() => add(money(Number.MAX_SAFE_INTEGER), money(1))).toThrow(RangeError);
  });
});

describe('fromDecimalString()', () => {
  it.each([
    ['12.34', 1234],
    ['12.3', 1230],
    ['12', 1200],
    ['0.05', 5],
    ['-1.50', -150],
    ['0', 0],
    [' 7.00 ', 700],
  ])('parses %s', (input, cents) => {
    expect(fromDecimalString(input)).toEqual(money(cents));
  });
  it('never yields negative zero', () => {
    expect(Object.is(fromDecimalString('-0').cents, 0)).toBe(true);
  });
  it.each(['', 'abc', '1.234', '1,000.00', '$5', '1e3', '.5', '5.'])('rejects %j', (input) => {
    expect(() => fromDecimalString(input)).toThrow(RangeError);
  });
  it('rejects amounts beyond the safe integer range', () => {
    expect(() => fromDecimalString('999999999999999')).toThrow(RangeError);
  });
});

describe('applyBasisPoints()', () => {
  it('computes percentages', () => {
    expect(applyBasisPoints(money(10_000), 2900)).toEqual(money(2900)); // 29%
  });
  it('rounds half away from zero', () => {
    expect(applyBasisPoints(money(1), 5000)).toEqual(money(1));
    expect(applyBasisPoints(money(-1), 5000)).toEqual(money(-1));
    expect(applyBasisPoints(money(1), 4999)).toEqual(money(0));
  });
  it('handles zero amount and zero bps', () => {
    expect(applyBasisPoints(money(0), 1234)).toEqual(money(0));
    expect(applyBasisPoints(money(999), 0)).toEqual(money(0));
  });
  it('rejects non-integer bps', () => {
    expect(() => applyBasisPoints(money(100), 12.5)).toThrow(RangeError);
  });
});

describe('formatMoney()', () => {
  it('formats USD with two decimals', () => {
    expect(formatMoney(money(123456))).toBe('$1,234.56');
    expect(formatMoney(money(-1234))).toBe('-$12.34');
    expect(formatMoney(money(0))).toBe('$0.00');
  });
});
