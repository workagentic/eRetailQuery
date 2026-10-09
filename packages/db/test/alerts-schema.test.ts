import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../src/testing';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let tdb: TestDatabase;
let owner: Pool;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
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
  await owner?.end();
  await tdb?.stop();
});
beforeEach(() => owner.query('delete from alerts'));

const insert = (org: string, conn: string | null, ref = 'webhook_event:1', severity = 'medium') =>
  owner.query(
    `insert into alerts (org_id, type, severity, store_connection_id, entity_ref, message) values ($1, 'webhook_failed', $2, $3, $4, 'm')`,
    [org, severity, conn, ref],
  );

describe('alerts', () => {
  it('allows one OPEN alert per (org, type, entity) and a new one once it is resolved', async () => {
    await insert(A, A);
    await expect(insert(A, A)).rejects.toMatchObject({ code: '23505' });
    await owner.query(`update alerts set resolved_at = now()`);
    await insert(A, A);
    expect((await owner.query(`select count(*)::int as n from alerts`)).rows[0].n).toBe(2);
  });
  it('lets two orgs raise the same entity ref', async () => {
    await insert(A, A);
    await insert(B, B);
  });
  it('refuses a connection of another org (composite foreign key)', async () => {
    await expect(insert(A, B)).rejects.toMatchObject({ code: '23503' });
  });
  it('goes away with its connection', async () => {
    const spare = 'dddddddd-0000-4000-8000-000000000001';
    await owner.query(
      `insert into store_connections (id, org_id, platform, external_account_id, status) values ($1, $2, 'shopify', 'spare.myshopify.com', 'active')`,
      [spare, A],
    );
    await insert(A, spare);
    await owner.query(`delete from store_connections where id = $1`, [spare]);
    expect((await owner.query(`select count(*)::int as n from alerts`)).rows[0].n).toBe(0);
  });
  it('only knows low, medium and high', async () => {
    await expect(insert(A, A, 'x', 'critical')).rejects.toMatchObject({ code: '22P02' });
  });
  it('gives webhook_events a retry counter that starts at zero', async () => {
    const { rows } = await owner.query(
      `insert into webhook_events (org_id, store_connection_id, topic, external_event_id, payload) values ($1, $1, 'products/update', 'e1', '{}') returning sweep_retries`,
      [A],
    );
    expect(rows[0].sweep_retries).toBe(0);
  });
});
