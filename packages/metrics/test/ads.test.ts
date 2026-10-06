import { describe, expect, it } from 'vitest';
import { money } from '@erq/shared';
import { blendedRoas, breakEvenRoas, classifyAd, cpa, roas, type AdDay } from '../src/ads';

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

const day = (n: number, p: Partial<AdDay> = {}): AdDay => ({
  date: `2026-09-${String(n).padStart(2, '0')}`,
  spend: money(0),
  impressions: 0,
  clicks: 0,
  conversions: 0,
  revenue: money(0),
  ...p,
});
/** Seven days that carry the totals on the first day, so only the totals matter. */
const week = (startDay: number, spend: number, revenue: number, impressions = 3500): AdDay[] =>
  Array.from({ length: 7 }, (_, i) =>
    day(startDay + i, i === 0 ? { spend: money(spend), revenue: money(revenue), impressions } : {}),
  );

describe('classifyAd with cost data (contribution before ads 40% -> break-even 2.5)', () => {
  const c = 4000;
  it('flags losing, with the estimated daily loss', () => {
    const f = classifyAd({ days: week(8, 7000, 14000), contributionBeforeAds: c });
    expect(f.code).toBe('losing');
    expect(f.roas).toBe(2);
    expect(f.breakEven).toBe(2.5);
    expect(f.estimatedDailyLoss).toEqual(money(200));
    expect(f.usedGenericBands).toBe(false);
    expect(f.explanation).toContain('Pause or fix this ad');
    expect(f.explanation).toContain('$2.00');
  });
  it('loses the whole spend when revenue is zero', () => {
    const f = classifyAd({ days: week(8, 7000, 0), contributionBeforeAds: c });
    expect(f.code).toBe('losing');
    expect(f.estimatedDailyLoss).toEqual(money(1000));
  });
  it('is not losing exactly at break-even (integer boundary)', () => {
    const f = classifyAd({ days: week(8, 7000, 17500), contributionBeforeAds: c });
    expect(f.roas).toBe(2.5);
    expect(f.code).toBe('watch');
    expect(f.estimatedDailyLoss).toBeNull();
    expect(f.explanation).toContain('above break-even');
  });
  it('is one cent of revenue below break-even -> losing', () => {
    expect(classifyAd({ days: week(8, 7000, 17499), contributionBeforeAds: c }).code).toBe(
      'losing',
    );
  });
  it('watches the band between break-even and 1.5x break-even', () => {
    expect(classifyAd({ days: week(8, 7000, 21000), contributionBeforeAds: c }).code).toBe('watch');
  });
  it('is winning at exactly 1.5x break-even (integer boundary) and above', () => {
    expect(classifyAd({ days: week(8, 7000, 26250), contributionBeforeAds: c }).code).toBe(
      'winning',
    );
    expect(classifyAd({ days: week(8, 7000, 26249), contributionBeforeAds: c }).code).toBe('watch');
    const f = classifyAd({ days: week(8, 7000, 28000), contributionBeforeAds: c });
    expect(f.code).toBe('winning');
    expect(f.explanation).toContain('Scale');
  });
  it('honours a custom winning multiple', () => {
    const f = classifyAd(
      { days: week(8, 7000, 28000), contributionBeforeAds: c },
      { winningMultiple: 2 },
    );
    expect(f.code).toBe('watch');
  });
});

describe('classifyAd trend (week over week)', () => {
  // contribution 50% -> break-even 2.0; 1.5x = 3.0
  it('watches a winning ad that dropped more than 20% from the week before', () => {
    const days = [...week(1, 7000, 31500), ...week(8, 7000, 21000)]; // 4.5 -> 3.0
    const f = classifyAd({ days, contributionBeforeAds: 5000 });
    expect(f.trend).toBe(-3333);
    expect(f.code).toBe('watch');
    expect(f.explanation).toContain('dropped');
  });
  it('keeps a winning ad winning when the drop is small', () => {
    const days = [...week(1, 7000, 23100), ...week(8, 7000, 21000)]; // 3.3 -> 3.0
    const f = classifyAd({ days, contributionBeforeAds: 5000 });
    expect(f.trend).toBe(-909);
    expect(f.code).toBe('winning');
  });
  it('has a null trend without a full previous week or with a zero-revenue previous week', () => {
    expect(
      classifyAd({ days: week(8, 7000, 21000), contributionBeforeAds: 5000 }).trend,
    ).toBeNull();
    const zeroPrev = [...week(1, 7000, 0), ...week(8, 7000, 21000)];
    expect(classifyAd({ days: zeroPrev, contributionBeforeAds: 5000 }).trend).toBeNull();
    const noSpendPrev = [...week(1, 0, 0), ...week(8, 7000, 21000)];
    expect(classifyAd({ days: noSpendPrev, contributionBeforeAds: 5000 }).trend).toBeNull();
  });
  it('shows a rising trend as positive basis points', () => {
    const days = [...week(1, 7000, 14000), ...week(8, 7000, 21000)];
    expect(classifyAd({ days, contributionBeforeAds: 5000 }).trend).toBe(5000);
  });
});

