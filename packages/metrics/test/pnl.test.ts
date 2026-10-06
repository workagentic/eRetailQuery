import { describe, expect, it } from 'vitest';
import { money } from '@erq/shared';
import { buildPnl, comparePnl, sumPnl, type PnlInput } from '../src/pnl';

const input = (over: Partial<PnlInput> = {}): PnlInput => ({
  currency: 'USD',
  grossSales: money(100000),
  discounts: money(5000),
  refunds: money(3000),
  cogs: money(40000),
  shipping: money(6000),
  pickPack: money(2000),
  paymentFees: money(3000),
  marketplaceFees: money(1000),
  adSpendByPlatform: { meta: money(15000), google: money(5000) },
  otherOpex: money(12000),
  ...over,
});

describe('buildPnl: the CLAUDE.md §7.6 structure', () => {
  const p = buildPnl(input());
  it('computes every line in order', () => {
    expect(p.netSales).toEqual(money(92000));
    expect(p.cogs).toEqual(money(40000));
    expect(p.grossProfit).toEqual(money(52000));
    expect(p.fulfillment).toEqual(money(8000));
    expect(p.contributionMargin).toEqual(money(40000));
    expect(p.adSpend.total).toEqual(money(20000));
    expect(p.adSpend.byPlatform).toEqual({ meta: money(15000), google: money(5000) });
    expect(p.netContributionAfterMarketing).toEqual(money(20000));
    expect(p.estimatedOperatingProfit).toEqual(money(8000));
    expect(p.cogsComplete).toBe(true);
  });
  it('reports each profit line as basis points of net sales', () => {
    expect(p.marginsBps).toEqual({
      grossProfit: 5652,
      contributionMargin: 4348,
      netContributionAfterMarketing: 2174,
      estimatedOperatingProfit: 870,
    });
  });
  it('does not alias the input platform map', () => {
    const map = { meta: money(1) };
    const q = buildPnl(input({ adSpendByPlatform: map }));
    map.meta = money(999);
    expect(q.adSpend.byPlatform.meta).toEqual(money(1));
  });
});

describe('buildPnl: edge cases', () => {
  it('lets net sales go negative when refunds exceed sales, and gives null margins', () => {
    const p = buildPnl(
      input({
        grossSales: money(1000),
        discounts: money(0),
        refunds: money(1500),
        cogs: money(0),
        shipping: money(0),
        pickPack: money(0),
        paymentFees: money(0),
        marketplaceFees: money(0),
        adSpendByPlatform: {},
        otherOpex: money(0),
      }),
    );
    expect(p.netSales).toEqual(money(-500));
    expect(p.estimatedOperatingProfit).toEqual(money(-500));
    expect(p.marginsBps).toEqual({
      grossProfit: null,
      contributionMargin: null,
      netContributionAfterMarketing: null,
      estimatedOperatingProfit: null,
    });
  });
  it('marks profit as incomplete when COGS is missing, and counts COGS as zero', () => {
    const p = buildPnl(input({ cogs: null }));
    expect(p.cogsComplete).toBe(false);
    expect(p.cogs).toEqual(money(0));
    expect(p.grossProfit).toEqual(money(92000));
  });
  it('handles an all-zero period', () => {
    const zero = money(0);
    const p = buildPnl({
      currency: 'USD',
      grossSales: zero,
      discounts: zero,
      refunds: zero,
      cogs: zero,
      shipping: zero,
      pickPack: zero,
      paymentFees: zero,
      marketplaceFees: zero,
      adSpendByPlatform: {},
      otherOpex: zero,
    });
    expect(p.netSales).toEqual(zero);
    expect(p.adSpend.total).toEqual(zero);
    expect(p.marginsBps.grossProfit).toBeNull();
  });
  it('shows a loss as negative profit with a negative margin', () => {
    const p = buildPnl(input({ otherOpex: money(50000) }));
    expect(p.estimatedOperatingProfit).toEqual(money(-30000));
    expect(p.marginsBps.estimatedOperatingProfit).toBe(-3261);
  });
  it('rejects mixed currencies and negative inputs', () => {
    expect(() => buildPnl(input({ refunds: money(1, 'EUR') }))).toThrow(/currency mismatch/);
    expect(() => buildPnl(input({ adSpendByPlatform: { meta: money(1, 'EUR') } }))).toThrow(
      /currency mismatch/,
    );
    expect(() => buildPnl(input({ cogs: money(1, 'EUR') }))).toThrow(/currency mismatch/);
    expect(() => buildPnl(input({ discounts: money(-1) }))).toThrow(RangeError);
    expect(() => buildPnl(input({ shipping: money(-1) }))).toThrow(RangeError);
  });
});

describe('buildPnl: identities hold across a grid of inputs', () => {
  const grosses = [0, 1000, 100000];
  const discountList = [0, 500];
  const refundList = [0, 300, 2000];
  const cogsList: (number | null)[] = [null, 0, 400];
  for (const g of grosses) {
    for (const d of discountList) {
      for (const r of refundList) {
        for (const c of cogsList) {
          it(`gross ${g}, discounts ${d}, refunds ${r}, cogs ${c}`, () => {
            const p = buildPnl(
              input({
                grossSales: money(g),
                discounts: money(d),
                refunds: money(r),
                cogs: c === null ? null : money(c),
              }),
            );
            expect(p.netSales.cents).toBe(g - d - r);
            expect(p.grossProfit.cents).toBe(p.netSales.cents - p.cogs.cents);
            expect(p.contributionMargin.cents).toBe(
              p.grossProfit.cents -
                p.fulfillment.cents -
                p.paymentFees.cents -
                p.marketplaceFees.cents,
            );
            expect(p.netContributionAfterMarketing.cents).toBe(
              p.contributionMargin.cents - p.adSpend.total.cents,
            );
            expect(p.estimatedOperatingProfit.cents).toBe(
              p.netContributionAfterMarketing.cents - p.otherOpex.cents,
            );
          });
        }
      }
    }
  }
});

