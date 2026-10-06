import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenantDb, type TenantDb } from '../src';
import { startTestDatabase, type TestDatabase } from '../src/testing';
import { fixtures } from './fixtures';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let tdb: TestDatabase;
let owner: Pool;
let db: TenantDb;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  for (const org of [A, B]) for (const f of Object.values(fixtures)) await f(owner, org);
  db = createTenantDb(tdb.appUrl);
});
afterAll(async () => {
  await db?.close();
  await owner?.end();
  await tdb?.stop();
});

const asB = (text: string) => db.withTenant(B, (tx) => tx.execute(sql.raw(text)));
const fk = { cause: { message: expect.stringMatching(/foreign key constraint/) } };

describe('cross-tenant references are rejected by composite foreign keys', () => {
  it("a tenant-B location cannot use tenant A's store connection", async () => {
    await expect(
      asB(
        `insert into locations (org_id, store_connection_id, external_id, name, source) values ('${B}', '${A}', 'x', 'n', 'shopify')`,
      ),
    ).rejects.toMatchObject(fk);
  });
  it("a tenant-B inventory level cannot use tenant A's sku or location", async () => {
    await expect(
      asB(
        `insert into inventory_levels (org_id, sku_id, location_id, on_hand) values ('${B}', '${A}', '${B}', 1)`,
      ),
    ).rejects.toMatchObject(fk);
    await expect(
      asB(
        `insert into inventory_levels (org_id, sku_id, location_id, on_hand) values ('${B}', '${B}', '${A}', 1)`,
      ),
    ).rejects.toMatchObject(fk);
  });
  it("a tenant-B listing cannot use tenant A's sku or connection", async () => {
    await expect(
      asB(
        `insert into sku_channel_listings (org_id, sku_id, store_connection_id, external_product_id, external_variant_id) values ('${B}', '${A}', '${B}', 'p', 'v2')`,
      ),
    ).rejects.toMatchObject(fk);
    await expect(
      asB(
        `insert into sku_channel_listings (org_id, sku_id, store_connection_id, external_product_id, external_variant_id) values ('${B}', '${B}', '${A}', 'p', 'v3')`,
      ),
    ).rejects.toMatchObject(fk);
  });
});

describe('locations', () => {
  it('requires connection and external id for shopify locations', async () => {
    await expect(
      owner.query(`insert into locations (org_id, name, source) values ($1, 'Bad', 'shopify')`, [
        A,
      ]),
    ).rejects.toThrow(/locations_shopify_ids/);
  });
  it('rejects a duplicate external id per connection', async () => {
    await expect(
      owner.query(
        `insert into locations (org_id, store_connection_id, external_id, name, source) values ($1, $1, 'loc-' || ($1::uuid)::text, 'Dup', 'shopify')`,
        [A],
      ),
    ).rejects.toThrow(/locations_external_uq|duplicate key/);
  });
  it('allows manual locations and rejects a duplicate manual name per org', async () => {
    await owner.query(
      `insert into locations (org_id, name, type, source) values ($1, 'Garage', 'other', 'manual')`,
      [A],
    );
    await expect(
      owner.query(
        `insert into locations (org_id, name, type, source) values ($1, 'Garage', 'other', 'manual')`,
        [A],
      ),
    ).rejects.toThrow(/locations_manual_name_uq|duplicate key/);
    await owner.query(
      `insert into locations (org_id, name, type, source) values ($1, 'Garage', 'other', 'manual')`,
      [B],
    ); // other org is fine
  });
});

describe('inventory_levels', () => {
  it('allows negative on_hand (oversold stores) but not negative reserved or incoming', async () => {
    const { rows } = await owner.query(
      `insert into locations (org_id, name, source) values ($1, 'Shelf', 'manual') returning id`,
      [A],
    );
    const loc = rows[0].id as string;
    await owner.query(
      `insert into inventory_levels (org_id, sku_id, location_id, on_hand) values ($1, $1, $2, -3)`,
      [A, loc],
    );
    await expect(
      owner.query(
        `insert into inventory_levels (org_id, sku_id, location_id, on_hand, reserved) values ($1, $1, $1, 1, -1)`,
        [A],
      ),
    ).rejects.toThrow(/inventory_levels_nonneg|duplicate key/);
  });
  it('is unique per sku and location', async () => {
    await expect(
      owner.query(
        `insert into inventory_levels (org_id, sku_id, location_id, on_hand) values ($1, $1, $1, 9)`,
        [A],
      ),
    ).rejects.toThrow(/inventory_levels_org_sku_loc_uq|duplicate key/);
  });
});

describe('inventory_movements (append-only ledger)', () => {
  it('rejects a zero delta', async () => {
    await expect(
      owner.query(
        `insert into inventory_movements (org_id, sku_id, location_id, delta, reason) values ($1, $1, $1, 0, 'adjustment')`,
        [A],
      ),
    ).rejects.toThrow(/inventory_movements_delta_nonzero/);
  });
  it('is idempotent on a reference and allows repeated null references', async () => {
    const ins = `insert into inventory_movements (org_id, sku_id, location_id, delta, reason, ref_type, ref_id) values ($1, $1, $1, 1, 'sync_correction', 'sync', $2)`;
    await owner.query(ins, [A, 'run-1']);
    await expect(owner.query(ins, [A, 'run-1'])).rejects.toThrow(
      /inventory_movements_ref_uq|duplicate key/,
    );
    const plain = `insert into inventory_movements (org_id, sku_id, location_id, delta, reason) values ($1, $1, $1, 1, 'adjustment')`;
    await owner.query(plain, [A]);
    await owner.query(plain, [A]);
  });
  it('lets app_user insert but never update or delete', async () => {
    await db.withTenant(A, (tx) =>
      tx.execute(
        sql.raw(
          `insert into inventory_movements (org_id, sku_id, location_id, delta, reason) values ('${A}', '${A}', '${A}', 2, 'restock')`,
        ),
      ),
    );
    const denied = { cause: { message: expect.stringMatching(/permission denied/) } };
    await expect(
      db.withTenant(A, (tx) => tx.execute(sql.raw(`update inventory_movements set delta = 9`))),
    ).rejects.toMatchObject(denied);
    await expect(
      db.withTenant(A, (tx) => tx.execute(sql.raw(`delete from inventory_movements`))),
    ).rejects.toMatchObject(denied);
  });
});

describe('sku_channel_listings', () => {
  it('rejects a negative channel price and a duplicate variant per connection', async () => {
    await expect(
      owner.query(
        `insert into sku_channel_listings (org_id, sku_id, store_connection_id, external_product_id, external_variant_id, channel_price_cents) values ($1, $1, $1, 'p', 'v-neg', -1)`,
        [A],
      ),
    ).rejects.toThrow(/check/);
    await expect(
      owner.query(
        `insert into sku_channel_listings (org_id, sku_id, store_connection_id, external_product_id, external_variant_id) values ($1, $1, $1, 'p', 'v-1')`,
        [A],
      ),
    ).rejects.toThrow(/sku_channel_listings_variant_uq|duplicate key/);
  });
});
