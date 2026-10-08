import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTenantDb, storeConnections, type TenantDb } from '../src';
import { startTestDatabase, type TestDatabase } from '../src/testing';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let tdb: TestDatabase;
let owner: Pool;
let db: TenantDb;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  db = createTenantDb(tdb.appUrl);
  for (const org of [A, B]) {
    await owner.query(
      `insert into orgs (id, name, slug) values ($1, 'Org', 'org-' || ($1::uuid)::text)`,
      [org],
    );
    await owner.query(
      `insert into store_connections (id, org_id, platform, external_account_id, status) values ($1, $1, 'shopify', ($1::uuid)::text || '.myshopify.com', 'active')`,
      [org],
    );
  }
}, 120_000);
afterAll(async () => {
  await db?.close();
  await owner?.end();
  await tdb?.stop();
});

describe('store_connections token expiry columns', () => {
  it('are nullable, writable by the owning tenant and invisible to another tenant', async () => {
    const access = new Date('2026-10-08T13:00:00.000Z');
    const refresh = new Date('2027-01-06T12:00:00.000Z');
    const written = await db.withTenant(A, (tx) =>
      tx
        .update(storeConnections)
        .set({ accessTokenExpiresAt: access, refreshTokenExpiresAt: refresh })
        .where(eq(storeConnections.id, A))
        .returning({
          a: storeConnections.accessTokenExpiresAt,
          r: storeConnections.refreshTokenExpiresAt,
        }),
    );
    expect(written).toEqual([{ a: access, r: refresh }]);
    const crossTenant = await db.withTenant(B, (tx) =>
      tx
        .update(storeConnections)
        .set({ accessTokenExpiresAt: null })
        .where(eq(storeConnections.id, A))
        .returning({ id: storeConnections.id }),
    );
    expect(crossTenant).toEqual([]);
    const { rows } = await owner.query(
      `select access_token_expires_at, refresh_token_expires_at from store_connections where id = $1`,
      [B],
    );
    expect(rows[0]).toEqual({ access_token_expires_at: null, refresh_token_expires_at: null });
  });
});
