import { describe, expect, it } from 'vitest';
import { slugify } from '../src/slug';

describe('slugify', () => {
  it.each([
    ['Acme Goods', 'acme-goods'],
    ['  Café  Crème!! ', 'cafe-creme'],
    ['A & B / C', 'a-b-c'],
    ['---', 'org'],
    ['日本語', 'org'],
    ['', 'org'],
  ])('%j -> %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });
  it('truncates to 40 chars without a trailing dash', () => {
    const s = slugify('a'.repeat(39) + ' b' + 'c'.repeat(20));
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith('-')).toBe(false);
  });
});
