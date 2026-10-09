import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { linkOrderLines } from '../src/linkup';
import {
  CONN_A,
  CONN_B,
  ORG_A,
  ORG_B,
  seedCost,
  seedListing,
  seedOrder,
  seedSku,
  startEnv,
  type TestEnv,
} from './helpers';

let env: TestEnv;
const CONN_A2 = 'aaaaaaaa-0000-4aaa-8aaa-000000000002'; // a second connection of org A
beforeAll(async () => {
  env = await startEnv();
  await env.owner.query(
    `insert into store_connections (id, org_id, platform, external_account_id, status) values ($1, $2, 'shopify', 'shop-a2', 'active')`,
    [CONN_A2, ORG_A],
  );
});
afterAll(async () => {
  await env?.stop();
});
beforeEach(async () => {
  for (const t of [
    'order_lines',
    'orders',
    'sku_cost_components',
    'sku_channel_listings',
    'skus',
    'products',
  ]) {
    await env.owner.query(`delete from ${t}`);
  }
});

const line = async (orderId: string) =>
  (
    await env.owner.query(
      `select sku_id, unit_cogs_cents_snapshot as cogs from order_lines where order_id = $1 order by external_line_id`,
      [orderId],
    )
  ).rows;
async function orderWithLines(
  orgId: string,
  connectionId: string,
  externalId: string,
  placedAt: string,
  variants: (string | null)[],
  skuId: string | null = null,
) {
  const orderId = await seedOrder(env.owner, {
    orgId,
    connectionId,
    externalId,
    placedAt,
    lines: variants.map((_v, i) => ({ skuId, qty: 1, externalLineId: `l-${i + 1}` })),
  });
  for (const [i, v] of variants.entries()) {
    await env.owner.query(
      `update order_lines set external_variant_id = $2 where order_id = $1 and external_line_id = $3`,
      [orderId, v, `l-${i + 1}`],
    );
  }
  return orderId;
}
const args = { orgId: ORG_A, connectionId: CONN_A };

