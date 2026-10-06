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
  it('rejects duplicate line ids and duplicate refund ids inside one order', () => {
    const o = order();
    o.lines.push(clone(o.lines[0]!));
    expect(() => validateNormalizedItem('orders', o)).toThrow();
    const p = sampleData().orders.find((x) => x.refunds.length > 0)!;
    p.refunds.push(clone(p.refunds[0]!));
    expect(() => validateNormalizedItem('orders', p)).toThrow();
  });
  it('rejects fractional cents, negative quantities and non-boolean restock', () => {
    const o = order();
    o.grossCents = 10.5;
    expect(() => validateNormalizedItem('orders', o)).toThrow();
    const q = order();
    q.lines[0]!.quantity = 0;
    expect(() => validateNormalizedItem('orders', q)).toThrow();
    const r = sampleData().orders.find((x) => x.refunds.length > 0)!;
    (r.refunds[0] as { restock: unknown }).restock = 'yes';
    expect(() => validateNormalizedItem('orders', r)).toThrow();
  });
  it('rejects a line title that is not a string or null, and a line discount above its line total', () => {
    const o = order();
    (o.lines[0] as { title: unknown }).title = 5;
    expect(() => validateNormalizedItem('orders', o)).toThrow();
    const d = order();
    d.lines[0]!.discountCents = d.lines[0]!.quantity * d.lines[0]!.unitPriceCents + 1;
    expect(() => validateNormalizedItem('orders', d)).toThrow();
  });
  it('rejects extra fields, non-objects and non-array collections', () => {
    const o = { ...order(), shopifyGid: 'gid://x' };
    expect(() => validateNormalizedItem('orders', o)).toThrow();
    expect(() => validateNormalizedItem('orders', null)).toThrow();
    const n = order();
    (n as { lines: unknown }).lines = 'nope';
    expect(() => validateNormalizedItem('orders', n)).toThrow();
  });
});
