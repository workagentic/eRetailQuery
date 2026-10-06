import { sampleData } from '@erq/connectors/testing';
import type { NormalizedProduct } from '@erq/connectors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertLocations } from '../src/sinks/locations';
import { upsertProducts } from '../src/sinks/products';
import {
  CONN_A,
  ORG_A,
  ORG_B,
  seedCost,
  seedSku,
  sinkContext,
  startEnv,
  type TestEnv,
} from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env?.stop();
});

const count = async (table: string, orgId = ORG_A) =>
  Number(
    (await env.owner.query(`select count(*) c from ${table} where org_id = $1`, [orgId])).rows[0].c,
  );
const run = (items: NormalizedProduct[], ctx = sinkContext()) =>
  env.db.withTenant(ctx.orgId, (tx) => upsertProducts(tx, ctx, items));

describe('upsertLocations', () => {
  it('upserts by external id and is idempotent', async () => {
    const { locations } = sampleData();
    const ctx = sinkContext();
    const first = await env.db.withTenant(ORG_A, (tx) => upsertLocations(tx, ctx, locations));
    expect(first).toEqual({ processed: 2, skipped: 0 });
    await env.db.withTenant(ORG_A, (tx) =>
      upsertLocations(tx, ctx, [
        { ...locations[0]!, name: 'Renamed' },
        locations[1]!,
        locations[1]!,
      ]),
    );
    expect(await count('locations')).toBe(2);
    const { rows } = await env.owner.query(
      `select name, source, type from locations where org_id = $1 and external_id = 'loc-1'`,
      [ORG_A],
    );
    expect(rows[0]).toEqual({ name: 'Renamed', source: 'shopify', type: 'warehouse' });
  });
  it("cannot write another tenant's connection", async () => {
    await expect(
      env.db.withTenant(ORG_B, (tx) =>
        upsertLocations(
          tx,
          sinkContext({ orgId: ORG_B, connectionId: CONN_A }),
          sampleData().locations,
        ),
      ),
    ).rejects.toBeTruthy();
  });
});

