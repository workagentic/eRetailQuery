import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { startTestDatabase, type TestDatabase } from '../src/testing';
import { fixtures } from './fixtures';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const APPEND_ONLY = new Set(['audit_log']); // app_user has no UPDATE/DELETE grant by design
const NO_DELETE = new Set(['orgs']); // app_user cannot DELETE (or INSERT) orgs: owner-only / SECURITY DEFINER

let tdb: TestDatabase;
let owner: Pool;
let app: Pool;

async function asTenant<T>(orgId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await app.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.org_id', $1, true)`, [orgId]);
    const result = await fn(c);
    await c.query('commit');
    return result;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  app = new Pool({ connectionString: tdb.appUrl });
  for (const org of [ORG_A, ORG_B]) {
    for (const insert of Object.values(fixtures)) await insert(owner, org);
  }
});
afterAll(async () => {
  await app?.end();
  await owner?.end();
  await tdb?.stop();
});

it('every public table has RLS enabled and forced, a tenant column, and a fixture', async () => {
  const { rows } = await owner.query(`
    select c.relname as name, c.relkind as kind, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
      exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped) as has_org_id
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p','v','m')`);
  const problems: string[] = [];
  for (const t of rows) {
    if (t.kind === 'v' || t.kind === 'm') {
      problems.push(
        `${t.name}: views/materialized views bypass RLS: use security_invoker views or a summary table with RLS`,
      );
      continue;
    }
    if (!t.has_org_id && t.name !== 'orgs') problems.push(`${t.name}: no org_id column`);
    if (!t.rls || !t.forced) problems.push(`${t.name}: RLS must be enabled and forced`);
    if (!(t.name in fixtures)) problems.push(`${t.name}: add a fixture in test/fixtures.ts`);
  }
  expect(problems).toEqual([]);
});

describe.each(Object.keys(fixtures))('tenant isolation: %s', (table) => {
  const col = table === 'orgs' ? 'id' : 'org_id';

  it('tenant B sees only its own rows (and can see its own: not vacuous)', async () => {
    await asTenant(ORG_B, async (c) => {
      const own = await c.query(`select ${col} from ${table}`);
      expect(own.rows.length).toBeGreaterThan(0);
      expect(own.rows.every((r) => r[col] === ORG_B)).toBe(true);
      expect((await c.query(`select 1 from ${table} where ${col} = $1`, [ORG_A])).rowCount).toBe(0);
    });
  });

  it.skipIf(APPEND_ONLY.has(table))('tenant B cannot update or delete tenant A rows', async () => {
    await asTenant(ORG_B, async (c) => {
      expect(
        (await c.query(`update ${table} set ${col} = ${col} where ${col} = $1`, [ORG_A])).rowCount,
      ).toBe(0);
      if (NO_DELETE.has(table)) {
        await expect(c.query(`delete from ${table} where ${col} = $1`, [ORG_A])).rejects.toThrow(
          /permission denied/,
        );
      } else {
        expect((await c.query(`delete from ${table} where ${col} = $1`, [ORG_A])).rowCount).toBe(0);
      }
    });
  });

  it.skipIf(APPEND_ONLY.has(table))(
    'WITH CHECK: tenant A cannot move its row to tenant B',
    async () => {
      await expect(
        asTenant(ORG_A, (c) =>
          c.query(`update ${table} set ${col} = $1 where ${col} = $2`, [ORG_B, ORG_A]),
        ),
      ).rejects.toThrow(/row-level security|violates/);
    },
  );

  it.skipIf(APPEND_ONLY.has(table))(
    'positive control: tenant A can update its own rows',
    async () => {
      const res = await asTenant(ORG_A, (c) => c.query(`update ${table} set ${col} = ${col}`));
      expect(res.rowCount).toBeGreaterThan(0);
    },
  );

  it('tenant B cannot insert a row for tenant A', async () => {
    await expect(asTenant(ORG_B, (c) => fixtures[table]!(c, ORG_A))).rejects.toThrow(
      // orgs: app_user has no INSERT grant at all, so the grant check fires before RLS.
      NO_DELETE.has(table) ? /permission denied|row-level security/ : /row-level security/,
    );
  });

  it('no tenant context returns zero rows', async () => {
    const { rows } = await app.query(`select 1 from ${table}`);
    expect(rows).toEqual([]);
  });
});