describe('classifyAd learning (never flagged losing)', () => {
  it('is learning below the minimum spend', () => {
    const f = classifyAd({ days: week(8, 4900, 0), contributionBeforeAds: 4000 });
    expect(f.code).toBe('learning');
    expect(f.explanation).toContain('Not enough data');
  });
  it('is not learning at exactly the minimum spend and impressions', () => {
    expect(classifyAd({ days: week(8, 5000, 20000, 1000), contributionBeforeAds: 4000 }).code).toBe(
      'winning',
    );
    expect(classifyAd({ days: week(8, 5000, 20000, 999), contributionBeforeAds: 4000 }).code).toBe(
      'learning',
    );
  });
  it('is learning with no spend, with null ROAS', () => {
    const f = classifyAd({ days: week(8, 0, 0), contributionBeforeAds: 4000 });
    expect(f.code).toBe('learning');
    expect(f.roas).toBeNull();
  });
  it('is learning with no days at all', () => {
    const f = classifyAd({ days: [], contributionBeforeAds: 4000 });
    expect(f.code).toBe('learning');
    expect(f.facts.daysUsed).toBe(0);
    expect(f.roas).toBeNull();
  });
  it('is learning even with no spend when the minimum spend is configured as zero', () => {
    expect(
      classifyAd(
        { days: week(8, 0, 0), contributionBeforeAds: 4000 },
        { minSpendCents: 0, minImpressions: 0 },
      ).code,
    ).toBe('learning');
  });
});

describe('classifyAd fewer than seven days', () => {
  it('judges on the days available and leaves the trend null', () => {
    const f = classifyAd({
      days: [day(1, { spend: money(6000), impressions: 2000 })],
      contributionBeforeAds: 4000,
    });
    expect(f.code).toBe('losing');
    expect(f.estimatedDailyLoss).toEqual(money(6000));
    expect(f.trend).toBeNull();
  });
});

describe('classifyAd generic bands (no usable cost data)', () => {
  it.each([
    [7000, 'losing'],
    [10499, 'losing'],
    [10500, 'watch'],
    [14000, 'watch'],
    [21000, 'watch'],
    [21001, 'winning'],
    [24500, 'winning'],
  ])('revenue %s -> %s', (revenue, code) => {
    const f = classifyAd({ days: week(8, 7000, revenue), contributionBeforeAds: null });
    expect(f.code).toBe(code);
    expect(f.usedGenericBands).toBe(true);
    expect(f.estimatedDailyLoss).toBeNull();
    expect(f.breakEven).toBeNull();
    expect(f.explanation).toContain('Add your product costs');
  });
  it('uses generic bands when the contribution is zero or negative', () => {
    expect(
      classifyAd({ days: week(8, 7000, 7000), contributionBeforeAds: 0 }).usedGenericBands,
    ).toBe(true);
    expect(
      classifyAd({ days: week(8, 7000, 7000), contributionBeforeAds: -300 }).usedGenericBands,
    ).toBe(true);
  });
  it('still never calls a low-data ad losing', () => {
    expect(classifyAd({ days: week(8, 100, 0), contributionBeforeAds: null }).code).toBe(
      'learning',
    );
  });
});

describe('classifyAd input handling', () => {
  it('sorts days by date', () => {
    const forward = classifyAd({ days: week(8, 7000, 14000), contributionBeforeAds: 4000 });
    const reversed = classifyAd({
      days: [...week(8, 7000, 14000)].reverse(),
      contributionBeforeAds: 4000,
    });
    expect(reversed).toEqual(forward);
  });
  it('rejects mixed currencies, negative spend and bad counts', () => {
    expect(() =>
      classifyAd({
        days: [day(1), day(2, { spend: money(1, 'EUR') })],
        contributionBeforeAds: 4000,
      }),
    ).toThrow(/currency mismatch/);
    expect(() =>
      classifyAd({ days: [day(1, { spend: money(-1) })], contributionBeforeAds: 4000 }),
    ).toThrow(RangeError);
    expect(() =>
      classifyAd({ days: [day(1, { impressions: -1 })], contributionBeforeAds: 4000 }),
    ).toThrow(RangeError);
    expect(() => classifyAd({ days: [day(1)], contributionBeforeAds: 40.5 })).toThrow(RangeError);
  });
  it('reports its facts', () => {
    const f = classifyAd({ days: week(8, 7000, 14000), contributionBeforeAds: 4000 });
    expect(f.facts).toMatchObject({
      currency: 'USD',
      daysUsed: 7,
      spend: money(7000),
      revenue: money(14000),
      impressions: 3500,
      contributionBeforeAds: 4000,
    });
  });
});
