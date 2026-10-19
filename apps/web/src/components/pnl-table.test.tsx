import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildPnl, comparePnl, type Pnl } from '@erq/metrics';
import { money } from '@erq/shared';
import { PnlTable } from './pnl-table';

const c = (cents: number) => money(cents, 'USD');
const pnl = (scale = 1, cogsComplete = true): Pnl =>
  buildPnl({
    currency: 'USD',
    grossSales: c(1_000_000 * scale),
    discounts: c(50_000 * scale),
    refunds: c(20_000 * scale),
    cogs: cogsComplete ? c(400_000 * scale) : null,
    shipping: c(60_000 * scale),
    pickPack: c(0),
    paymentFees: c(30_000 * scale),
    marketplaceFees: c(90_000 * scale),
    adSpendByPlatform: { meta: c(100_000 * scale), google: c(50_000 * scale) },
    otherOpex: c(0),
  });

const render = (over: { current?: Pnl; previous?: Pnl; year?: Pnl | null; costComplete?: boolean } = {}) => {
  const current = over.current ?? pnl(1);
  const previous = over.previous ?? pnl(0.8);
  return renderToStaticMarkup(
    <PnlTable
      current={current}
      previous={previous}
      sameMonthLastYear={over.year === undefined ? pnl(0.5) : over.year}
      comparison={comparePnl(current, previous)}
      costComplete={over.costComplete ?? true}
    />,
  );
};

describe('PnlTable', () => {
  it('renders the CLAUDE.md 7.6 lines in order, from gross sales to estimated operating profit', () => {
    const html = render();
    const order = [
      'Gross sales',
      'Discounts',
      'Refunds and returns',
      'Net sales',
      'Cost of goods',
      'Gross profit',
      'Fulfillment',
      'Payment processing fees',
      'Marketplace fees',
      'Contribution margin',
      'Ad spend',
      'Net contribution after marketing',
      'Other operating expenses',
      'Estimated operating profit',
    ];
    const at = order.map((label) => html.indexOf(label));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('breaks ad spend down by platform', () => {
    const html = render();
    expect(html).toContain('Meta');
    expect(html).toContain('Google');
  });

  it('shows a "cost data incomplete" notice when cost of goods is missing', () => {
    expect(render({ current: pnl(1, false), costComplete: false })).toContain('cost data incomplete');
    expect(render()).not.toContain('cost data incomplete');
  });

  it('shows change versus last month and the same month last year, or "No data"', () => {
    const html = render();
    expect(html).toContain('+25%');
    expect(html).toContain('$10,000.00');
    expect(html).toContain('$5,000.00');
    expect(render({ year: null })).toContain('No data');
  });

  it('carries the management-estimate disclaimer and tooltips for financial terms', () => {
    const html = render();
    expect(html).toContain('management estimates');
    expect(html).toContain('not accounting or tax filings');
    expect(html).toContain('Cost of goods (COGS)');
  });
});
