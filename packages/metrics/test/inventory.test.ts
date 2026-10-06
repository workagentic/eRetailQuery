import { describe, expect, it } from 'vitest';
import { daysOfCover, salesVelocity, stockByLocation, stockFlags } from '../src/inventory';

describe('salesVelocity', () => {
  it('weights recent windows more (50/30/20)', () => {
    expect(salesVelocity({ units7: 14, units30: 30, units90: 90 })).toBeCloseTo(1.5, 10);
  });
  it('is zero with no sales', () => {
    expect(salesVelocity({ units7: 0, units30: 0, units90: 0 })).toBe(0);
  });
  it('honours custom weights', () => {
    expect(
      salesVelocity({ units7: 14, units30: 0, units90: 0, weights: { w7: 1, w30: 0, w90: 0 } }),
    ).toBe(2);
  });
  it('rejects weights that do not sum to 1, negative weights and negative units', () => {
    expect(() =>
      salesVelocity({
        units7: 1,
        units30: 1,
        units90: 1,
        weights: { w7: 0.5, w30: 0.5, w90: 0.5 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      salesVelocity({ units7: 1, units30: 1, units90: 1, weights: { w7: 1.5, w30: -0.5, w90: 0 } }),
    ).toThrow(RangeError);
    expect(() => salesVelocity({ units7: -1, units30: 0, units90: 0 })).toThrow(RangeError);
    expect(() => salesVelocity({ units7: Number.NaN, units30: 0, units90: 0 })).toThrow(RangeError);
  });
});

describe('daysOfCover', () => {
  it('divides available stock by velocity', () => {
    expect(daysOfCover(30, 1.5)).toBeCloseTo(20, 10);
    expect(daysOfCover(0, 2)).toBe(0);
  });
  it('is null (not Infinity) when nothing sells', () => {
    expect(daysOfCover(10, 0)).toBeNull();
    expect(daysOfCover(0, 0)).toBeNull();
  });
  it('rejects negative stock or velocity', () => {
    expect(() => daysOfCover(-1, 1)).toThrow(RangeError);
    expect(() => daysOfCover(1, -1)).toThrow(RangeError);
  });
});

describe('stockFlags: low stock', () => {
  it('fires when days of cover are below lead time plus the default 7-day buffer', () => {
    // lead 21 + buffer 7 = 28 days
    const low = stockFlags({ available: 27, velocity: 1, unitsSold90: 90, leadTimeDays: 21 });
    expect(low.low.fired).toBe(true);
    expect(low.low.explanation).toContain('27 days');
    expect(
      stockFlags({ available: 28, velocity: 1, unitsSold90: 90, leadTimeDays: 21 }).low.fired,
    ).toBe(false);
  });
  it('uses 14 days in total when the lead time is unknown', () => {
    expect(stockFlags({ available: 13, velocity: 1, unitsSold90: 90 }).low.fired).toBe(true);
    expect(stockFlags({ available: 14, velocity: 1, unitsSold90: 90 }).low.fired).toBe(false);
  });
  it('honours an explicit buffer', () => {
    expect(
      stockFlags({ available: 9, velocity: 1, unitsSold90: 90, leadTimeDays: 10, bufferDays: 0 })
        .low.fired,
    ).toBe(true);
    expect(
      stockFlags({ available: 10, velocity: 1, unitsSold90: 90, leadTimeDays: 10, bufferDays: 0 })
        .low.fired,
    ).toBe(false);
  });
  it('fires at or below the reorder point even with plenty of cover', () => {
    const f = stockFlags({ available: 5, velocity: 0.1, unitsSold90: 9, reorderPoint: 5 });
    expect(f.low.fired).toBe(true);
    expect(f.low.explanation).toContain('reorder point');
    expect(
      stockFlags({ available: 6, velocity: 0.1, unitsSold90: 9, reorderPoint: 5 }).low.fired,
    ).toBe(false);
  });
  it('fires when out of stock but selling', () => {
    expect(stockFlags({ available: 0, velocity: 2, unitsSold90: 100 }).low.fired).toBe(true);
  });
  it('does not fire for zero stock and zero sales', () => {
    const f = stockFlags({ available: 0, velocity: 0, unitsSold90: 0 });
    expect(f.low.fired).toBe(false);
    expect(f.overstock.fired).toBe(false);
    expect(f.dead.fired).toBe(false);
  });
});

describe('stockFlags: overstock and dead stock', () => {
  it('fires overstock above 180 days of cover, not at exactly 180', () => {
    expect(stockFlags({ available: 181, velocity: 1, unitsSold90: 90 }).overstock.fired).toBe(true);
    expect(stockFlags({ available: 180, velocity: 1, unitsSold90: 90 }).overstock.fired).toBe(
      false,
    );
  });
  it('does not call zero-velocity stock overstock (it is dead stock)', () => {
    const f = stockFlags({ available: 500, velocity: 0, unitsSold90: 0 });
    expect(f.overstock.fired).toBe(false);
    expect(f.dead.fired).toBe(true);
  });
  it('honours a custom overstock threshold', () => {
    expect(
      stockFlags({ available: 91, velocity: 1, unitsSold90: 90, overstockDays: 90 }).overstock
        .fired,
    ).toBe(true);
  });
  it('fires dead stock only with stock on hand and no sales in 90 days', () => {
    const dead = stockFlags({ available: 10, velocity: 0, unitsSold90: 0 });
    expect(dead.dead.fired).toBe(true);
    expect(dead.dead.explanation).toContain('no sales in 90 days');
    expect(stockFlags({ available: 10, velocity: 0.01, unitsSold90: 1 }).dead.fired).toBe(false);
  });
  it('rejects invalid input', () => {
    expect(() => stockFlags({ available: -1, velocity: 1, unitsSold90: 1 })).toThrow(RangeError);
    expect(() => stockFlags({ available: 1, velocity: -1, unitsSold90: 1 })).toThrow(RangeError);
    expect(() => stockFlags({ available: 1, velocity: 1, unitsSold90: -1 })).toThrow(RangeError);
  });
});

describe('stockByLocation', () => {
  it('subtracts reserved stock per location and totals it', () => {
    const r = stockByLocation([
      { locationId: 'A', onHand: 10, reserved: 3 },
      { locationId: 'B', onHand: 5, reserved: 8 },
    ]);
    expect(r.byLocation).toEqual([
      { locationId: 'A', available: 7 },
      { locationId: 'B', available: 0 },
    ]);
    expect(r.totalAvailable).toBe(7);
  });
  it('handles no locations', () => {
    expect(stockByLocation([])).toEqual({ byLocation: [], totalAvailable: 0 });
  });
  it('rejects negative quantities', () => {
    expect(() => stockByLocation([{ locationId: 'A', onHand: -1, reserved: 0 }])).toThrow(
      RangeError,
    );
    expect(() => stockByLocation([{ locationId: 'A', onHand: 1, reserved: -1 }])).toThrow(
      RangeError,
    );
  });
});

describe('stockFlags facts and edge cases', () => {
  it('reports the facts it used', () => {
    const r = stockFlags({
      available: 20,
      velocity: 2,
      unitsSold90: 100,
      reorderPoint: 5,
      leadTimeDays: 10,
      bufferDays: 4,
      overstockDays: 90,
    });
    expect(r.facts).toEqual({
      available: 20,
      velocity: 2,
      daysOfCover: 10,
      lowThresholdDays: 14,
      reorderPoint: 5,
      overstockDays: 90,
      unitsSold90: 100,
    });
  });
  it('uses null facts when unknown', () => {
    const r = stockFlags({ available: 5, velocity: 0, unitsSold90: 0 });
    expect(r.facts.daysOfCover).toBeNull();
    expect(r.facts.reorderPoint).toBeNull();
    expect(r.facts.lowThresholdDays).toBe(14);
    expect(r.facts.overstockDays).toBe(180);
  });
  it('says out of stock when nothing is left and low did not fire', () => {
    const r = stockFlags({ available: 0, velocity: 0, unitsSold90: 0 });
    expect(r.low.fired).toBe(false);
    expect(r.low.explanation).toBe('Out of stock, and nothing has sold in a while.');
  });
  it('fires low at reorderPoint 0 with nothing left, not with one left', () => {
    expect(
      stockFlags({ available: 0, velocity: 0, unitsSold90: 0, reorderPoint: 0 }).low.fired,
    ).toBe(true);
    expect(
      stockFlags({ available: 1, velocity: 0, unitsSold90: 0, reorderPoint: 0 }).low.fired,
    ).toBe(false);
  });
  it.each(['reorderPoint', 'leadTimeDays', 'bufferDays', 'overstockDays'])(
    'rejects NaN or negative %s',
    (key) => {
      for (const bad of [NaN, -1]) {
        expect(() => stockFlags({ available: 1, velocity: 1, unitsSold90: 1, [key]: bad })).toThrow(
          RangeError,
        );
      }
    },
  );
  it('ignores undefined options', () => {
    expect(() =>
      stockFlags({ available: 1, velocity: 1, unitsSold90: 1, leadTimeDays: undefined }),
    ).not.toThrow();
  });
});