describe('sumPnl (breakdowns)', () => {
  const a = buildPnl(input());
  const b = buildPnl(
    input({
      grossSales: money(50000),
      cogs: null,
      adSpendByPlatform: { meta: money(1000), tiktok: money(2000) },
    }),
  );
  it('adds every line and merges platform ad spend by key', () => {
    const s = sumPnl([a, b], 'USD');
    expect(s.grossSales).toEqual(money(150000));
    expect(s.netSales).toEqual(money(a.netSales.cents + b.netSales.cents));
    expect(s.estimatedOperatingProfit).toEqual(
      money(a.estimatedOperatingProfit.cents + b.estimatedOperatingProfit.cents),
    );
    expect(s.adSpend.byPlatform).toEqual({
      meta: money(16000),
      google: money(5000),
      tiktok: money(2000),
    });
    expect(s.adSpend.total).toEqual(money(23000));
  });
  it('is incomplete when any input is incomplete', () => {
    expect(sumPnl([a, b], 'USD').cogsComplete).toBe(false);
    expect(sumPnl([a, a], 'USD').cogsComplete).toBe(true);
  });
  it('returns the single item unchanged', () => {
    expect(sumPnl([a], 'USD')).toEqual(a);
  });
  it('returns an all-zero, complete P&L for no items', () => {
    const s = sumPnl([], 'USD');
    expect(s.netSales).toEqual(money(0));
    expect(s.cogsComplete).toBe(true);
    expect(s.adSpend.byPlatform).toEqual({});
  });
  it('recomputes margins from the summed lines', () => {
    const s = sumPnl([a, a], 'USD');
    expect(s.marginsBps).toEqual(a.marginsBps);
  });
  it('rejects a P&L in another currency', () => {
    const eur = buildPnl({
      ...input(),
      currency: 'EUR',
      grossSales: money(1, 'EUR'),
      discounts: money(0, 'EUR'),
      refunds: money(0, 'EUR'),
      cogs: money(0, 'EUR'),
      shipping: money(0, 'EUR'),
      pickPack: money(0, 'EUR'),
      paymentFees: money(0, 'EUR'),
      marketplaceFees: money(0, 'EUR'),
      adSpendByPlatform: {},
      otherOpex: money(0, 'EUR'),
    });
    expect(() => sumPnl([a, eur], 'USD')).toThrow(/currency mismatch/);
  });
});

describe('comparePnl', () => {
  const previous = buildPnl(input({ grossSales: money(88000) })); // net 80000
  const current = buildPnl(input()); // net 92000
  it('gives the change in money and basis points for every line', () => {
    const c = comparePnl(current, previous);
    expect(c.netSales).toEqual({
      current: money(92000),
      previous: money(80000),
      change: money(12000),
      changeBps: 1500,
    });
    expect(c.adSpend.change).toEqual(money(0));
    expect(c.adSpend.changeBps).toBe(0);
    expect(Object.keys(c).sort()).toEqual([
      'adSpend',
      'cogs',
      'contributionMargin',
      'discounts',
      'estimatedOperatingProfit',
      'fulfillment',
      'grossProfit',
      'grossSales',
      'marketplaceFees',
      'netContributionAfterMarketing',
      'netSales',
      'otherOpex',
      'paymentFees',
      'refunds',
    ]);
  });
  it('shows a decrease as negative basis points', () => {
    const c = comparePnl(previous, current);
    expect(c.netSales.change).toEqual(money(-12000));
    expect(c.netSales.changeBps).toBe(-1304);
  });
  it('has null basis points when the previous value is zero', () => {
    const none = buildPnl(input({ discounts: money(0) }));
    const c = comparePnl(current, none);
    expect(c.discounts.changeBps).toBeNull();
    expect(c.discounts.change).toEqual(money(5000));
  });
  it('measures change against the size of a negative previous value', () => {
    const loss = buildPnl(input({ grossSales: money(8500), cogs: money(0) })); // net 500, op profit well below zero
    const gain = buildPnl(input({ grossSales: money(9500), cogs: money(0) })); // net 1500
    expect(comparePnl(gain, loss).netSales.changeBps).toBe(20000);
    const negPrev = buildPnl(input({ grossSales: money(7500), cogs: money(0) })); // net -500
    const c = comparePnl(loss, negPrev);
    expect(c.netSales.previous).toEqual(money(-500));
    expect(c.netSales.change).toEqual(money(1000));
    expect(c.netSales.changeBps).toBe(20000);
  });
  it('rejects different currencies', () => {
    const eurZero = money(0, 'EUR');
    const eur = buildPnl({
      currency: 'EUR',
      grossSales: eurZero,
      discounts: eurZero,
      refunds: eurZero,
      cogs: eurZero,
      shipping: eurZero,
      pickPack: eurZero,
      paymentFees: eurZero,
      marketplaceFees: eurZero,
      adSpendByPlatform: {},
      otherOpex: eurZero,
    });
    expect(() => comparePnl(current, eur)).toThrow(/currency mismatch/);
  });
});
