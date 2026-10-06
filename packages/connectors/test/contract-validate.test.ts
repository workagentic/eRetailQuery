import { describe, expect, it } from 'vitest';
import { sampleData } from '../src/testing';
import { validateNormalizedItem } from '../src/testing/contract';

const clone = <T>(v: T): T => structuredClone(v);
const order = () => clone(sampleData().orders[0]!);

describe('validateNormalizedItem', () => {
  it('accepts every sample item', () => {
    const d = sampleData();
    for (const r of ['locations', 'products', 'inventory', 'orders'] as const)
      for (const item of d[r]) expect(() => validateNormalizedItem(r, item)).not.toThrow();
  });
  const refunded = () => sampleData().orders.find((x) => x.refunds.length > 0)!;
  const bad = (resource: 'locations' | 'products' | 'orders', item: unknown, re: RegExp) =>
    expect(() => validateNormalizedItem(resource, item)).toThrow(re);

  it('rejects duplicate line ids, duplicate refund ids and duplicate variant ids', () => {
    const o = order();
    o.lines.push(clone(o.lines[0]!));
    bad('orders', o, /line ids in an order must be unique/);
    const p = refunded();
    p.refunds.push(clone(p.refunds[0]!));
    bad('orders', p, /refund ids in an order must be unique/);
    const prod = clone(sampleData().products[0]!);
    prod.variants.push(clone(prod.variants[0]!));
    bad('products', prod, /variant ids in a product must be unique/);
  });
  it('rejects a non-boolean location isActive', () => {
    const l = clone(sampleData().locations[0]!);
    (l as { isActive: unknown }).isActive = 'yes';
    bad('locations', l, /location\.isActive must be a boolean/);
  });
  it.each([10.5, -1])('rejects order and line cents of %j', (v) => {
    const o = order();
    o.grossCents = v;
    bad('orders', o, /order\.grossCents must be an integer/);
    const d = order();
    d.lines[0]!.discountCents = v;
    bad('orders', d, /line\.discountCents must be an integer/);
  });
  it.each([10.5, -1])('rejects refund shipping and refund line cents of %j', (v) => {
    const s = refunded();
    s.refunds[0]!.shippingRefundCents = v;
    bad('orders', s, /refund\.shippingRefundCents must be an integer/);
    const a = refunded();
    a.refunds[0]!.lines[0]!.amountCents = v;
    bad('orders', a, /refundLine\.amountCents must be an integer/);
  });
  it('rejects an empty refund line id', () => {
    const r = refunded();
    r.refunds[0]!.lines[0]!.externalLineId = '';
    bad('orders', r, /refundLine\.externalLineId must be a non-empty string/);
  });
  it('rejects a zero quantity and a non-boolean restock', () => {
    const q = order();
    q.lines[0]!.quantity = 0;
    bad('orders', q, /line\.quantity must be an integer >= 1/);
    const r = refunded();
    (r.refunds[0] as { restock: unknown }).restock = 'yes';
    bad('orders', r, /refund\.restock must be a boolean/);
  });
  it('rejects a line title that is not a string or null, and a discount above its line total', () => {
    const o = order();
    (o.lines[0] as { title: unknown }).title = 5;
    bad('orders', o, /line\.title must be a string or null/);
    const d = order();
    d.lines[0]!.discountCents = d.lines[0]!.quantity * d.lines[0]!.unitPriceCents + 1;
    bad('orders', d, /line\.discountCents must not exceed the line total/);
  });
  it('rejects extra fields', () => {
    bad('orders', { ...order(), shopifyGid: 'gid://x' }, /order has unexpected or missing fields/);
  });
  it.each([null, 'str', [], 5])('rejects the non-object item %j', (item) => {
    bad('orders', item, /item must be an object/);
    bad('products', item, /item must be an object/);
  });
  it('rejects non-array variants, lines, refunds and refund lines separately', () => {
    const p = clone(sampleData().products[0]!);
    (p as { variants: unknown }).variants = 'nope';
    bad('products', p, /product\.variants must be an array/);
    const l = order();
    (l as { lines: unknown }).lines = 'nope';
    bad('orders', l, /order\.lines must be an array/);
    const r = order();
    (r as { refunds: unknown }).refunds = {};
    bad('orders', r, /order\.refunds must be an array/);
    const rl = refunded();
    (rl.refunds[0] as { lines: unknown }).lines = 'nope';
    bad('orders', rl, /refund\.lines must be an array/);
  });
});
