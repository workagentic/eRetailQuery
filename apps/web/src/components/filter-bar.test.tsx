import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FilterBar } from './filter-bar';

describe('FilterBar', () => {
  it('builds links with ? and & in the right places', () => {
    const html = renderToStaticMarkup(
      <FilterBar path="/dashboard" filters={{ preset: '30d', channel: 'all' }} />,
    );
    expect(html).toContain('href="/dashboard?range=7d&amp;channel=all"');
    expect(html).toContain('href="/dashboard?range=30d&amp;channel=amazon"');
  });

  it('keeps extra query params such as the selected month when a channel is chosen', () => {
    const html = renderToStaticMarkup(
      <FilterBar
        path="/reports"
        query={{ month: '2026-06' }}
        showRange={false}
        filters={{ preset: '30d', channel: 'all' }}
      />,
    );
    expect(html).toContain('href="/reports?month=2026-06&amp;range=30d&amp;channel=amazon"');
    expect(html).not.toMatch(/\?[^"]*\?/);
  });
});
