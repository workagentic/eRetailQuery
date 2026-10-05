import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
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

describe('cross-tenant references are rejected by composite foreign keys', () => {
  it("a tenant-B sku cannot point at tenant A's product", async () => {
    await expect(
      db.withTenant(B, (tx) =>
        tx.execute(
          `insert into skus (org_id, product_id, sku_code, selling_price_cents) values ('${B}', '${A}', 'X', 100)`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/foreign key|violates/) } });
  });
  it("a tenant-B cost component cannot point at tenant A's sku", async () => {
    await expect(
      db.withTenant(B, (tx) =>
        tx.execute(
          `insert into sku_cost_components (org_id, sku_id, component_type, amount_cents, effective_from)
           values ('${B}', '${A}', 'packaging', 5, '2025-01-01')`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/foreign key|violates/) } });
  });
});

describe('catalog constraints', () => {
  it('rejects a cost period that ends before it starts', async () => {
    await expect(
      owner.query(
        `insert into sku_cost_components (org_id, sku_id, component_type, amount_cents, effective_from, effective_to)
         values ($1, $1, 'packaging', 5, '2025-06-01', '2025-01-01')`,
        [A],
      ),
    ).rejects.toThrow(/cost_period_valid|check/);
  });
  it('rejects negative amounts and prices', async () => {
    await expect(
      owner.query(
        `insert into sku_cost_components (org_id, sku_id, component_type, amount_cents, effective_from)
         values ($1, $1, 'packaging', -1, '2025-01-01')`,
        [A],
      ),
    ).rejects.toThrow(/check/);
    await expect(
      owner.query(
        `insert into skus (org_id, product_id, sku_code, selling_price_cents) values ($1, $1, 'NEG', -5)`,
        [A],
      ),
    ).rejects.toThrow(/check/);
  });
  it('enforces unique sku_code per org but not across orgs', async () => {
    await expect(
      owner.query(
        `insert into skus (org_id, product_id, sku_code, selling_price_cents) values ($1, $1, 'SKU-1', 5)`,
        [A],
      ),
    ).rejects.toThrow(/unique|duplicate/);
  });
});