describe('upsertProducts', () => {
  const [tshirt, poster, mug] = sampleData().products as [
    NormalizedProduct,
    NormalizedProduct,
    NormalizedProduct,
  ];

  it('creates products, SKUs, listings and imported product costs', async () => {
    expect(await run([tshirt, poster, mug])).toEqual({ processed: 3, skipped: 0 });
    expect(await count('products')).toBeGreaterThanOrEqual(3);
    const skus = await env.owner.query(
      `select sku_code, selling_price_cents, currency from skus where org_id = $1 and sku_code in ('TSHIRT-S','TSHIRT-M','MUG-1','shopify-v-3') order by sku_code collate "C"`,
      [ORG_A],
    );
    expect(skus.rows.map((r) => r.sku_code)).toEqual([
      'MUG-1',
      'TSHIRT-M',
      'TSHIRT-S',
      'shopify-v-3',
    ]); // blank skuCode gets a stable fallback
    expect(Number(skus.rows.find((r) => r.sku_code === 'TSHIRT-S').selling_price_cents)).toBe(2500);
    const listings = await env.owner.query(
      `select external_variant_id from sku_channel_listings where org_id = $1 and store_connection_id = $2 order by 1`,
      [ORG_A, CONN_A],
    );
    expect(listings.rows.map((r) => r.external_variant_id)).toEqual(['v-1', 'v-2', 'v-3', 'v-4']);
    const costs = await env.owner.query(
      `select s.sku_code, c.amount_cents, c.effective_from::text as effective_from, c.per_unit from sku_cost_components c join skus s on s.id = c.sku_id where c.org_id = $1 and c.component_type = 'product_cost' order by s.sku_code`,
      [ORG_A],
    );
    expect(
      costs.rows.map((r) => [r.sku_code, Number(r.amount_cents), r.effective_from, r.per_unit]),
    ).toEqual(
      expect.arrayContaining([
        ['MUG-1', 300, '2026-01-01', true],
        ['TSHIRT-S', 800, '2026-01-01', true],
      ]),
    );
    expect(costs.rows.some((r) => r.sku_code === 'shopify-v-3')).toBe(false); // unitCostCents null: no component
  });

  it('is idempotent: replaying changes nothing', async () => {
    const before = [
      await count('products'),
      await count('skus'),
      await count('sku_channel_listings'),
      await count('sku_cost_components'),
    ];
    await run([tshirt, poster, mug]);
    expect([
      await count('products'),
      await count('skus'),
      await count('sku_channel_listings'),
      await count('sku_cost_components'),
    ]).toEqual(before);
  });

  it('applies newer updates and ignores older ones', async () => {
    const newer: NormalizedProduct = {
      ...tshirt,
      title: 'Logo Tee v2',
      updatedAt: new Date('2026-09-20T10:00:00Z'),
      variants: tshirt.variants.map((v) => ({
        ...v,
        priceCents: 2900,
        updatedAt: new Date('2026-09-20T10:00:00Z'),
      })),
    };
    await run([newer]);
    const read = async () =>
      (
        await env.owner.query(
          `select s.selling_price_cents p, p.title t from skus s join products p on p.id = s.product_id where s.org_id = $1 and s.sku_code = 'TSHIRT-S'`,
          [ORG_A],
        )
      ).rows[0];
    expect(Number((await read()).p)).toBe(2900);
    expect((await read()).t).toBe('Logo Tee v2');
    await run([tshirt]); // older snapshot arrives late
    expect(Number((await read()).p)).toBe(2900);
    expect((await read()).t).toBe('Logo Tee v2');
  });

  it('links to an existing SKU with the same code instead of duplicating it, without creating a product', async () => {
    const manual = await seedSku(env.owner, ORG_A, 'MANUAL-1', 1500);
    const productsBefore = await count('products');
    const incoming: NormalizedProduct = {
      externalId: 'p-link',
      title: 'Linked',
      brand: null,
      category: null,
      status: 'active',
      updatedAt: new Date('2026-09-01T00:00:00Z'),
      variants: [
        {
          externalId: 'v-link',
          skuCode: 'MANUAL-1',
          barcode: null,
          priceCents: 1800,
          compareAtPriceCents: null,
          currency: 'USD',
          unitCostCents: null,
          updatedAt: new Date('2026-09-01T00:00:00Z'),
        },
      ],
    };
    await run([incoming]);
    expect(await count('products')).toBe(productsBefore);
    const { rows } = await env.owner.query(
      `select sku_id from sku_channel_listings where org_id = $1 and external_variant_id = 'v-link'`,
      [ORG_A],
    );
    expect(rows[0].sku_id).toBe(manual);
  });

  it('never overwrites an existing product cost with the imported one', async () => {
    const sku = await seedSku(env.owner, ORG_A, 'OWNER-COST');
    await seedCost(env.owner, ORG_A, sku, 500);
    const incoming: NormalizedProduct = {
      externalId: 'p-cost',
      title: 'Costed',
      brand: null,
      category: null,
      status: 'active',
      updatedAt: new Date('2026-09-01T00:00:00Z'),
      variants: [
        {
          externalId: 'v-cost',
          skuCode: 'OWNER-COST',
          barcode: null,
          priceCents: 1000,
          compareAtPriceCents: null,
          currency: 'USD',
          unitCostCents: 800,
          updatedAt: new Date('2026-09-01T00:00:00Z'),
        },
      ],
    };
    await run([incoming]);
    const { rows } = await env.owner.query(
      `select amount_cents from sku_cost_components where sku_id = $1`,
      [sku],
    );
    expect(rows.map((r) => Number(r.amount_cents))).toEqual([500]);
  });

  it('skips products without variants and keeps tenants apart', async () => {
    expect(await run([{ ...mug, externalId: 'p-empty', variants: [] }])).toEqual({
      processed: 0,
      skipped: 1,
    });
    expect(await count('skus', ORG_B)).toBe(0);
  });
});
