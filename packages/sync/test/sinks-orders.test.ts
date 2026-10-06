import { sampleData } from '@erq/connectors/testing';
import type { NormalizedOrder } from '@erq/connectors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertLocations } from '../src/sinks/locations';
import { upsertOrders } from '../src/sinks/orders';
import { upsertProducts } from '../src/sinks/products';
import { CONN_A, ORG_A, ORG_B, seedCost, sinkContext, startEnv, type TestEnv } from './helpers';

let env: TestEnv;
const data = sampleData();
const [o1, o2, o3, o4, o5] = data.orders as [NormalizedOrder, NormalizedOrder, NormalizedOrder, NormalizedOrder, NormalizedOrder];

beforeAll(async () => {
  env = await startEnv();
  const ctx = sinkContext();
  await env.db.withTenant(ORG_A, async (tx) => {
    await upsertLocations(tx, ctx, data.locations);
    await upsertProducts(tx, ctx, data.products); // TSHIRT-S/M cost 800, MUG-1 cost 300, poster has no cost
  });
});
afterAll(async () => { await env?.stop(); });

const run = (items: NormalizedOrder[], ctx = sinkContext()) => env.db.withTenant(ctx.orgId, (tx) => upsertOrders(tx, ctx, items));
const count = async (table: string) => Number((await env.owner.query(`select count(*) c from ${table} where org_id = $1`, [ORG_A])).rows[0].c);
const order = async (ext: string) => (await env.owner.query(`select * from orders where org_id = $1 and external_order_id = $2`, [ORG_A, ext])).rows[0];
const lines = async (ext: string) =>
  (await env.owner.query(
    `select ol.external_line_id, ol.sku_id, ol.quantity, ol.unit_cogs_cents_snapshot, ol.refunded_quantity
       from order_lines ol join orders o on o.id = ol.order_id where o.org_id = $1 and o.external_order_id = $2 order by 1`, [ORG_A, ext])).rows;

