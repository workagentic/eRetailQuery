import {
  ConnectorRegistry,
  ORDERS_PAGE_SIZE,
  createShopifyConnector,
  encryptConnectionCredentials,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from '@erq/connectors';
import { createShopifyFixture, gqlThrottled, type ShopifyFixture } from '@erq/connectors/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enqueueSync } from '../src/engine/start';
import { drain, makeHarness, resetSync } from './engine-helpers';
import { CONN_A, ORG_A, startEnv, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env?.stop();
});
beforeEach(async () => {
  await resetSync(env);
  for (const t of [
    'refund_lines',
    'refunds',
    'order_lines',
    'orders',
    'inventory_movements',
    'inventory_levels',
    'sku_channel_listings',
    'sku_cost_components',
    'skus',
    'products',
    'locations',
  ]) {
    await env.owner.query(`delete from ${t} where org_id = $1`, [ORG_A]);
  }
  await env.owner.query(
    `update store_connections set status = 'active', last_error = null, last_synced_at = null where id = $1`,
    [CONN_A],
  );
});

const SHOP = 'fixture-shop.myshopify.com';
// The harness clock starts at 2026-10-06T12:00:00Z: twelve months back covers the fixture's March 2026 orders.
const since = new Date('2025-10-06T12:00:00Z');
const RUN_TIME = '2026-10-06T12:00:00.000Z';

type Rewrite = (op: string, res: HttpResponse, callIndex: number) => HttpResponse;

/** Sits between the connector and the fake shop so a test can alter one response. */
function rewriting(inner: HttpClient, rewrite: Rewrite): HttpClient {
  const seen = new Map<string, number>();
  return {
    async request(req: HttpRequest) {
      const res = await inner.request(req);
      const op = (JSON.parse(req.body ?? '{}') as { operationName?: string }).operationName ?? '';
      const index = seen.get(op) ?? 0;
      seen.set(op, index + 1);
      return rewrite(op, res, index);
    },
  };
}

async function setup(
  opts: { extraOrders?: number; rewrite?: Rewrite; sleep?: (ms: number) => Promise<void> } = {},
) {
  const fixture = createShopifyFixture({ extraOrders: opts.extraOrders });
  const http = opts.rewrite ? rewriting(fixture.admin, opts.rewrite) : fixture.admin;
  const connectors = new ConnectorRegistry().register(
    'shopify',
    createShopifyConnector({ http, sleep: opts.sleep }),
  );
  const h = makeHarness(env, { connectors });
  await env.owner.query(
    `update store_connections set external_account_id = $2, encrypted_credentials = $3 where id = $1`,
    [
      CONN_A,
      SHOP,
      encryptConnectionCredentials({ accessToken: 'shpat_fixture' }, h.keyProvider, CONN_A),
    ],
  );
  return { h, fixture };
}

const run = (
  h: ReturnType<typeof makeHarness>,
  mode: 'backfill' | 'incremental' = 'backfill',
  resources: Parameters<typeof enqueueSync>[1]['resources'] = 'all',
) =>
  enqueueSync(h.deps, {
    orgId: ORG_A,
    connectionId: CONN_A,
    resources,
    mode,
    since: mode === 'backfill' ? since : undefined,
  });

const TABLES = [
  'locations',
  'products',
  'skus',
  'sku_channel_listings',
  'sku_cost_components',
  'inventory_levels',
  'inventory_movements',
  'orders',
  'order_lines',
  'refunds',
  'refund_lines',
];
const counts = async () => {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    out[t] = Number(
      (await env.owner.query(`select count(*) c from ${t} where org_id = $1`, [ORG_A])).rows[0].c,
    );
  }
  return out;
};
const rows = async (sql: string) =>
  (await env.owner.query(sql.replace(/:org/g, `'${ORG_A}'`))).rows;
const conn = async () =>
  (
    await env.owner.query(
      `select status, last_error, last_synced_at from store_connections where id = $1`,
      [CONN_A],
    )
  ).rows[0];
const variables = (fixture: ShopifyFixture, op: string) =>
  fixture.admin.requests
    .map(
      (r) =>
        JSON.parse(r.body ?? '{}') as {
          operationName?: string;
          variables: { query?: string | null };
        },
    )
    .filter((b) => b.operationName === op)
    .map((b) => b.variables);

