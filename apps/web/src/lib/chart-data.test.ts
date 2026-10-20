import { describe, expect, it } from 'vitest';
import { barScale, splitOfSales, waterfallSteps } from './chart-data';

const breakdown = (over: Partial<Parameters<typeof splitOfSales>[0]> = {}) => ({
  netSalesCents: 100_000,
  cogsCents: 45_000,
  fulfillmentCents: 8_000,
  feesCents: 7_000,
  adSpendCents: 20_000,
  profitCents: 20_000,
  ...over,
});

describe('splitOfSales', () => {
  it('shows where each $100 of sales goes, in cents per $100 that add up to $100', () => {
    const s = splitOfSales(breakdown());
    expect(s.segments.map((x) => x.key)).toEqual(['cogs', 'fulfillment', 'fees', 'ads', 'profit']);
    expect(s.segments.map((x) => x.per100Cents)).toEqual([4500, 800, 700, 2000, 2000]);
    expect(s.segments.reduce((a, x) => a + x.per100Cents, 0)).toBe(10_000);
    expect(s.loss).toBe(false);
  });

  it('keeps the bar widths adding up to 100% even when rounding', () => {
    const s = splitOfSales(breakdown({ netSalesCents: 30_000, cogsCents: 10_000, fulfillmentCents: 10_000, feesCents: 5_000, adSpendCents: 3_000, profitCents: 2_000 }));
    expect(Math.round(s.segments.reduce((a, x) => a + x.widthPct, 0))).toBe(100);
  });

  it('scales to total spending and marks a loss when costs exceed sales', () => {
    const s = splitOfSales(breakdown({ cogsCents: 60_000, adSpendCents: 60_000, profitCents: -35_000 }));
    expect(s.loss).toBe(true);
    expect(s.segments.find((x) => x.key === 'profit')).toBeUndefined();
    expect(s.lossPer100Cents).toBe(3500);
    expect(Math.round(s.segments.reduce((a, x) => a + x.widthPct, 0))).toBe(100);
  });

  it('is empty when there are no sales', () => {
    expect(splitOfSales(breakdown({ netSalesCents: 0, cogsCents: 0, fulfillmentCents: 0, feesCents: 0, adSpendCents: 0, profitCents: 0 })).segments).toEqual([]);
  });
});

describe('waterfallSteps', () => {
  it('walks from net sales down through each cost to money left', () => {
    const w = waterfallSteps(breakdown());
    expect(w.map((x) => x.label)).toEqual(['Net sales', 'Cost of goods', 'Fulfillment', 'Fees', 'Ads', 'Money left']);
    expect(w[0]).toMatchObject({ kind: 'total', range: [0, 100_000] });
    expect(w[1]).toMatchObject({ kind: 'cost', range: [55_000, 100_000] });
    expect(w[4]).toMatchObject({ kind: 'cost', range: [20_000, 40_000] });
    expect(w[5]).toMatchObject({ kind: 'result', range: [0, 20_000] });
  });

  it('draws a loss below zero', () => {
    const w = waterfallSteps(breakdown({ cogsCents: 60_000, adSpendCents: 60_000, profitCents: -35_000 }));
    expect(w[5]).toMatchObject({ kind: 'result', range: [-35_000, 0] });
    expect(w[4]!.range[0]).toBe(-35_000);
  });
});

describe('barScale', () => {
  it('scales bars against the largest absolute value, with a floor so small values stay visible', () => {
    expect(barScale([100, 50, -25]).map((x) => Math.round(x.widthPct))).toEqual([100, 50, 25]);
    expect(barScale([1000, 1])[1]!.widthPct).toBeGreaterThanOrEqual(2);
    expect(barScale([0, 0]).map((x) => x.widthPct)).toEqual([0, 0]);
    expect(barScale([5, -10]).map((x) => x.negative)).toEqual([false, true]);
  });
});
