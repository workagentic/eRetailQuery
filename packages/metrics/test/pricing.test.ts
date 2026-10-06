import { describe, expect, it } from 'vitest';
import { money } from '@erq/shared';
import { DEFAULT_PRICING_CONFIG, landedCost, skuPricing, type CostComponent } from '../src/pricing';

const comp = (
  amountCents: number,
  effectiveFrom: string,
  effectiveTo: string | null = null,
  currency = 'USD',
): CostComponent => ({
  componentType: 'product_cost',
  amountCents,
  currency,
  effectiveFrom,
  effectiveTo,
});

describe('landedCost (time-versioned)', () => {
  const components = [
    comp(1000, '2025-01-01', '2025-07-01'),
    comp(1200, '2025-07-01'),
    { ...comp(100, '2025-01-01'), componentType: 'inbound_freight' },
  ];
  it.each([
    ['2024-12-31', 0],
    ['2025-01-01', 1100],
    ['2025-06-30', 1100],
    ['2025-07-01', 1300],
    ['2030-01-01', 1300],
  ])('as of %s costs %s cents', (asOf, cents) => {
    expect(landedCost(components, asOf)).toEqual(money(cents));
  });
  it('returns zero for no components, in the requested currency', () => {
    expect(landedCost([], '2025-01-01')).toEqual(money(0));
    expect(landedCost([], '2025-01-01', 'EUR')).toEqual(money(0, 'EUR'));
  });
  it('rejects mixed currencies, bad dates and fractional amounts', () => {
    expect(() => landedCost([comp(100, '2025-01-01', null, 'EUR')], '2025-01-01')).toThrow(
      /currency mismatch/,
    );
    expect(() => landedCost([], '01/02/2025')).toThrow(RangeError);
    expect(() => landedCost([comp(10.5, '2025-01-01')], '2025-01-01')).toThrow(RangeError);
  });
});

describe('DEFAULT_PRICING_CONFIG', () => {
  it('uses a 50% to 100% markup range and a 15% minimum contribution', () => {
    expect(DEFAULT_PRICING_CONFIG).toEqual({
      targetMarkupLow: 5000,
      targetMarkupHigh: 10000,
      minContribution: 1500,
    });
  });
});

describe('skuPricing: markup, margin, ideal range, status', () => {
  const landed = money(2000);
  it('shows markup and margin side by side (50% markup = 33.33% margin)', () => {
    const r = skuPricing({ price: money(3000), landed });
    expect(r.markup).toBe(5000);
    expect(r.margin).toBe(3333);
  });
  it('shows 100% markup = 50% margin', () => {
    const r = skuPricing({ price: money(4000), landed });
    expect(r.markup).toBe(10000);
    expect(r.margin).toBe(5000);
  });
  it('computes the ideal range from landed cost', () => {
    const r = skuPricing({ price: money(3000), landed });
    expect(r.idealRange).toEqual({ low: money(3000), high: money(4000) });
  });
  it.each([
    [2999, 'underpriced'],
    [3000, 'healthy'],
    [3500, 'healthy'],
    [4000, 'healthy'],
    [4001, 'premium'],
  ])('price %s is %s', (price, code) => {
    expect(skuPricing({ price: money(price), landed }).status.code).toBe(code);
  });
  it('tells the owner what to do', () => {
    expect(skuPricing({ price: money(2500), landed }).status.explanation).toBe(
      'Underpriced. Raise to at least $30.00.',
    );
    expect(skuPricing({ price: money(5000), landed }).status.explanation).toBe(
      'Premium. Check that it is still selling.',
    );
    expect(skuPricing({ price: money(3500), landed }).status.explanation).toBe('Healthy.');
  });
  it('honours a custom markup range', () => {
    const r = skuPricing({
      price: money(3000),
      landed,
      config: { targetMarkupLow: 8000, targetMarkupHigh: 12000 },
    });
    expect(r.idealRange).toEqual({ low: money(3600), high: money(4400) });
    expect(r.status.code).toBe('underpriced');
  });
  it('has an unknown status and null markup and range when cost is missing', () => {
    const r = skuPricing({ price: money(3000), landed: money(0) });
    expect(r.status.code).toBe('unknown');
    expect(r.markup).toBeNull();
    expect(r.idealRange).toBeNull();
    expect(r.margin).toBe(10000);
  });
  it('handles a zero price', () => {
    const r = skuPricing({ price: money(0), landed });
    expect(r.margin).toBeNull();
    expect(r.contributionBps).toBeNull();
    expect(r.markup).toBe(-10000);
  });
});

