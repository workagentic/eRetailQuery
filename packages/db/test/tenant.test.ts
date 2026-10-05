import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createTenantDb, orgMembers, orgs, type TenantDb } from '../src';
import { startTestDatabase, type TestDatabase } from '../src/testing';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let tdb: TestDatabase;
let owner: Pool;
let db: TenantDb;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  await owner.query(`insert into orgs (id, name, slug) values ($1,'A','a'), ($2,'B','b')`, [A, B]);
  await owner.query(
    `insert into org_members (org_id, user_id, role) values ($1, gen_random_uuid(), 'owner')`,
    [A],
  );
  db = createTenantDb(tdb.appUrl);
});
afterAll(async () => {
  await db?.close();
  await owner?.end();
  await tdb?.stop();
});

describe('withTenant', () => {
  it('scopes reads to the given org', async () => {
    const rows = await db.withTenant(A, (tx) => tx.select().from(orgs));
    expect(rows.map((r) => r.id)).toEqual([A]);
    const members = await db.withTenant(B, (tx) => tx.select().from(orgMembers));
    expect(members).toEqual([]);
  });
  it('returns no rows when no org context is set', async () => {
    const { rows } = await db.pool.query('select * from orgs');
    expect(rows).toEqual([]);
  });
  it('rejects writes for a different org (WITH CHECK)', async () => {
    await expect(
      db.withTenant(B, (tx) =>
        tx.insert(orgMembers).values({ orgId: A, userId: crypto.randomUUID(), role: 'viewer' }),
      ),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/row-level security|violates/) },
    }); // Drizzle wraps pg errors; message is on .cause
  });
  it('rejects a non-uuid orgId before touching the database', () => {
    expect(() => db.withTenant("x'; drop table orgs;--", async () => 1)).toThrow(TypeError);
  });
  it('does not leak a previous tenant onto a reused connection (and does not error on the empty setting)', async () => {
    const single = createTenantDb(tdb.appUrl, { max: 1 });
    try {
      await single.withTenant(A, (tx) => tx.select().from(orgs));
      const { rows } = await single.pool.query('select * from orgs'); // same physical connection
      expect(rows).toEqual([]);
    } finally {
      await single.close();
    }
  });
  it('rolls back when fn throws', async () => {
    await expect(
      db.withTenant(A, async (tx) => {
        await tx
          .insert(orgMembers)
          .values({ orgId: A, userId: crypto.randomUUID(), role: 'viewer' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const { rows } = await owner.query(
      'select count(*)::int as n from org_members where org_id = $1',
      [A],
    );
    expect(rows[0].n).toBe(1);
  });
});
