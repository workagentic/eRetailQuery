import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers/app';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t?.close();
});

const server = () => t.app.getHttpServer();
async function as(sub: string, email: string) {
  const token = await t.signToken({ sub, email });
  return { authorization: `Bearer ${token}` };
}

describe('POST /orgs and GET /me', () => {
  it('creates an org owned by the caller and lists it in /me', async () => {
    const user = randomUUID();
    const h = await as(user, 'owner@example.com');
    const created = await request(server()).post('/orgs').set(h).send({ name: 'Acme Goods' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Acme Goods', slug: 'acme-goods', role: 'owner' });
    const me = await request(server()).get('/me').set(h);
    expect(me.body.user).toEqual({ id: user, email: 'owner@example.com' });
    expect(me.body.orgs.map((o: { orgId: string }) => o.orgId)).toEqual([created.body.orgId]);
  });
  it('validates input with the standard error shape', async () => {
    const h = await as(randomUUID(), 'x@example.com');
    const res = await request(server()).post('/orgs').set(h).send({ name: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'validation_failed' });
    expect((await request(server()).post('/orgs').set(h)).status).toBe(400);
  });
  it('answers malformed JSON with a fixed 400 that never echoes the body', async () => {
    const h = await as(randomUUID(), 'x@example.com');
    const res = await request(server())
      .post('/orgs')
      .set(h)
      .set('content-type', 'application/json')
      .send('{"name": DISTINCTIVEFRAGMENT,}');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code: 'bad_request', message: 'Invalid request body' } });
    expect(res.text).not.toContain('DISTINCTIVEFRAGMENT');
  });
  it('requires authentication', async () => {
    expect((await request(server()).get('/me')).status).toBe(401);
    expect((await request(server()).post('/orgs').send({ name: 'Nope Inc' })).status).toBe(401);
  });
});

describe('members and invites', () => {
  const ownerId = randomUUID();
  const guestId = randomUUID();
  let orgId: string;
  let owner: Record<string, string>;
  let guest: Record<string, string>;

  beforeAll(async () => {
    owner = await as(ownerId, 'owner@invite.test');
    guest = await as(guestId, 'guest@invite.test');
    orgId = (await request(server()).post('/orgs').set(owner).send({ name: 'Invite Test Co' })).body
      .orgId;
  });

  it('lists members for any member', async () => {
    const res = await request(server())
      .get(`/orgs/${orgId}/members`)
      .set({ ...owner, 'x-org-id': orgId });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ userId: ownerId, role: 'owner', joinedAt: expect.any(String) }]);
  });
  it('requires the X-Org-Id header to match the URL', async () => {
    const res = await request(server())
      .get(`/orgs/${orgId}/members`)
      .set({ ...owner, 'x-org-id': randomUUID() });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('org_mismatch');
  });

  it('full invite flow: create, list (no token), accept, then member', async () => {
    const created = await request(server())
      .post(`/orgs/${orgId}/invites`)
      .set({ ...owner, 'x-org-id': orgId })
      .send({ email: 'Guest@Invite.test', role: 'viewer' });
    expect(created.status).toBe(201);
    expect(created.body.email).toBe('guest@invite.test');
    expect(created.body.acceptUrl).toMatch(/^http:\/\/localhost:3000\/invite\/[A-Za-z0-9_-]{20,}$/);
    const token = created.body.acceptUrl.split('/invite/')[1];

    const listed = await request(server())
      .get(`/orgs/${orgId}/invites`)
      .set({ ...owner, 'x-org-id': orgId });
    expect(listed.body).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(token);

    const accepted = await request(server()).post(`/invites/${token}/accept`).set(guest);
    expect(accepted.status).toBe(201);
    expect(accepted.body).toEqual({ orgId, role: 'viewer' });

    const members = await request(server())
      .get(`/orgs/${orgId}/members`)
      .set({ ...guest, 'x-org-id': orgId });
    expect(members.body.map((m: { userId: string }) => m.userId).sort()).toEqual(
      [ownerId, guestId].sort(),
    );

    const again = await request(server()).post(`/invites/${token}/accept`).set(guest);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('invite_invalid');
    expect(
      (
        await request(server())
          .get(`/orgs/${orgId}/invites`)
          .set({ ...owner, 'x-org-id': orgId })
      ).body,
    ).toEqual([]);
  });

  it('refuses acceptance by a different email', async () => {
    const created = await request(server())
      .post(`/orgs/${orgId}/invites`)
      .set({ ...owner, 'x-org-id': orgId })
      .send({ email: 'someone@else.test', role: 'analyst' });
    const token = created.body.acceptUrl.split('/invite/')[1];
    const mallory = await as(randomUUID(), 'mallory@evil.test');
    const res = await request(server()).post(`/invites/${token}/accept`).set(mallory);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invite_invalid');
  });

  it('viewers cannot create or list invites', async () => {
    const h = { ...guest, 'x-org-id': orgId };
    expect(
      (
        await request(server())
          .post(`/orgs/${orgId}/invites`)
          .set(h)
          .send({ email: 'a@b.co', role: 'viewer' })
      ).status,
    ).toBe(403);
    expect((await request(server()).get(`/orgs/${orgId}/invites`).set(h)).status).toBe(403);
  });
  it('rejects inviting an owner and invalid emails', async () => {
    const h = { ...owner, 'x-org-id': orgId };
    expect(
      (
        await request(server())
          .post(`/orgs/${orgId}/invites`)
          .set(h)
          .send({ email: 'a@b.co', role: 'owner' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(server())
          .post(`/orgs/${orgId}/invites`)
          .set(h)
          .send({ email: 'nope', role: 'viewer' })
      ).status,
    ).toBe(400);
  });
  it('unknown tokens give invite_invalid, not a 500', async () => {
    const res = await request(server()).post('/invites/does-not-exist/accept').set(guest);
    expect(res.status).toBe(400);
  });
  it('writes audit entries for invite creation', async () => {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: t.tdb.ownerUrl });
    let rows: { action: string }[];
    try {
      ({ rows } = await pool.query(
        `select action from audit_log where org_id = $1 order by created_at`,
        [orgId],
      ));
    } finally {
      await pool.end();
    }
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['org.created', 'invite.created', 'invite.accepted']),
    );
  });
});

describe('tenant isolation over HTTP', () => {
  it("a user cannot read another org's members even with a valid token", async () => {
    const aOwner = await as(randomUUID(), 'a@a.test');
    const bOwner = await as(randomUUID(), 'b@b.test');
    const orgA = (await request(server()).post('/orgs').set(aOwner).send({ name: 'Org A' })).body
      .orgId;
    await request(server()).post('/orgs').set(bOwner).send({ name: 'Org B' });
    const res = await request(server())
      .get(`/orgs/${orgA}/members`)
      .set({ ...bOwner, 'x-org-id': orgA });
    expect(res.status).toBe(403);
  });
});
