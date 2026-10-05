import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Client, Pool } from 'pg';
import { runMigrations } from '../src/admin';
import { createTenantDb, type TenantDb } from '../src';
import { startTestDatabase, type TestDatabase } from '../src/testing';

const VICTIM = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_FNS = [
  'app_list_user_orgs(uuid)',
  'app_create_org(uuid, text, text)',
  'app_accept_invite(uuid, text, text)',
];
const HELPER_FNS = ['app_secure_tenant_table(regclass, text, boolean)', 'app_set_updated_at()'];

let tdb: TestDatabase;
let owner: Pool;
let db: TenantDb;

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  db = createTenantDb(tdb.appUrl);
  await owner.query(`insert into orgs (id, name, slug) values ($1, 'Victim', 'victim')`, [VICTIM]);
}, 120_000);
afterAll(async () => {
  await db?.close();
  await owner?.end();
  await tdb?.stop();
});

describe('search_path pinning', () => {
  it('a temp table named invites cannot shadow the real one inside app_accept_invite', async () => {
    const attacker = randomUUID();
    const email = 'attacker@example.com';
    const hash = 'forged-hash-' + randomUUID();
    const c = new Client({ connectionString: tdb.appUrl });
    await c.connect();
    try {
      await c.query(`create temp table invites (id uuid, org_id uuid, email text, role org_role,
        token_hash text, invited_by uuid, expires_at timestamptz, accepted_at timestamptz,
        created_at timestamptz, updated_at timestamptz)`);
      await c.query(
        `insert into invites (id, org_id, email, role, token_hash, expires_at)
         values (gen_random_uuid(), $1, $2, 'admin', $3, now() + interval '1 day')`,
        [VICTIM, email, hash],
      );
      await expect(
        c.query(`select * from app_accept_invite($1, $2, $3)`, [attacker, email, hash]),
      ).rejects.toThrow(/invite_invalid/);
    } finally {
      await c.end();
    }
    const { rows } = await owner.query(
      `select 1 from org_members where org_id = $1 and user_id = $2`,
      [VICTIM, attacker],
    );
    expect(rows).toEqual([]);
  });
});

describe('Supabase simulation: default privileges granted to anon/authenticated', () => {
  const simDb = 'supa_sim';
  let sim: Pool;

  beforeAll(async () => {
    await owner.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    end $$`);
    await owner.query(`drop database if exists ${simDb}`);
    await owner.query(`create database ${simDb}`);
    const simUrl = withDatabase(tdb.ownerUrl, simDb);
    sim = new Pool({ connectionString: simUrl });
    await sim.query(`alter default privileges in schema public grant all on tables to anon, authenticated;
      alter default privileges in schema public grant all on functions to anon, authenticated;`);
    await runMigrations(simUrl, 'app_user_test');
  }, 120_000);
  afterAll(async () => {
    await sim?.end();
  });

  it.each(['anon', 'authenticated'])(
    '%s has no execute on account or helper functions',
    async (role) => {
      for (const fn of [...ACCOUNT_FNS, ...HELPER_FNS]) {
        const { rows } = await sim.query(
          `select has_function_privilege($1, $2::regprocedure, 'execute') as ok`,
          [role, fn],
        );
        expect({ role, fn, ok: rows[0].ok }).toEqual({ role, fn, ok: false });
      }
    },
  );

  it('anon and authenticated have no table privileges', async () => {
    const anon = await sim.query(`select has_table_privilege('anon', 'orgs', 'select') as ok`);
    expect(anon.rows[0].ok).toBe(false);
    const auth = await sim.query(
      `select has_table_privilege('authenticated', 'skus', 'select') as ok`,
    );
    expect(auth.rows[0].ok).toBe(false);
  });

  it('app_user still executes the account functions', async () => {
    for (const fn of ACCOUNT_FNS) {
      const { rows } = await sim.query(
        `select has_function_privilege('app_user', $1::regprocedure, 'execute') as ok`,
        [fn],
      );
      expect({ fn, ok: rows[0].ok }).toEqual({ fn, ok: true });
    }
  });
});

describe('orgs are not insertable or deletable by app_user', () => {
  it('delete from orgs is permission denied', async () => {
    await expect(
      db.withTenant(VICTIM, (tx) => tx.execute(sql`delete from orgs`)),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/permission denied/) },
    });
  });
  it('insert into orgs is permission denied', async () => {
    await expect(
      db.withTenant(VICTIM, (tx) =>
        tx.execute(sql`insert into orgs (id, name, slug) values (gen_random_uuid(), 'x', 'x')`),
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/permission denied/) } });
  });
});
