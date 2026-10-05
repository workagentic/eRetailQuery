import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createTenantDb, insertAudit, type TenantDb } from '../src';
import { startTestDatabase, type TestDatabase } from '../src/testing';

const ORG = '11111111-1111-4111-8111-111111111111';
let tdb: TestDatabase;
let db: TenantDb;

beforeAll(async () => {
  tdb = await startTestDatabase();
  const owner = new Pool({ connectionString: tdb.ownerUrl });
  await owner.query(`insert into orgs (id, name, slug) values ($1,'A','a')`, [ORG]);
  await owner.end();
  db = createTenantDb(tdb.appUrl);
});
afterAll(async () => {
  await db?.close();
  await tdb?.stop();
});

it('allows inserts', async () => {
  await db.withTenant(ORG, (tx) =>
    insertAudit(tx, {
      orgId: ORG,
      actorUserId: null,
      action: 'x.y',
      entityType: 'x',
      after: { a: 1 },
    }),
  );
  const { rows } = await db.withTenant(ORG, (tx) =>
    tx.execute(`select action, after_json from audit_log`),
  );
  expect(rows).toHaveLength(1);
});
// Drizzle wraps driver errors in DrizzleQueryError; the Postgres message is on .cause.
const pgError = (re: RegExp) => ({ cause: { message: expect.stringMatching(re) } });
it('is append-only: update and delete are denied', async () => {
  await expect(
    db.withTenant(ORG, (tx) => tx.execute(`update audit_log set action = 'z'`)),
  ).rejects.toMatchObject(pgError(/permission denied/));
  await expect(
    db.withTenant(ORG, (tx) => tx.execute(`delete from audit_log`)),
  ).rejects.toMatchObject(pgError(/permission denied/));
});
