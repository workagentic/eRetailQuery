import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  createAccountApi,
  createTenantDb,
  generateInviteToken,
  hashInviteToken,
  InviteInvalidError,
  type TenantDb,
} from '../src';
import { startTestDatabase, type TestDatabase } from '../src/testing';

const U1 = '00000000-0000-4000-8000-0000000000a1';
const U2 = '00000000-0000-4000-8000-0000000000a2';
let tdb: TestDatabase;
let owner: Pool;
let db: TenantDb;
let account: ReturnType<typeof createAccountApi>;

async function seedInvite(orgId: string, email: string, opts: { expired?: boolean } = {}) {
  const token = generateInviteToken();
  await owner.query(
    `insert into invites (org_id, email, role, token_hash, expires_at)
     values ($1, $2, 'analyst', $3, now() + ($4 || ' hours')::interval)`,
    [orgId, email, hashInviteToken(token), opts.expired ? '-1' : '24'],
  );
  return token;
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  db = createTenantDb(tdb.appUrl);
  account = createAccountApi(db.pool);
});
afterAll(async () => {
  await db?.close();
  await owner?.end();
  await tdb?.stop();
});

describe('createOrg / listUserOrgs', () => {
  it('creates the org with an owner membership, a subscription, and an audit entry', async () => {
    const org = await account.createOrg(U1, 'Acme Goods');
    expect(org).toMatchObject({ name: 'Acme Goods', slug: 'acme-goods', role: 'owner' });
    const counts = await owner.query(
      `select (select count(*) from org_members where org_id = $1)::int m,
              (select count(*) from subscriptions where org_id = $1)::int s,
              (select count(*) from audit_log where org_id = $1 and action = 'org.created')::int a`,
      [org.orgId],
    );
    expect(counts.rows[0]).toEqual({ m: 1, s: 1, a: 1 });
  });
  it('suffixes the slug on collision', async () => {
    const a = await account.createOrg(U1, 'Same Name');
    const b = await account.createOrg(U2, 'Same Name');
    expect(a.slug).toBe('same-name');
    expect(b.slug).toMatch(/^same-name-[0-9a-f]{6}$/);
  });
  it("lists only the caller's orgs", async () => {
    const mine = await account.listUserOrgs(U2);
    expect(mine.every((o) => o.role === 'owner')).toBe(true);
    expect(mine.map((o) => o.name)).toContain('Same Name');
    expect(mine.map((o) => o.name)).not.toContain('Acme Goods');
    expect(await account.listUserOrgs('00000000-0000-4000-8000-0000000000ff')).toEqual([]);
  });
});

describe('acceptInvite', () => {
  it('adds the member once and marks the invite accepted', async () => {
    const org = await account.createOrg(U1, 'Invite Co');
    const token = await seedInvite(org.orgId, 'bob@example.com');
    const result = await account.acceptInvite(U2, 'Bob@Example.com', token);
    expect(result).toEqual({ orgId: org.orgId, role: 'analyst' });
    expect((await account.listUserOrgs(U2)).map((o) => o.orgId)).toContain(org.orgId);
  });
  it('rejects reuse of the same token', async () => {
    const org = await account.createOrg(U1, 'Reuse Co');
    const token = await seedInvite(org.orgId, 'bob@example.com');
    await account.acceptInvite(U2, 'bob@example.com', token);
    await expect(account.acceptInvite(U2, 'bob@example.com', token)).rejects.toBeInstanceOf(
      InviteInvalidError,
    );
  });
  it('rejects expired invites', async () => {
    const org = await account.createOrg(U1, 'Expired Co');
    const token = await seedInvite(org.orgId, 'bob@example.com', { expired: true });
    await expect(account.acceptInvite(U2, 'bob@example.com', token)).rejects.toBeInstanceOf(
      InviteInvalidError,
    );
  });
  it('rejects a user whose email differs from the invited email', async () => {
    const org = await account.createOrg(U1, 'Wrong Email Co');
    const token = await seedInvite(org.orgId, 'bob@example.com');
    await expect(account.acceptInvite(U2, 'mallory@example.com', token)).rejects.toBeInstanceOf(
      InviteInvalidError,
    );
    expect((await account.listUserOrgs(U2)).map((o) => o.orgId)).not.toContain(org.orgId);
  });
  it('rejects unknown tokens', async () => {
    await expect(account.acceptInvite(U2, 'bob@example.com', 'nope')).rejects.toBeInstanceOf(
      InviteInvalidError,
    );
  });
});

describe('privileges', () => {
  it('app_user can execute the functions but not read tables without tenant context', async () => {
    const { rows } = await db.pool.query('select * from org_members');
    expect(rows).toEqual([]);
  });
});