describe('full Shopify backfill through the engine', () => {
  it('lands the whole fixture shop and completes every cursor', async () => {
    const { h, fixture } = await setup();
    const { expected } = fixture;
    await run(h);
    const results = await drain(h);
    expect(results.some((r) => r.kind === 'failed')).toBe(false);

    const variants = expected.products.flatMap((p) => p.variants);
    const lines = expected.orders.flatMap((o) => o.lines);
    const refundCount = expected.orders.reduce((n, o) => n + o.refunds.length, 0);
    const refundLineCount = expected.orders.reduce(
      (n, o) => n + o.refunds.reduce((m, r) => m + r.lines.length, 0),
      0,
    );
    const costed = variants.filter((v) => v.unitCostCents !== null);
    expect(await counts()).toEqual({
      locations: expected.locations.length,
      products: expected.products.length,
      skus: variants.length,
      sku_channel_listings: variants.length,
      sku_cost_components: costed.length,
      inventory_levels: expected.inventory.length,
      inventory_movements: expected.inventory.filter((l) => l.onHand !== 0).length,
      orders: expected.orders.length,
      order_lines: lines.length,
      refunds: refundCount,
      refund_lines: refundLineCount,
    });

    // SKU codes come from Shopify, with a generated fallback for the variant that has none.
    const skuByVariant = new Map(
      (
        await rows(
          `select l.external_variant_id v, s.sku_code c from sku_channel_listings l join skus s on s.id = l.sku_id where l.org_id = :org`,
        )
      ).map((r) => [r.v as string, r.c as string]),
    );
    for (const v of variants) {
      expect(skuByVariant.get(v.externalId)).toBe(v.skuCode ?? `shopify-${v.externalId}`);
    }

    // Imported unit costs become product_cost components, and only for variants that have a cost.
    const costRows = await rows(
      `select l.external_variant_id v, c.amount_cents a, c.component_type t from sku_cost_components c join sku_channel_listings l on l.sku_id = c.sku_id where c.org_id = :org order by 1`,
    );
    expect(costRows.map((r) => [r.v, Number(r.a), r.t])).toEqual(
      costed
        .map((v) => [v.externalId, v.unitCostCents, 'product_cost'])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );

    // Stock: both locations, and the movements add up to the on-hand total.
    const sums = (
      await rows(
        `select (select coalesce(sum(on_hand), 0) from inventory_levels where org_id = :org) o, (select coalesce(sum(delta), 0) from inventory_movements where org_id = :org) m`,
      )
    )[0];
    const onHand = expected.inventory.reduce((n, l) => n + l.onHand, 0);
    expect([Number(sums.o), Number(sums.m)]).toEqual([onHand, onHand]);
    expect(
      new Set(
        (
          await rows(
            `select loc.external_id e from inventory_levels il join locations loc on loc.id = il.location_id where il.org_id = :org`,
          )
        ).map((r) => r.e),
      ),
    ).toEqual(new Set(expected.locations.map((l) => l.externalId)));

    // Orders: channel, test flag and status are stored; line snapshots follow the costs in effect.
    const stored = new Map(
      (
        await rows(
          `select external_order_id e, channel, is_test, status from orders where org_id = :org`,
        )
      ).map((r) => [r.e as string, r]),
    );
    for (const o of expected.orders) {
      expect(stored.get(o.externalId)).toMatchObject({
        channel: o.channel,
        is_test: o.isTest,
        status: o.status,
      });
    }
    expect(expected.orders.some((o) => o.channel === 'shopify_pos')).toBe(true);
    expect(expected.orders.some((o) => o.isTest)).toBe(true);
    expect(expected.orders.some((o) => o.status === 'cancelled')).toBe(true);
    const costOf = new Map(variants.map((v) => [v.externalId, v.unitCostCents]));
    const snaps = new Map(
      (
        await rows(
          `select external_line_id e, unit_cogs_cents_snapshot s from order_lines where org_id = :org`,
        )
      ).map((r) => [r.e as string, r.s === null ? null : Number(r.s)]),
    );
    for (const l of lines) {
      expect(snaps.get(l.externalLineId)).toBe(costOf.get(l.externalVariantId!) ?? null);
    }
    expect(lines.some((l) => costOf.get(l.externalVariantId!) === null)).toBe(true);

    // Refund lines and the restock flag.
    const refunded = await rows(
      `select r.external_refund_id e, r.restock, r.amount_cents a from refunds r where r.org_id = :org order by r.external_refund_id`,
    );
    const expectedRefunds = expected.orders
      .flatMap((o) => o.refunds)
      .sort((a, b) => (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0));
    expect(refunded.map((r) => [r.e, r.restock, Number(r.a)])).toEqual(
      expectedRefunds.map((r) => [r.externalId, r.restock, r.amountCents]),
    );

    const cursors = await rows(`select resource, status from sync_cursors where org_id = :org`);
    expect(cursors).toHaveLength(4);
    expect(cursors.every((c) => c.status === 'complete')).toBe(true);
    expect((await conn()).last_synced_at.toISOString()).toBe(RUN_TIME);
  });

  it('changes nothing when the same backfill is replayed', async () => {
    const { h } = await setup();
    await run(h);
    await drain(h);
    const before = await counts();
    await run(h);
    await drain(h);
    expect(await counts()).toEqual(before);
    expect(before.inventory_movements).toBeGreaterThan(0);
  });
});