describe('skuPricing: contribution', () => {
  const fulfillment = {
    fixed: { outboundShipping: money(500), pickPack: money(200), paymentFee: money(30) },
    percentOfPrice: { paymentFee: 290, returnsAllowance: 200 },
  };
  it('subtracts landed cost, fixed costs and percentage costs at the net price', () => {
    const r = skuPricing({ price: money(5000), landed: money(2000), fulfillment });
    expect(r.variableCost).toEqual(money(2975));
    expect(r.contribution).toEqual(money(2025));
    expect(r.contributionBps).toBe(4050);
    expect(r.netPrice).toEqual(money(5000));
  });
  it('applies percentage fees to the discounted price', () => {
    const r = skuPricing({
      price: money(5000),
      discount: money(1000),
      landed: money(2000),
      fulfillment,
    });
    // net 4000: percent cost 196, variable 2000 + 730 + 196 = 2926, contribution 1074
    expect(r.netPrice).toEqual(money(4000));
    expect(r.contribution).toEqual(money(1074));
    expect(r.contributionBps).toBe(2685);
  });
  it('warns when markup looks fine but each sale loses money', () => {
    const r = skuPricing({
      price: money(3000),
      landed: money(2000),
      fulfillment: { fixed: { outboundShipping: money(1500) } },
    });
    expect(r.markup).toBe(5000);
    expect(r.contribution).toEqual(money(-500));
    expect(r.warning?.code).toBe('markup_ok_contribution_negative');
    expect(r.warning?.explanation).toContain('$5.00');
    expect(r.warning?.explanation).toContain('50.00%');
  });
  it('has no warning when contribution is not negative', () => {
    expect(skuPricing({ price: money(3000), landed: money(2000) }).warning).toBeNull();
  });
  it('has no warning when markup is below the target range', () => {
    const r = skuPricing({
      price: money(2200),
      landed: money(2000),
      fulfillment: { fixed: { outboundShipping: money(1500) } },
    });
    expect(r.warning).toBeNull();
  });
  it('treats missing fulfillment assumptions as zero', () => {
    const r = skuPricing({ price: money(3000), landed: money(2000) });
    expect(r.contribution).toEqual(money(1000));
  });
});

describe('skuPricing: validation', () => {
  it('rejects a discount larger than the price', () => {
    expect(() =>
      skuPricing({ price: money(1000), discount: money(1001), landed: money(500) }),
    ).toThrow(RangeError);
  });
  it('rejects mixed currencies', () => {
    expect(() => skuPricing({ price: money(1000), landed: money(500, 'EUR') })).toThrow(
      /currency mismatch/,
    );
    expect(() =>
      skuPricing({
        price: money(1000),
        landed: money(500),
        fulfillment: { fixed: { pickPack: money(1, 'EUR') } },
      }),
    ).toThrow(/currency mismatch/);
  });
  it('rejects negative or fractional percentage fees', () => {
    expect(() =>
      skuPricing({
        price: money(1000),
        landed: money(500),
        fulfillment: { percentOfPrice: { paymentFee: -1 } },
      }),
    ).toThrow(RangeError);
    expect(() =>
      skuPricing({
        price: money(1000),
        landed: money(500),
        fulfillment: { percentOfPrice: { paymentFee: 1.5 } },
      }),
    ).toThrow(RangeError);
  });
});

