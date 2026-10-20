import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AdThumb } from './ad-thumb';
import { BarList } from './bar-list';
import { ChannelBars } from './channel-bars';
import { PnlWaterfall } from './pnl-waterfall';
import { ProductThumb } from './product-thumb';
import { SalesSplit } from './sales-split';
import { SegmentBar } from './segment-bar';
import { Sparkline } from './sparkline';
import { TrendChart } from './trend-chart';

const breakdown = {
  netSalesCents: 100_000,
  cogsCents: 45_000,
  fulfillmentCents: 8_000,
  feesCents: 7_000,
  adSpendCents: 20_000,
  profitCents: 20_000,
};

describe('SalesSplit', () => {
  it('says how much you keep of every $100 and names each part with its amount', () => {
    const html = renderToStaticMarkup(<SalesSplit breakdown={breakdown} />);
    expect(html).toContain('You keep');
    expect(html).toContain('$20.00');
    for (const part of ['Cost of goods', 'Shipping and fulfillment', 'Payment and marketplace fees', 'Ads', 'Money left']) {
      expect(html).toContain(part);
    }
    expect(html).toContain('$45.00 per $100');
  });

  it('says you lose money when costs exceed sales', () => {
    const html = renderToStaticMarkup(
      <SalesSplit breakdown={{ ...breakdown, cogsCents: 60_000, adSpendCents: 60_000, profitCents: -35_000 }} />,
    );
    expect(html).toContain('You lose');
    expect(html).toContain('$35.00');
    expect(html).not.toContain('Money left</span>');
  });

  it('renders nothing when there are no sales', () => {
    expect(renderToStaticMarkup(<SalesSplit breakdown={{ ...breakdown, netSalesCents: 0, cogsCents: 0, fulfillmentCents: 0, feesCents: 0, adSpendCents: 0, profitCents: 0 }} />)).toBe('');
  });
});

describe('BarList', () => {
  it('draws a bar per item, a break-even tick, and red for negative values', () => {
    const html = renderToStaticMarkup(
      <BarList
        empty="none"
        items={[
          { key: 'a', label: 'Meta', value: 4, valueLabel: '4.0x', marker: 2, markerLabel: 'Break-even 2.0x' },
          { key: 'b', label: 'Loss', value: -3, valueLabel: '-$3' },
        ]}
      />,
    );
    expect(html).toContain('Meta');
    expect(html).toContain('Break-even 2.0x');
    expect(html).toContain('background:#b91c1c');
    expect(html).toContain('width:100%');
  });
  it('shows the empty message when there is nothing to draw', () => {
    expect(renderToStaticMarkup(<BarList empty="Nothing here." items={[]} />)).toContain('Nothing here.');
  });
});

describe('SegmentBar', () => {
  it('names every segment in text, not colour alone', () => {
    const html = renderToStaticMarkup(
      <SegmentBar segments={[{ key: 'a', label: 'Healthy', color: '#15803d', widthPct: 60, valueLabel: '12 products' }, { key: 'b', label: 'Underpriced', color: '#b91c1c', widthPct: 40, valueLabel: '8 products' }]} />,
    );
    expect(html).toContain('Healthy');
    expect(html).toContain('12 products');
    expect(html).toContain('aria-label="Healthy 12 products, Underpriced 8 products"');
  });
});

describe('ProductThumb', () => {
  it('shows a stock photo for a known category, hidden from screen readers and without a referrer', () => {
    const html = renderToStaticMarkup(<ProductThumb category="Apparel" seed="Merino Base Layer" />);
    expect(html).toContain('<img');
    expect(html).toContain('https://images.pexels.com/photos/');
    expect(html).toContain('alt=""');
    expect(html).toContain('loading="lazy"');
    expect(html).toMatch(/referrer[Pp]olicy="no-referrer"/);
  });
  it('falls back to category artwork when there is no photo for the category', () => {
    const html = renderToStaticMarkup(<ProductThumb category={null} />);
    expect(html).not.toContain('<img');
    expect(html).toContain('<svg');
    expect(html).toContain('aria-hidden="true"');
  });
});

describe('AdThumb', () => {
  it('shows the campaign photo with its platform badge', () => {
    const html = renderToStaticMarkup(<AdThumb name="Meta - Prospecting Broad" platform="meta" />);
    expect(html).toContain('<img');
    expect(html).toContain('images.pexels.com/photos/7625042/');
    expect(html).toContain('title="Meta"');
  });
});

describe('charts render on the server without throwing', () => {
  it('draws a sparkline with the series colour', () => {
    const html = renderToStaticMarkup(<Sparkline values={[1, 3, 2, 5]} color="#0d9488" id="t" />);
    expect(html).toContain('<svg');
    expect(html).toContain('#0d9488');
  });
  it('wraps the trend, channel and waterfall charts with a text description', () => {
    expect(renderToStaticMarkup(<TrendChart data={[{ date: '2026-03-01', revenue: 1000, profit: 200 }]} />)).toContain('aria-label="Daily revenue');
    expect(renderToStaticMarkup(<ChannelBars data={[{ name: 'Shopify', revenue: 1000, profit: 200 }]} />)).toContain('Shopify: revenue');
    expect(renderToStaticMarkup(<PnlWaterfall breakdown={breakdown} />)).toContain('From net sales of');
  });
});
