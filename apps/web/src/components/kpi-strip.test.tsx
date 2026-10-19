import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Overview } from '@erq/db';
import { KpiStrip } from './kpi-strip';

const m = (cents: number) => ({ cents, currency: 'USD' });
const kpis = (over: Partial<Overview['kpis']> = {}): Overview['kpis'] => ({
  revenue: { value: m(1_234_500), previous: m(1_000_000) },
  orders: { value: 310, previous: 340 },
  adSpend: { value: m(250_000), previous: m(250_000) },
  blendedRoas: { value: 4.9, previous: 4.0 },
  estimatedProfit: { value: m(180_000), previous: m(150_000) },
  marginBps: { value: 1458, previous: 1500 },
  ...over,
});

describe('KpiStrip', () => {
  it('shows revenue, orders, ad spend, blended ROAS and estimated profit with change vs the previous period', () => {
    const html = renderToStaticMarkup(<KpiStrip kpis={kpis()} />);
    expect(html).toContain('$12,345.00');
    expect(html).toContain('+23%');
    expect(html).toContain('310');
    expect(html).toContain('-9%');
    expect(html).toContain('$2,500.00');
    expect(html).toContain('4.9x');
    expect(html).toContain('Money left after ads');
    expect(html).toContain('$1,800.00');
    expect(html).toContain('14.6%');
    expect(html).toContain('vs previous period');
  });

  it('says "No ad spend" instead of a ROAS when blended ROAS is null', () => {
    const html = renderToStaticMarkup(
      <KpiStrip kpis={kpis({ blendedRoas: { value: null, previous: null } })} />,
    );
    expect(html).toContain('No ad spend');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('Infinity');
  });

  it('explains financial terms in tooltips', () => {
    const html = renderToStaticMarkup(<KpiStrip kpis={kpis()} />);
    expect(html).toContain('Blended ROAS (MER)');
    expect(html).toContain('contribution margin');
  });
});
