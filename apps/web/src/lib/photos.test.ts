import { describe, expect, it } from 'vitest';
import { adPhoto } from './ad-art';
import { photoUrl, productPhoto } from './product-art';

const CATEGORIES = ['Apparel', 'Home', 'Beauty', 'Outdoor', 'Kitchen', 'Pets', 'Fitness', 'Toys'];

describe('photoUrl', () => {
  it('builds a sized Pexels CDN link from a photo id', () => {
    expect(photoUrl(8408556, 200)).toBe(
      'https://images.pexels.com/photos/8408556/pexels-photo-8408556.jpeg?auto=compress&cs=tinysrgb&w=200&h=200&fit=crop',
    );
  });
});

describe('productPhoto', () => {
  it('has a photo for every category', () => {
    for (const c of CATEGORIES) expect(productPhoto(c, 'x')).not.toBeNull();
  });
  it('is stable for the same product and uses more than one photo within a category', () => {
    expect(productPhoto('Apparel', 'Merino Base Layer')).toBe(productPhoto('Apparel', 'Merino Base Layer'));
    const seeds = ['Merino Base Layer', 'Waterproof Shell Jacket', 'Everyday Hoodie', 'Trail Running Shorts', 'Wool Hiking Socks'];
    expect(new Set(seeds.map((s) => productPhoto('Apparel', s))).size).toBeGreaterThan(1);
  });
  it('is case-insensitive and returns null for unknown or missing categories', () => {
    expect(productPhoto('apparel', 'a')).toBe(productPhoto('Apparel', 'a'));
    expect(productPhoto(null, 'a')).toBeNull();
    expect(productPhoto('Garden Gnomes', 'a')).toBeNull();
  });
});

describe('adPhoto', () => {
  it('matches a campaign by what its name says', () => {
    expect(adPhoto('Meta - Prospecting Broad', 'meta')).not.toBe(adPhoto('Meta - Retargeting', 'meta'));
    expect(adPhoto('Amazon - Sponsored Brands', 'amazon_ads')).not.toBe(adPhoto('Amazon - Sponsored Products Auto', 'amazon_ads'));
    expect(adPhoto('Google - Brand Search', 'google')).not.toBe(adPhoto('Google - Performance Max', 'google'));
  });
  it('falls back to a photo per platform, and always returns one', () => {
    for (const p of ['meta', 'google', 'amazon_ads', 'tiktok', 'unknown']) {
      expect(adPhoto('Some new campaign', p)).toBeGreaterThan(0);
    }
  });
});