describe('upsertOrders', () => {
  it('stores orders, lines, refunds and cost snapshots', async () => {
    expect(await run([o1, o2, o3, o4, o5])).toEqual({ processed: 5, skipped: 0 });
    expect(await count('orders')).toBe(5);
    expect(await count('order_lines')).toBe(6);
    expect(await count('refunds')).toBe(1);
    expect(await count('refund_lines')).toBe(1);

    const a = await order('o-1');
    expect([a.channel, a.status, Number(a.gross_cents), Number(a.discount_cents), Number(a.refund_cents), Number(a.net_cents)]).toEqual(['shopify_online', 'closed', 7500, 100, 0, 7400]);
    expect(a.customer_external_id).toBe('cust-1');
    const l1 = await lines('o-1');
    expect(l1.map((l) => Number(l.unit_cogs_cents_snapshot ?? -1))).toEqual([800, -1]); // t-shirt costed; poster has no cost => null, not zero
  });

  it('tags POS orders and snapshots their cost', async () => {
    expect((await order('o-2')).channel).toBe('shopify_pos');
    expect(Number((await lines('o-2'))[0]!.unit_cogs_cents_snapshot)).toBe(300);
  });

  it('records refunds: refund_cents, net_cents and refunded quantity', async () => {
    const r = await order('o-3');
    expect([Number(r.refund_cents), Number(r.net_cents)]).toEqual([2500, 0]);
    expect((await lines('o-3'))[0]!.refunded_quantity).toBe(1);
  });

  it('keeps cancelled and test orders, and leaves unmapped variants with a null sku', async () => {
    const c = await order('o-4');
    expect(c.status).toBe('cancelled');
    expect(c.cancelled_at).not.toBeNull();
    expect((await order('o-5')).is_test).toBe(true);
    const l = (await lines('o-5'))[0]!;
    expect(l.sku_id).toBeNull();
    expect(l.unit_cogs_cents_snapshot).toBeNull();
  });

  it('is idempotent', async () => {
    const before = [await count('orders'), await count('order_lines'), await count('refunds'), await count('refund_lines')];
    await run([o1, o2, o3, o4, o5]);
    expect([await count('orders'), await count('order_lines'), await count('refunds'), await count('refund_lines')]).toEqual(before);
  });

  it('ignores an older version of an order (a late webhook cannot undo a refund)', async () => {
    const stale: NormalizedOrder = { ...o3, refunds: [], updatedAt: new Date('2026-09-07T10:00:00Z') };
    expect(await run([stale])).toEqual({ processed: 0, skipped: 1 });
    expect(Number((await order('o-3')).refund_cents)).toBe(2500);
    expect((await lines('o-3'))[0]!.refunded_quantity).toBe(1);
  });

  it('applies a newer version: a refund added later updates totals and quantities', async () => {
    const newer: NormalizedOrder = {
      ...o1, updatedAt: new Date('2026-09-12T10:00:00Z'),
      refunds: [{ externalId: 'r-9', refundedAt: new Date('2026-09-12T10:00:00Z'), amountCents: 2500, shippingRefundCents: 0, restock: false, lines: [{ externalLineId: 'l-1', quantity: 1, amountCents: 2500 }] }],
    };
    await run([newer]);
    await run([newer]); // replay
    const a = await order('o-1');
    expect([Number(a.refund_cents), Number(a.net_cents)]).toEqual([2500, 4900]);
    expect((await lines('o-1'))[0]!.refunded_quantity).toBe(1);
    expect(await count('refunds')).toBe(2);
  });

  it('never changes a snapshot once set, even if costs change later', async () => {
    const sku = (await lines('o-1'))[0]!.sku_id as string;
    await seedCost(env.owner, ORG_A, sku, 1000, { from: '2026-02-01' }); // an extra, overlapping component
    await run([{ ...o1, updatedAt: new Date('2026-09-13T10:00:00Z') }]);
    expect(Number((await lines('o-1'))[0]!.unit_cogs_cents_snapshot)).toBe(800);
  });

  it('uses the org-timezone order date for snapshots (and null before the cost existed)', async () => {
    // 2026-01-01T02:00Z is still 2025-12-31 in New York, before the mug cost took effect on 2026-01-01.
    const early: NormalizedOrder = { ...o2, externalId: 'o-tz', placedAt: new Date('2026-01-01T02:00:00Z'), updatedAt: new Date('2026-01-02T00:00:00Z') };
    await run([early]);
    expect((await lines('o-tz'))[0]!.unit_cogs_cents_snapshot).toBeNull();
    const later: NormalizedOrder = { ...o2, externalId: 'o-tz2', placedAt: new Date('2026-01-01T06:00:00Z'), updatedAt: new Date('2026-01-02T00:00:00Z') };
    await run([later]); // 2026-01-01 01:00 in New York: cost in effect
    expect(Number((await lines('o-tz2'))[0]!.unit_cogs_cents_snapshot)).toBe(300);
  });

  it('fills the sku of a previously unmapped line once the variant is known', async () => {
    await env.db.withTenant(ORG_A, (tx) =>
      upsertProducts(tx, sinkContext(), [{ externalId: 'p-late', title: 'Late', brand: null, category: null, status: 'active', updatedAt: new Date('2026-09-01T00:00:00Z'),
        variants: [{ externalId: 'v-999', skuCode: 'LATE-1', barcode: null, priceCents: 900, compareAtPriceCents: null, currency: 'USD', unitCostCents: 400, updatedAt: new Date('2026-09-01T00:00:00Z') }] }]));
    await run([{ ...o5, updatedAt: new Date('2026-09-14T00:00:00Z') }]);
    const l = (await lines('o-5'))[0]!;
    expect(l.sku_id).not.toBeNull();
    expect(Number(l.unit_cogs_cents_snapshot)).toBe(400);
  });

  it('keeps net = gross - discount - refund for every order', async () => {
    const { rows } = await env.owner.query(`select count(*)::int c from orders where org_id = $1 and net_cents <> gross_cents - discount_cents - refund_cents`, [ORG_A]);
    expect(rows[0].c).toBe(0);
  });

  it('handles an empty page and cannot write another tenant\'s connection', async () => {
    expect(await run([])).toEqual({ processed: 0, skipped: 0 });
    await expect(run([o1], sinkContext({ orgId: ORG_B, connectionId: CONN_A }))).rejects.toBeTruthy();
  });
});
