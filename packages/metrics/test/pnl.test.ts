import { describe, expect, it } from 'vitest';
import { money } from '@erq/shared';
import { buildPnl, type PnlInput } from '../src/pnl';

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