describe('linkOrderLines', () => {
  it('links the line and fills the cost in effect on the ORDER date in the org timezone', async () => {
    const sku = await seedSku(env.owner, ORG_A, 'LATE');
    await seedCost(env.owner, ORG_A, sku, 700, { from: '2026-01-01', to: '2026-02-28' });
    await seedCost(env.owner, ORG_A, sku, 900, { from: '2026-03-01' });
    await seedListing(env.owner, ORG_A, CONN_A, sku, 'v-9');
    // 03:30 UTC on 2 March is still 1 March in New York (org A): the 900 cost applies, and today's cost never does.
    const march = await orderWithLines(ORG_A, CONN_A, 'o-march', '2026-03-02T03:30:00Z', ['v-9']);
    const february = await orderWithLines(ORG_A, CONN_A, 'o-feb', '2026-02-10T15:00:00Z', ['v-9']);
    expect(await linkOrderLines(env.db, args)).toEqual({ linked: 2 });
    expect(await line(march)).toEqual([{ sku_id: sku, cogs: '900' }]);
    expect(await line(february)).toEqual([{ sku_id: sku, cogs: '700' }]);
  });
  it('is idempotent, and a later cost change never rewrites a snapshot', async () => {
    const sku = await seedSku(env.owner, ORG_A, 'IDEM');
    await seedCost(env.owner, ORG_A, sku, 500, { from: '2026-01-01' });
    await seedListing(env.owner, ORG_A, CONN_A, sku, 'v-1');
    const order = await orderWithLines(ORG_A, CONN_A, 'o-1', '2026-03-05T12:00:00Z', ['v-1']);
    expect(await linkOrderLines(env.db, args)).toEqual({ linked: 1 });
    await seedCost(env.owner, ORG_A, sku, 999, { from: '2026-02-01', type: 'packaging' });
    expect(await linkOrderLines(env.db, args)).toEqual({ linked: 0 });
    expect(await line(order)).toEqual([{ sku_id: sku, cogs: '500' }]);
  });
  it('leaves a snapshot that is already set, and a line that already has a SKU, alone', async () => {
    const sku = await seedSku(env.owner, ORG_A, 'NEW');
    const other = await seedSku(env.owner, ORG_A, 'OLD');
    await seedCost(env.owner, ORG_A, sku, 500, { from: '2026-01-01' });
    await seedListing(env.owner, ORG_A, CONN_A, sku, 'v-1');
    const kept = await orderWithLines(ORG_A, CONN_A, 'o-kept', '2026-03-05T12:00:00Z', ['v-1']);
    await env.owner.query(
      `update order_lines set unit_cogs_cents_snapshot = 123 where order_id = $1`,
      [kept],
    );
    const linked = await orderWithLines(
      ORG_A,
      CONN_A,
      'o-linked',
      '2026-03-05T12:00:00Z',
      ['v-1'],
      other,
    );
    await linkOrderLines(env.db, args);
    expect(await line(kept)).toEqual([{ sku_id: sku, cogs: '123' }]);
    expect(await line(linked)).toEqual([{ sku_id: other, cogs: null }]); // never relinked
  });
  it('leaves unmatched lines unlinked: an unknown variant and a line with no variant', async () => {
    const sku = await seedSku(env.owner, ORG_A, 'ONE');
    await seedListing(env.owner, ORG_A, CONN_A, sku, 'v-1');
    const order = await orderWithLines(ORG_A, CONN_A, 'o-1', '2026-03-05T12:00:00Z', [
      'v-unknown',
      null,
      'v-1',
    ]);
    expect(await linkOrderLines(env.db, args)).toEqual({ linked: 1 });
    expect((await line(order)).map((r) => r.sku_id)).toEqual([null, null, sku]);
  });
  it("never touches another connection's lines, or another org's lines with the same variant id", async () => {
    const skuA = await seedSku(env.owner, ORG_A, 'A');
    const skuB = await seedSku(env.owner, ORG_B, 'B');
    await seedListing(env.owner, ORG_A, CONN_A, skuA, 'v-shared');
    await seedListing(env.owner, ORG_B, CONN_B, skuB, 'v-shared');
    const mine = await orderWithLines(ORG_A, CONN_A, 'o-a', '2026-03-05T12:00:00Z', ['v-shared']);
    const sibling = await orderWithLines(ORG_A, CONN_A2, 'o-a2', '2026-03-05T12:00:00Z', [
      'v-shared',
    ]); // no listing on CONN_A2
    const theirs = await orderWithLines(ORG_B, CONN_B, 'o-b', '2026-03-05T12:00:00Z', ['v-shared']);
    expect(await linkOrderLines(env.db, args)).toEqual({ linked: 1 });
    expect((await line(mine))[0]!.sku_id).toBe(skuA);
    expect((await line(sibling))[0]!.sku_id).toBeNull();
    expect((await line(theirs))[0]!.sku_id).toBeNull();
  });
  it('is bounded: batches of the given size, at most maxBatches batches, finishing on the next call', async () => {
    const sku = await seedSku(env.owner, ORG_A, 'MANY');
    await seedListing(env.owner, ORG_A, CONN_A, sku, 'v-1');
    await orderWithLines(
      ORG_A,
      CONN_A,
      'o-many',
      '2026-03-05T12:00:00Z',
      Array.from({ length: 7 }, () => 'v-1'),
    );
    expect(await linkOrderLines(env.db, args, { batchSize: 3, maxBatches: 2 })).toEqual({
      linked: 6,
    });
    expect(await linkOrderLines(env.db, args, { batchSize: 3, maxBatches: 2 })).toEqual({
      linked: 1,
    });
    expect(await linkOrderLines(env.db, args, { batchSize: 3, maxBatches: 2 })).toEqual({
      linked: 0,
    });
  });
  it('does nothing when there is nothing to link', async () => {
    expect(await linkOrderLines(env.db, args)).toEqual({ linked: 0 });
  });
});