describe('failure handling with Shopify', () => {
  it('waits out a throttled query in place, without re-running the page', async () => {
    const waits: number[] = [];
    const { h, fixture } = await setup({ sleep: async (ms) => void waits.push(ms) });
    await run(h, 'backfill', ['orders']);
    fixture.admin.respondNext({
      status: 200,
      body: JSON.stringify(gqlThrottled({ requested: 600, available: 100, restoreRate: 50 })),
    });
    const results = await drain(h);
    expect(waits).toEqual([10_000]); // (600 - 100) / 50 seconds
    expect(results.some((r) => r.kind === 'delayed' || r.kind === 'failed')).toBe(false);
    expect((await counts()).orders).toBe(fixture.expected.orders.length);
  });

  it('hands a page back to the queue when the throttle outlasts the in-place retries', async () => {
    const waits: number[] = [];
    const { h, fixture } = await setup({ sleep: async (ms) => void waits.push(ms) });
    await run(h, 'backfill', ['orders']);
    for (let i = 0; i < 6; i++) {
      fixture.admin.respondNext({
        status: 200,
        body: JSON.stringify(gqlThrottled({ requested: 600, available: 100, restoreRate: 50 })),
      });
    }
    const results = await drain(h);
    expect(waits).toEqual([10_000, 10_000, 10_000, 10_000, 10_000]);
    expect(results[0]).toEqual({ kind: 'delayed', delayMs: 10_000 });
    expect(results.at(-1)!.kind).toBe('done');
    expect((await counts()).orders).toBe(fixture.expected.orders.length);
    expect((await counts()).order_lines).toBe(
      fixture.expected.orders.reduce((n, o) => n + o.lines.length, 0),
    );
  });

  it('fails on a 401, marks the connection errored, and a later successful run recovers it', async () => {
    const { h, fixture } = await setup();
    fixture.admin.failNext(401);
    await run(h);
    const results = await drain(h);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: 'failed' });
    expect(await conn()).toMatchObject({ status: 'error' });

    await run(h);
    await drain(h);
    const after = await conn();
    expect([after.status, after.last_error]).toEqual(['active', null]);
    expect(after.last_synced_at.toISOString()).toBe(RUN_TIME);
  });

  it('fails on an unreadable amount without echoing it, keeping the pages already committed', async () => {
    const { h } = await setup({
      extraOrders: ORDERS_PAGE_SIZE * 2,
      rewrite(op, res, index) {
        if (op !== 'ErqOrders' || index !== 1) return res;
        const body = JSON.parse(res.body);
        body.data.orders.nodes[0].totalTaxSet.shopMoney.amount = 'SECRET-12x';
        return { ...res, body: JSON.stringify(body) };
      },
    });
    await run(h);
    const results = await drain(h);
    const failed = results.at(-1)!;
    expect(failed.kind).toBe('failed');
    expect(JSON.stringify(failed)).not.toContain('SECRET');

    const cursor = (
      await rows(
        `select status, cursor, last_error, records_processed from sync_cursors where org_id = :org and resource = 'orders'`,
      )
    )[0];
    expect(cursor.status).toBe('failed');
    expect(cursor.last_error).not.toContain('SECRET');
    expect(cursor.cursor).not.toBeNull(); // still where the first committed page left it
    expect(Number(cursor.records_processed)).toBe(ORDERS_PAGE_SIZE);
    expect((await counts()).orders).toBe(ORDERS_PAGE_SIZE);
    const error = (await conn()).last_error as string | null;
    expect(error ?? '').not.toContain('SECRET');
    expect((await conn()).last_synced_at).toBeNull();
  });
});