const fulfillmentFull = {
  fixed: { outboundShipping: money(500), pickPack: money(200), paymentFee: money(30) },
  percentOfPrice: { paymentFee: 290, returnsAllowance: 200 },
};

describe('skuPricing: floor price and maximum discount', () => {
  const base = { price: money(5000), landed: money(2000), fulfillment: fulfillmentFull };
  it('finds the lowest price that keeps the minimum contribution', () => {
    const r = skuPricing(base);
    expect(r.floorPrice).toEqual(money(3409));
    expect(r.floorExplanation).toBeNull();
  });
  it('allows a discount down to the floor, and no further', () => {
    const r = skuPricing(base);
    expect(r.maxDiscount).toEqual(money(1591));
    const atMax = skuPricing({ ...base, discount: money(1591) });
    const pastMax = skuPricing({ ...base, discount: money(1592) });
    expect(atMax.contributionBps).toBe(1502);
    expect(pastMax.contributionBps).toBe(1499);
  });
  it('has a zero maximum discount when the price is already at or below the floor', () => {
    expect(skuPricing({ ...base, price: money(3409) }).maxDiscount).toEqual(money(0));
    expect(skuPricing({ ...base, price: money(3000) }).maxDiscount).toEqual(money(0));
  });
  it('has no floor when percentage fees plus the minimum leave no room', () => {
    const r = skuPricing({
      price: money(5000),
      landed: money(2000),
      fulfillment: { percentOfPrice: { paymentFee: 9000 } }, // 90% + 15% minimum >= 100%
    });
    expect(r.floorPrice).toBeNull();
    expect(r.floorExplanation).toContain('no price reaches the minimum');
    expect(r.maxDiscount).toEqual(money(0));
  });
  it('has no floor or maximum discount when cost is unknown', () => {
    const r = skuPricing({ price: money(5000), landed: money(0), fulfillment: fulfillmentFull });
    expect(r.floorPrice).toBeNull();
    expect(r.floorExplanation).toBe('Add cost data to calculate a floor price.');
    expect(r.maxDiscount).toBeNull();
  });
  it('has no maximum discount for a zero price', () => {
    expect(skuPricing({ price: money(0), landed: money(2000) }).maxDiscount).toBeNull();
  });
  it('honours a custom minimum contribution', () => {
    const r = skuPricing({ ...base, config: { minContribution: 0 } });
    // smallest price with contribution >= 0: (2000 + 730) / (1 - 4.9%) ~ 2870.6
    expect(r.floorPrice?.cents).toBeGreaterThanOrEqual(2870);
    expect(r.floorPrice?.cents).toBeLessThanOrEqual(2872);
  });
});

describe('skuPricing: the floor price agrees with the contribution reported at that price', () => {
  const landeds = [500, 2000, 12345];
  const shippings = [0, 730];
  const pcts = [0, 490, 2900];
  const mins = [0, 1500, 3000];
  for (const landed of landeds) {
    for (const ship of shippings) {
      for (const pct of pcts) {
        for (const minC of mins) {
          it(`landed ${landed}, fixed ${ship}, pct ${pct}, min ${minC}`, () => {
            const fulfillment = {
              fixed: { outboundShipping: money(ship) },
              percentOfPrice: { paymentFee: pct },
            };
            const config = { minContribution: minC };
            const r = skuPricing({
              price: money(100000),
              landed: money(landed),
              fulfillment,
              config,
            });
            const f = r.floorPrice;
            expect(f).not.toBeNull();
            const at = (cents: number) =>
              skuPricing({ price: money(cents), landed: money(landed), fulfillment, config });
            const meets = (cents: number) => at(cents).contribution.cents * 10000 >= minC * cents;
            expect(meets(f!.cents)).toBe(true);
            if (f!.cents > 1) expect(meets(f!.cents - 1)).toBe(false);
            expect(r.maxDiscount).toEqual(money(100000 - f!.cents));
          });
        }
      }
    }
  }
});

