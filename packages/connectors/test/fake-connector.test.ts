import { describe, expect, it } from 'vitest';
import { PermanentError, TransientError } from '../src/errors';
import type { ConnectionContext } from '../src/types';
import { FakeConnector, runConnectorContract, sampleData } from '../src/testing';

const ctx: ConnectionContext = {
  connectionId: 'c1',
  externalAccountId: 'fake-shop',
  credentials: { token: 't' },
};

runConnectorContract({
  name: 'FakeConnector',
  create: () => ({ connector: new FakeConnector(sampleData(), 2), ctx }),
});

describe('FakeConnector', () => {
  it('pages with the given page size and ends with a null cursor', async () => {
    const c = new FakeConnector(sampleData(), 2);
    const p1 = await c.fetchPage(ctx, 'products', null, {});
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBe('2');
    const p2 = await c.fetchPage(ctx, 'products', p1.nextCursor, {});
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
  });
  it('records calls including the credentials it received', async () => {
    const c = new FakeConnector(sampleData(), 5);
    await c.fetchPage(ctx, 'locations', null, { since: new Date('2026-01-01') });
    expect(c.calls).toEqual([
      {
        resource: 'locations',
        cursor: null,
        options: { since: new Date('2026-01-01') },
        credentials: { token: 't' },
      },
    ]);
  });
  it('filters by updatedSince for incremental runs', async () => {
    const c = new FakeConnector(sampleData(), 50);
    const all = await c.fetchPage(ctx, 'orders', null, {});
    const cut = all.items[2]!.updatedAt;
    const some = await c.fetchPage(ctx, 'orders', null, { updatedSince: cut });
    expect(some.items.length).toBe(all.items.filter((o) => o.updatedAt >= cut).length);
    expect(some.items.length).toBeLessThan(all.items.length);
  });
  it('filters orders by since (backfill window)', async () => {
    const c = new FakeConnector(sampleData(), 50);
    const all = await c.fetchPage(ctx, 'orders', null, {});
    const cut = all.items[3]!.placedAt;
    const some = await c.fetchPage(ctx, 'orders', null, { since: cut });
    expect(some.items.every((o) => o.placedAt >= cut)).toBe(true);
  });
  it('throws scripted failures in order, then recovers', async () => {
    const c = new FakeConnector(sampleData(), 2);
    c.failNext(new TransientError('flaky'), 2);
    await expect(c.fetchPage(ctx, 'locations', null, {})).rejects.toThrow('flaky');
    await expect(c.fetchPage(ctx, 'locations', null, {})).rejects.toThrow('flaky');
    await expect(c.fetchPage(ctx, 'locations', null, {})).resolves.toBeTruthy();
  });
  it.each(['', ' 2 ', '1e1', '-1', '01', '1.5', 'abc', '99999999999999999999'])(
    'rejects the malformed cursor %j',
    async (bad) => {
      const fake = new FakeConnector(sampleData());
      await expect(fake.fetchPage(ctx, 'orders', bad, {})).rejects.toBeInstanceOf(PermanentError);
    },
  );
});

describe('sampleData', () => {
  it('covers online and POS orders, a refund, a cancellation and an unmapped variant', () => {
    const d = sampleData();
    expect(d.orders.some((o) => o.channel === 'shopify_pos')).toBe(true);
    expect(d.orders.some((o) => o.refunds.length > 0)).toBe(true);
    expect(d.orders.some((o) => o.status === 'cancelled')).toBe(true);
    const known = new Set(d.products.flatMap((p) => p.variants.map((v) => v.externalId)));
    expect(
      d.orders.some((o) =>
        o.lines.some((l) => l.externalVariantId && !known.has(l.externalVariantId)),
      ),
    ).toBe(true);
    expect(d.locations.length).toBeGreaterThanOrEqual(2);
  });
});
