import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { startTestDatabase, type TestDatabase } from '../src/testing';

let tdb: TestDatabase;
let owner: Pool;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
});
afterAll(async () => {
  await owner.end();
  await tdb.stop();
});

describe('roles and helpers migration', () => {
  it('creates app_user without superuser or BYPASSRLS', async () => {
    const { rows } = await owner.query(
      `select rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname = 'app_user'`,
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcanlogin: true });
  });
  it('lets app_user log in with the configured password', async () => {
    const app = new Pool({ connectionString: tdb.appUrl });
    const { rows } = await app.query('select current_user as u');
    expect(rows[0].u).toBe('app_user');
    await app.end();
  });
  it('does not let app_user create objects in public', async () => {
    const app = new Pool({ connectionString: tdb.appUrl });
    await expect(app.query('create table nope (id int)')).rejects.toThrow(/permission denied/);
    await app.end();
  });
  it('installs the RLS helper and updated_at trigger function', async () => {
    const { rows } = await owner.query(
      `select proname from pg_proc where proname in ('app_secure_tenant_table','app_set_updated_at') order by 1`,
    );
    expect(rows.map((r) => r.proname)).toEqual(['app_secure_tenant_table', 'app_set_updated_at']);
  });
});
