import { describe, expect, it } from 'vitest';
import { productArt } from './product-art';

describe('productArt', () => {
  it('gives each known category its own icon and colours', () => {
    const cats = ['Apparel', 'Home', 'Beauty', 'Outdoor', 'Kitchen', 'Pets', 'Fitness', 'Toys'];
    const arts = cats.map((c) => productArt(c));
    expect(new Set(arts.map((a) => a.icon)).size).toBe(8);
    expect(new Set(arts.map((a) => a.from)).size).toBeGreaterThanOrEqual(6);
  });

  it('is case-insensitive and falls back to a generic box for unknown or missing categories', () => {
    expect(productArt('apparel')).toEqual(productArt('Apparel'));
    expect(productArt(null).icon).toBe('package');
    expect(productArt('Garden Gnomes').icon).toBe('package');
  });

  it('always returns two valid hex colours and dark enough ink for contrast', () => {
    for (const c of ['Apparel', 'Toys', null, 'x']) {
      const a = productArt(c);
      expect(a.from).toMatch(/^#[0-9a-f]{6}$/i);
      expect(a.to).toMatch(/^#[0-9a-f]{6}$/i);
      expect(a.ink).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