describe('landedCost guards', () => {
  it('rejects per-batch components', () => {
    expect(() =>
      landedCost([{ ...comp(100, '2026-01-01'), perUnit: false }], '2026-02-01'),
    ).toThrow(RangeError);
  });
  it('accepts perUnit true or omitted', () => {
    expect(landedCost([{ ...comp(100, '2026-01-01'), perUnit: true }], '2026-02-01')).toEqual(
      money(100),
    );
    expect(landedCost([comp(100, '2026-01-01')], '2026-02-01')).toEqual(money(100));
  });
  it('rejects malformed effective dates', () => {
    expect(() => landedCost([comp(100, '2026/01/01')], '2026-02-01')).toThrow(RangeError);
    expect(() => landedCost([comp(100, '2026-01-01', '1/2/2027')], '2026-02-01')).toThrow(
      RangeError,
    );
  });
});

describe('skuPricing config and negative inputs', () => {
  const base = { price: money(5000), landed: money(2000) };
  it('falls back to defaults for undefined config keys', () => {
    const a = skuPricing({ ...base, config: { targetMarkupLow: undefined } });
    expect(a).toEqual(skuPricing(base));
  });
  it.each([
    [{ targetMarkupLow: 20000 }],
    [{ targetMarkupLow: -1 }],
    [{ targetMarkupHigh: NaN }],
    [{ minContribution: -1 }],
    [{ minContribution: 10000 }],
    [{ minContribution: 1.5 }],
  ])('rejects invalid config %j', (config) => {
    expect(() => skuPricing({ ...base, config })).toThrow(RangeError);
  });
  it('freezes the defaults', () => {
    expect(Object.isFrozen(DEFAULT_PRICING_CONFIG)).toBe(true);
  });
  it('rejects negative discount, landed and fixed amounts', () => {
    expect(() => skuPricing({ ...base, discount: money(-1) })).toThrow(RangeError);
    expect(() => skuPricing({ price: money(5000), landed: money(-1) })).toThrow(RangeError);
    expect(() => skuPricing({ ...base, fulfillment: { fixed: { pickPack: money(-1) } } })).toThrow(
      RangeError,
    );
  });
  it('rejects a discount in another currency', () => {
    expect(() => skuPricing({ ...base, discount: money(1, 'EUR') })).toThrow(/currency mismatch/);
  });
  it('warns exactly at the low end of the ideal range', () => {
    const r = skuPricing({
      price: money(3000),
      landed: money(2000),
      fulfillment: { fixed: { outboundShipping: money(1500) } },
    });
    expect(r.idealRange!.low).toEqual(money(3000));
    expect(r.contribution).toEqual(money(-500));
    expect(r.warning?.code).toBe('markup_ok_contribution_negative');
  });
  it('has no floor when fees plus the minimum reach 100%', () => {
    const r = skuPricing({
      price: money(5000),
      landed: money(2000),
      fulfillment: { percentOfPrice: { paymentFee: 8500 } },
    });
    expect(r.floorPrice).toBeNull();
    expect(r.maxDiscount).toEqual(money(0));
  });
  it('finds a floor just under the 100% boundary and round-trips', () => {
    const fulfillment = { percentOfPrice: { paymentFee: 8490 } };
    const r = skuPricing({ price: money(5000000), landed: money(2000), fulfillment });
    const f = r.floorPrice!.cents;
    expect(f).toBeGreaterThan(0);
    const at = (cents: number) =>
      skuPricing({ price: money(cents), landed: money(2000), fulfillment });
    expect(at(f).contribution.cents * 10000 >= 1500 * f).toBe(true);
    expect(at(f - 1).contribution.cents * 10000 >= 1500 * (f - 1)).toBe(false);
  });
});
