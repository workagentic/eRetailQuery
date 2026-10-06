import { sampleData } from '@erq/connectors/testing';
import type { NormalizedInventoryLevel } from '@erq/connectors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertInventory } from '../src/sinks/inventory';
import { upsertLocations } from '../src/sinks/locations';
import { upsertProducts } from '../src/sinks/products';
import { ORG_A, sinkContext, startEnv, type TestEnv } from './helpers';

let env: TestEnv;
const data = sampleData();
beforeAll(async () => {
  env = await startEnv();
  const ctx = sinkContext();
  await env.db.withTenant(ORG_A, async (tx) => {
    await upsertLocations(tx, ctx, data.locations);
    await upsertProducts(tx, ctx, data.products);
  });
});
afterAll(async () => {
  await env?.stop();
});

const run = (items: NormalizedInventoryLevel[], ctx = sinkContext()) =>
  env.db.withTenant(ORG_A, (tx) => upsertInventory(tx, ctx, items));
const count = async (table: string) =>
  Number(
    (await env.owner.query(`select count(*) c from ${table} where org_id = $1`, [ORG_A])).rows[0].c,
  );
const level = async (variant: string, loc: string) =>
  (
    await env.owner.query(
      `select l.on_hand, l.reserved, l.incoming from inventory_levels l
       join sku_channel_listings cl on cl.sku_id = l.sku_id and cl.external_variant_id = $1
       join locations lo on lo.id = l.location_id and lo.external_id = $2 where l.org_id = $3`,
      [variant, loc, ORG_A],
    )
  ).rows[0];

describe('upsertInventory', () => {
  it('creates levels (including negative on_hand) and one opening movement per level', async () => {
    expect(await run(data.inventory)).toEqual({ processed: 6, skipped: 0 });
    expect(await count('inventory_levels')).toBe(6);
    expect(await count('inventory_movements')).toBe(6);
    expect(await level('v-1', 'loc-1')).toEqual({ on_hand: 40, reserved: 2, incoming: 0 });
    expect((await level('v-4', 'loc-2')).on_hand).toBe(-2);
  });

  it('is idempotent: replaying adds no levels and no movements', async () => {
    await run(data.inventory);
    expect(await count('inventory_levels')).toBe(6);
    expect(await count('inventory_movements')).toBe(6);
  });

  it('applies a newer count with a movement for the difference, and ignores an older one', async () => {
    const base = data.inventory[0]!;
    await run([{ ...base, onHand: 35, updatedAt: new Date('2026-09-10T09:00:00Z') }]);
    expect((await level('v-1', 'loc-1')).on_hand).toBe(35);
    expect(await count('inventory_movements')).toBe(7);
    await run([{ ...base, onHand: 99, updatedAt: new Date('2026-09-05T09:00:00Z') }]); // older: ignored
    expect((await level('v-1', 'loc-1')).on_hand).toBe(35);
    expect(await count('inventory_movements')).toBe(7);
  });

  it('updates reserved and incoming without writing a movement when on_hand is unchanged', async () => {
    const base = data.inventory[0]!;
    await run([
      {
        ...base,
        onHand: 35,
        reserved: 7,
        incoming: 3,
        updatedAt: new Date('2026-09-11T09:00:00Z'),
      },
    ]);
    expect(await level('v-1', 'loc-1')).toEqual({ on_hand: 35, reserved: 7, incoming: 3 });
    expect(await count('inventory_movements')).toBe(7);
  });

  it('skips unknown variants and unknown locations instead of failing the page', async () => {
    const base = data.inventory[0]!;
    const result = await run([
      { ...base, externalVariantId: 'v-unknown' },
      { ...base, locationExternalId: 'loc-unknown' },
      {
        ...base,
        onHand: 35,
        reserved: 7,
        incoming: 3,
        updatedAt: new Date('2026-09-11T09:00:00Z'),
      },
    ]);
    expect(result).toEqual({ processed: 1, skipped: 2 });
  });

  it('keeps the ledger consistent: movements always sum to on_hand', async () => {
    const { rows } = await env.owner.query(
      `select l.on_hand, coalesce((select sum(m.delta) from inventory_movements m where m.sku_id = l.sku_id and m.location_id = l.location_id), 0)::int as moved
         from inventory_levels l where l.org_id = $1`,
      [ORG_A],
    );
    expect(rows.length).toBe(6);
    for (const r of rows) expect(r.moved).toBe(r.on_hand);
  });

  it('handles an empty page and duplicate rows in one page', async () => {
    expect(await run([])).toEqual({ processed: 0, skipped: 0 });
    const base = data.inventory[3]!;
    expect(await run([base, base])).toEqual({ processed: 1, skipped: 0 });
  });
});
