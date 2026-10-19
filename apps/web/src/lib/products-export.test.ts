import { describe, expect, it } from 'vitest';
import type { ProductRow } from '@erq/db';
import { productsCsvResponse, toCsv } from './products-export';

const row = (over: Partial<ProductRow> = {}): ProductRow => ({
  skuId: '1',
  skuCode: 'DEMO-1-1',
  title: 'Trail Shoe, "Pro"',
  category: 'Outdoor',
  priceCents: 4999,
  landedCents: 3000,
  markupBps: 6663,
  marginBps: 3999,
  idealLowCents: 4500,
  idealHighCents: 6000,
  pricingStatus: 'healthy',
  contributionNegative: false,
  unitsSold: 12,
  revenueCents: 59988,
  profitCents: 1234,
  message: 'Healthy.',
  ...over,
});

describe('toCsv', () => {
  it('has a header row and one row per SKU, escaping commas and quotes', () => {
    const csv = toCsv([row(), row({ skuCode: 'DEMO-1-2', title: 'Plain' })]);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('SKU,Product,Category,Price');
    expect(lines[1]).toContain('"Trail Shoe, ""Pro"""');
    expect(lines[1]).toContain(',49.99,30.00,');
    expect(lines[2]).toContain('DEMO-1-2,Plain,');
  });
  it('leaves unknown values empty and neutralises spreadsheet formulas', () => {
    const csv = toCsv([row({ title: '=HYPERLINK("x")', landedCents: null, profitCents: null, markupBps: null })]);
    const line = csv.trimEnd().split('\r\n')[1]!;
    expect(line).toContain("'=HYPERLINK");
    expect(line).not.toContain('null');
  });
});

describe('productsCsvResponse', () => {
  it('returns 401 without a session', async () => {
    const res = await productsCsvResponse({ isSignedIn: async () => false, loadRows: async () => [row()] });
    expect(res.status).toBe(401);
  });
  it('returns the CSV as an attachment for a signed-in user', async () => {
    const res = await productsCsvResponse({ isSignedIn: async () => true, loadRows: async () => [row()] });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect((await res.text()).split('\r\n')[0]).toContain('SKU');
  });
});
