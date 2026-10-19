import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AttentionItem } from '@erq/db';
import { AttentionFeed } from './attention-feed';

const item = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  kind: 'losing_ad',
  severity: 3,
  title: 'Meta - Prospecting Broad is losing money',
  why: 'Spent $1,400 and the platform reports $2,660 in sales, below break-even.',
  action: 'Pause this campaign or cut its budget.',
  href: '/ads',
  stakeCents: 154_000,
  ...over,
});

describe('AttentionFeed', () => {
  it('renders why and the action for each item, with a link and the dollars at stake', () => {
    const html = renderToStaticMarkup(
      <AttentionFeed
        items={[item(), item({ kind: 'low_stock', title: '3 products are about to run out', href: '/inventory' })]}
      />,
    );
    expect(html).toContain('Meta - Prospecting Broad is losing money');
    expect(html).toContain('Spent $1,400 and the platform reports $2,660');
    expect(html).toContain('Pause this campaign or cut its budget.');
    expect(html).toContain('href="/ads"');
    expect(html).toContain('href="/inventory"');
    expect(html).toContain('$1,540.00');
  });

  it('shows an empty state with a next step when there is nothing to fix', () => {
    const html = renderToStaticMarkup(<AttentionFeed items={[]} />);
    expect(html).toContain('Nothing needs your attention');
    expect(html).toContain('href="/products"');
  });

  it('labels severity in words, not colour alone', () => {
    const html = renderToStaticMarkup(<AttentionFeed items={[item({ severity: 3 }), item({ severity: 1 })]} />);
    expect(html).toContain('High');
    expect(html).toContain('Low');
  });
});