describe('incremental sync after a backfill', () => {
  it('refreshes a quantity-only stock change (item updated_at unchanged)', async () => {
    let incremental = false;
    const { h } = await setup({
      rewrite(op, res) {
        if (op !== 'ErqInventory' || !incremental) return res;
        const body = JSON.parse(res.body);
        const first = body.data.inventoryItems.nodes[0];
        if (first?.id !== 'gid://shopify/InventoryItem/2001') return res;
        // Only quantities moved; Shopify would not return this item to an updated_at filter.
        first.inventoryLevels.nodes[0].quantities = [
          { name: 'on_hand', quantity: 3 },
          { name: 'available', quantity: 1 },
          { name: 'incoming', quantity: 0 },
        ];
        return { ...res, body: JSON.stringify(body) };
      },
    });
    await run(h);
    await drain(h);
    incremental = true;
    h.clock.advance(86_400_000);
    await run(h, 'incremental');
    const results = await drain(h);
    expect(results.some((r) => r.kind === 'failed')).toBe(false);
    const level = (
      await rows(
        `select il.on_hand, il.reserved from inventory_levels il
           join sku_channel_listings l on l.sku_id = il.sku_id
           join locations loc on loc.id = il.location_id
          where il.org_id = :org and l.external_variant_id = 'gid://shopify/ProductVariant/1001'
            and loc.external_id = 'gid://shopify/Location/1'`,
      )
    )[0];
    expect([Number(level.on_hand), Number(level.reserved)]).toEqual([3, 2]);
  });

  it('asks Shopify only for rows updated since the watermark and replaces an updated order', async () => {
    let captured: { updatedAt: string; lineItems: { nodes: { quantity: number }[] } } | undefined;
    let incremental = false;
    const { h, fixture } = await setup({
      rewrite(op, res) {
        if (op !== 'ErqOrders') return res;
        const body = JSON.parse(res.body);
        if (!incremental) {
          captured ??= body.data.orders.nodes[0];
          return res;
        }
        // Shopify returns one order, changed after the watermark: 5 units on its first line.
        const changed = JSON.parse(JSON.stringify(captured));
        changed.updatedAt = '2026-10-07T08:00:00Z';
        changed.lineItems.nodes[0].quantity = 5;
        body.data.orders.nodes = [changed];
        body.data.orders.pageInfo = { hasNextPage: false, endCursor: null };
        return { ...res, body: JSON.stringify(body) };
      },
    });
    await run(h);
    await drain(h);
    const before = await counts();
    const requestsBefore = fixture.admin.requests.length;

    incremental = true;
    h.clock.advance(86_400_000); // the next day
    await run(h, 'incremental');
    const results = await drain(h);
    expect(results.some((r) => r.kind === 'failed')).toBe(false);

    const sent = (op: string) =>
      fixture.admin.requests
        .slice(requestsBefore)
        .map(
          (r) =>
            JSON.parse(r.body ?? '{}') as {
              operationName?: string;
              variables: { query?: string | null };
            },
        )
        .filter((b) => b.operationName === op)
        .map((b) => b.variables.query);
    const watermark = `updated_at:>='${RUN_TIME}'`;
    expect(sent('ErqProducts')).toEqual([watermark]);
    // Inventory always takes a full pass: quantity-only changes do not move updated_at.
    expect(sent('ErqInventory').length).toBeGreaterThan(0);
    expect(sent('ErqInventory').every((q) => q === null)).toBe(true);
    expect(sent('ErqOrders')).toEqual([watermark]);
    expect(sent('ErqLocations')).toEqual([undefined]); // locations are always listed in full

    expect(await counts()).toEqual(before); // replaced in place: no duplicate order or lines
    const line = (
      await rows(
        `select quantity, (select external_updated_at from orders where id = order_id) u from order_lines where org_id = :org and external_line_id = 'gid://shopify/LineItem/4001'`,
      )
    )[0];
    expect(Number(line.quantity)).toBe(5);
    expect(line.u.toISOString()).toBe('2026-10-07T08:00:00.000Z');
    expect(variables(fixture, 'ErqOrders')[0]!.query).toMatch(/^created_at:>='2025-10-06/); // the backfill used created_at
  });
});
