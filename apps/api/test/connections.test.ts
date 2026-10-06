import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeShopify } from '@erq/connectors/testing';
import { HTTP_CLIENT } from '../src/connections/tokens';
import { createTestApp, type TestApp } from './helpers/app';

const SHOPIFY_ENV = {
  API_PUBLIC_URL: 'http://api.test',
  SHOPIFY_API_KEY: 'test-key',
  SHOPIFY_API_SECRET: 'test-secret',
  ENCRYPTION_KEY_ID: 'k1',
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
};

let t: TestApp;
let owner: Pool;
let fake: FakeShopify;
beforeAll(async () => {
  fake = new FakeShopify();
  t = await createTestApp({
    env: SHOPIFY_ENV,
    overrides: [{ provide: HTTP_CLIENT, useValue: fake }],
  });
  owner = new Pool({ connectionString: t.tdb.ownerUrl });
});
afterAll(async () => {
  await owner?.end();
  await t?.close();
});
const server = () => t.app.getHttpServer();

async function createOrg(name = 'Acme Goods') {
  const user = randomUUID();
  const h = { authorization: `Bearer ${await t.signToken({ sub: user })}` };
  const org = await request(server()).post('/orgs').set(h).send({ name });
  return {
    user,
    orgId: org.body.orgId as string,
    h: { ...h, 'x-org-id': org.body.orgId as string },
  };
}
async function addMember(orgId: string, role: 'analyst' | 'viewer') {
  const user = randomUUID();
  await owner.query(`insert into org_members (org_id, user_id, role) values ($1, $2, $3)`, [
    orgId,
    user,
    role,
  ]);
  return { authorization: `Bearer ${await t.signToken({ sub: user })}`, 'x-org-id': orgId };
}

describe('POST /orgs/:orgId/connections/shopify/install', () => {
  it('returns an authorize URL bound to a stored, hashed state', async () => {
    const { orgId, h } = await createOrg();
    const res = await request(server())
      .post(`/orgs/${orgId}/connections/shopify/install`)
      .set(h)
      .send({ shop: ' My-Store.myshopify.com ' });
    expect(res.status).toBe(201);
    const url = new URL(res.body.authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://my-store.myshopify.com/admin/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('test-key');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://api.test/connections/shopify/callback',
    );
    const nonce = url.searchParams.get('state')!;
    const { rows } = await owner.query(
      `select nonce_hash, shop from oauth_states where org_id = $1`,
      [orgId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].shop).toBe('my-store.myshopify.com');
    expect(rows[0].nonce_hash).not.toBe(nonce); // only the hash is stored
  });
  it('rejects invalid shops, and viewers, analysts and anonymous callers', async () => {
    const { orgId, h } = await createOrg('Guarded Org');
    for (const shop of ['evil.com', 'a.myshopify.com.evil.com', 'https://a.myshopify.com', '']) {
      const res = await request(server())
        .post(`/orgs/${orgId}/connections/shopify/install`)
        .set(h)
        .send({ shop });
      expect(res.status, shop).toBe(400);
    }
    for (const role of ['viewer', 'analyst'] as const) {
      const member = await addMember(orgId, role);
      const res = await request(server())
        .post(`/orgs/${orgId}/connections/shopify/install`)
        .set(member)
        .send({ shop: 'a.myshopify.com' });
      expect(res.status, role).toBe(403);
    }
    expect(
      (
        await request(server())
          .post(`/orgs/${orgId}/connections/shopify/install`)
          .send({ shop: 'a.myshopify.com' })
      ).status,
    ).toBe(401);
  });
});

describe('GET /orgs/:orgId/connections and disconnect', () => {
  it('lists connections without any credential fields and lets admins disconnect (status change, token wiped, audited)', async () => {
    const { orgId, h } = await createOrg('Listing Org');
    const { rows } = await owner.query(
      `insert into store_connections (org_id, platform, external_account_id, status, encrypted_credentials, last_error)
       values ($1, 'shopify', 'listed.myshopify.com', 'active', 'ciphertext', 'boom') returning id`,
      [orgId],
    );
    const id = rows[0].id as string;
    const list = await request(server()).get(`/orgs/${orgId}/connections`).set(h);
    expect(list.status).toBe(200);
    expect(list.body).toEqual([
      {
        id,
        platform: 'shopify',
        shop: 'listed.myshopify.com',
        status: 'active',
        lastSyncedAt: null,
        lastError: 'boom',
      },
    ]);
    expect(JSON.stringify(list.body)).not.toMatch(/ciphertext|credential|token/i);
    const viewer = await addMember(orgId, 'viewer');
    expect((await request(server()).get(`/orgs/${orgId}/connections`).set(viewer)).status).toBe(
      200,
    );
    expect(
      (await request(server()).post(`/orgs/${orgId}/connections/${id}/disconnect`).set(viewer))
        .status,
    ).toBe(403);
    const res = await request(server()).post(`/orgs/${orgId}/connections/${id}/disconnect`).set(h);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
    const after = await owner.query(
      `select status, encrypted_credentials from store_connections where id = $1`,
      [id],
    );
    expect(after.rows[0]).toEqual({ status: 'disconnected', encrypted_credentials: null });
    expect(
      (
        await owner.query(
          `select 1 from audit_log where org_id = $1 and action = 'connection.disconnected' and entity_id = $2`,
          [orgId, id],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (await request(server()).post(`/orgs/${orgId}/connections/${randomUUID()}/disconnect`).set(h))
        .status,
    ).toBe(404);
    expect(
      (await request(server()).post(`/orgs/${orgId}/connections/not-a-uuid/disconnect`).set(h))
        .status,
    ).toBe(400);
  });
  it("never shows or touches another org's connections", async () => {
    const a = await createOrg('Org One');
    const b = await createOrg('Org Two');
    const { rows } = await owner.query(
      `insert into store_connections (org_id, platform, external_account_id, status) values ($1, 'shopify', 'one.myshopify.com', 'active') returning id`,
      [a.orgId],
    );
    expect((await request(server()).get(`/orgs/${b.orgId}/connections`).set(b.h)).body).toEqual([]);
    expect(
      (
        await request(server())
          .post(`/orgs/${b.orgId}/connections/${rows[0].id}/disconnect`)
          .set(b.h)
      ).status,
    ).toBe(404);
    expect((await request(server()).get(`/orgs/${a.orgId}/connections`).set(b.h)).status).toBe(400); // header/url mismatch
  });
});

describe('without Shopify configuration', () => {
  it('answers 503 shopify_not_configured while /health still works', async () => {
    const bare = await createTestApp();
    try {
      const user = randomUUID();
      const auth = { authorization: `Bearer ${await bare.signToken({ sub: user })}` };
      const org = await request(bare.app.getHttpServer())
        .post('/orgs')
        .set(auth)
        .send({ name: 'Bare Org' });
      const orgId = org.body.orgId as string;
      const res = await request(bare.app.getHttpServer())
        .post(`/orgs/${orgId}/connections/shopify/install`)
        .set({ ...auth, 'x-org-id': orgId })
        .send({ shop: 'a.myshopify.com' });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('shopify_not_configured');
      expect((await request(bare.app.getHttpServer()).get('/health')).status).toBe(200);
    } finally {
      await bare.close();
    }
  });
});
