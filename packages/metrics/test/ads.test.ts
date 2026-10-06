import { describe, expect, it } from 'vitest';
import { money } from '@erq/shared';
import { blendedRoas, breakEvenRoas, cpa, roas } from '../src/ads';

describe('roas', () => {
  it('divides platform revenue by spend', () => {
    expect(roas(money(14000), money(7000))).toBe(2);
    expect(roas(money(0), money(7000))).toBe(0);
    expect(roas(money(10500), money(7000))).toBe(1.5);
  });
  it('returns null (not Infinity or NaN) when spend is zero', () => {
    expect(roas(money(5000), money(0))).toBeNull();
    expect(roas(money(0), money(0))).toBeNull();
  });
  it('rejects negative spend and mixed currencies', () => {
    expect(() => roas(money(1), money(-1))).toThrow(RangeError);
    expect(() => roas(money(1, 'USD'), money(1, 'EUR'))).toThrow(/currency mismatch/);
  });
});

describe('blendedRoas (MER)', () => {
  it('divides total store revenue by total ad spend', () => {
    expect(blendedRoas(money(90000), money(30000))).toBe(3);
  });
  it('returns null when there was no ad spend', () => {
    expect(blendedRoas(money(90000), money(0))).toBeNull();
  });
});

describe('breakEvenRoas', () => {
  it.each([
    [4000, 2.5],
    [10000, 1],
    [5000, 2],
    [2500, 4],
  ])('contribution %s bps -> %s', (bps, expected) => {
    expect(breakEvenRoas(bps)).toBe(expected);
  });
  it('returns null when there is no positive margin to pay for ads', () => {
    expect(breakEvenRoas(0)).toBeNull();
    expect(breakEvenRoas(-500)).toBeNull();
  });
  it('rejects fractional basis points', () => {
    expect(() => breakEvenRoas(33.5)).toThrow(RangeError);
  });
});

describe('cpa', () => {
  it('divides spend by conversions, rounding half away from zero', () => {
    expect(cpa(money(1000), 4)).toEqual(money(250));
    expect(cpa(money(1000), 3)).toEqual(money(333));
    expect(cpa(money(1001), 2)).toEqual(money(501));
  });
  it('returns null with zero conversions', () => {
    expect(cpa(money(1000), 0)).toBeNull();
    expect(cpa(money(0), 0)).toBeNull();
  });
  it('is zero when spend is zero but there were conversions', () => {
    expect(cpa(money(0), 5)).toEqual(money(0));
  });
  it('rejects negative or fractional conversions and negative spend', () => {
    expect(() => cpa(money(1000), -1)).toThrow(RangeError);
    expect(() => cpa(money(1000), 1.5)).toThrow(RangeError);
    expect(() => cpa(money(-1), 1)).toThrow(RangeError);
  });
});
