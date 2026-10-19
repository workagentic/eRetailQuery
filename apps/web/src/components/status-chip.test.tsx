import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatusChip, type StatusCode } from './status-chip';

describe('StatusChip', () => {
  it('maps every pricing status to a distinct text label, not colour alone', () => {
    const codes: StatusCode[] = ['underpriced', 'healthy', 'premium', 'no_cost'];
    const labels = codes.map((c) => renderToStaticMarkup(<StatusChip status={c} />));
    expect(new Set(labels).size).toBe(4);
    expect(labels[0]).toContain('Underpriced');
    expect(labels[1]).toContain('Healthy');
    expect(labels[2]).toContain('Premium');
    expect(labels[3]).toContain('Needs cost');
  });

  it('labels ad flags and stock flags in plain English', () => {
    const text = (s: StatusCode) => renderToStaticMarkup(<StatusChip status={s} />);
    expect(text('losing')).toContain('Losing money');
    expect(text('winning')).toContain('Winning');
    expect(text('watch')).toContain('Watch');
    expect(text('learning')).toContain('Learning');
    expect(text('low')).toContain('Running low');
    expect(text('overstock')).toContain('Overstocked');
    expect(text('dead')).toContain('Dead stock');
  });
});
