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
