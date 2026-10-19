import { describe, expect, it } from 'vitest';
import { parseFilters, parseMonth } from './filters';

describe('parseFilters', () => {
  it('defaults to the last 30 days and all channels', () => {
    expect(parseFilters({})).toEqual({ preset: '30d', channel: 'all' });
  });
  it('reads valid values', () => {
    expect(parseFilters({ range: '90d', channel: 'amazon' })).toEqual({
      preset: '90d',
      channel: 'amazon',
    });
    expect(parseFilters({ range: 'mtd', channel: 'shopify_online' })).toEqual({
      preset: 'mtd',
      channel: 'shopify_online',
    });
  });
  it('falls back to 30d and all on garbage, and takes the first of repeated values', () => {
    expect(parseFilters({ range: 'forever', channel: '<script>' })).toEqual({
      preset: '30d',
      channel: 'all',
    });
    expect(parseFilters({ range: ['7d', '90d'], channel: ['amazon', 'all'] })).toEqual({
      preset: '7d',
      channel: 'amazon',
    });
  });
});

describe('parseMonth', () => {
  it('accepts YYYY-MM and rejects everything else', () => {
    expect(parseMonth('2026-03')).toBe('2026-03');
    for (const bad of [undefined, '2026-3', '2026-13', '2026-00', 'March', '2026-03-01', ['2026-03']]) {
      expect(parseMonth(bad as string | undefined)).toBeNull();
    }
  });
});
