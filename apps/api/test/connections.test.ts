import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decryptConnectionCredentials } from '@erq/connectors';
import { FakeShopify, signOAuthQuery } from '@erq/connectors/testing';
import { hashOAuthNonce } from '@erq/db';
import { EnvKeyProvider } from '@erq/shared';
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
    expect(rows[0].nonce_hash).toBe(hashOAuthNonce(nonce));
  });
  it("lazily deletes the org's expired states when a new install starts", async () => {
    const { orgId, h } = await createOrg('Lazy Cleanup Org');
    await owner.query(
      `insert into oauth_states (org_id, user_id, platform, shop, nonce_hash, expires_at)
       values ($1, gen_random_uuid(), 'shopify', 'old.myshopify.com', 'expired-hash', now() - interval '1 minute')`,
      [orgId],
    );
    const res = await request(server())
      .post(`/orgs/${orgId}/connections/shopify/install`)
      .set(h)
      .send({ shop: 'fresh.myshopify.com' });
    expect(res.status).toBe(201);
    const { rows } = await owner.query(`select shop from oauth_states where org_id = $1`, [orgId]);
    expect(rows).toEqual([{ shop: 'fresh.myshopify.com' }]);
  });
  it('rejects invalid shops, and viewers, analysts and anonymous callers', async () => {
    const { orgId, h } = await createOrg('Guarded Org');
    for (const shop of ['evil.com', 'a.myshopify.com.evil.com', 'https://a.myshopify.com']) {
      const res = await request(server())
        .post(`/orgs/${orgId}/connections/shopify/install`)
        .set(h)
        .send({ shop });
      expect(res.status, shop).toBe(400);
      expect(res.body.error.code, shop).toBe('invalid_shop');
    }
    // The empty string never reaches the service: the body schema (min length) rejects it first.
    const empty = await request(server())
      .post(`/orgs/${orgId}/connections/shopify/install`)
      .set(h)
      .send({ shop: '' });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('validation_failed');
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
    const analyst = await addMember(orgId, 'analyst');
    expect(
      (await request(server()).post(`/orgs/${orgId}/connections/${id}/disconnect`).set(analyst))
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
  it('lists connections created at the same instant in a stable order (id tiebreaker)', async () => {
    const { orgId, h } = await createOrg('Tie Org');
    const ids = [
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      '00000000-0000-4000-8000-000000000001',
      '88888888-8888-4888-8888-888888888888',
    ];
    for (const [i, id] of ids.entries()) {
      await owner.query(
        `insert into store_connections (id, org_id, platform, external_account_id, status, created_at)
         values ($1, $2, 'shopify', $3, 'active', '2026-01-01T00:00:00Z')`,
        [id, orgId, `tie-${i}.myshopify.com`],
      );
    }
    const list = await request(server()).get(`/orgs/${orgId}/connections`).set(h);
    expect(list.body.map((c: { id: string }) => c.id)).toEqual([...ids].sort());
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

describe('with Shopify configured but no encryption key', () => {
  it('refuses install with 503 before the merchant consents, and the callback says not_configured', async () => {
    const noKey: Record<string, string> = { ...SHOPIFY_ENV };
    delete noKey.ENCRYPTION_KEY_ID;
    delete noKey.ENCRYPTION_KEY;
    const keyless = await createTestApp({ env: noKey });
    try {
      const user = randomUUID();
      const auth = { authorization: `Bearer ${await keyless.signToken({ sub: user })}` };
      const org = await request(keyless.app.getHttpServer())
        .post('/orgs')
        .set(auth)
        .send({ name: 'Keyless Org' });
      const orgId = org.body.orgId as string;
      const res = await request(keyless.app.getHttpServer())
        .post(`/orgs/${orgId}/connections/shopify/install`)
        .set({ ...auth, 'x-org-id': orgId })
        .send({ shop: 'a.myshopify.com' });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('shopify_not_configured');
      const cb = await request(keyless.app.getHttpServer())
        .get('/connections/shopify/callback')
        .query(signed('any-state', { shop: 'a.myshopify.com' }))
        .redirects(0);
      expect(cb.status).toBe(302);
      expect(cb.headers.location).toBe(`${WEB}/connections?shopify_error=not_configured`);
    } finally {
      await keyless.close();
    }
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
      const cb = await request(bare.app.getHttpServer())
        .get('/connections/shopify/callback')
        .query(signed('any-state'))
        .redirects(0);
      expect(cb.status).toBe(302);
      expect(cb.headers.location).toBe(`${WEB}/connections?shopify_error=not_configured`);
    } finally {
      await bare.close();
    }
  });
});

const WEB = 'http://localhost:3000';
const callback = (q: Record<string, string>) =>
  request(server()).get('/connections/shopify/callback').query(q).redirects(0);
const nowTs = () => String(Math.floor(Date.now() / 1000));

async function startInstall(
  orgId: string,
  h: Record<string, string>,
  shop = 'new-shop.myshopify.com',
) {
  const res = await request(server())
    .post(`/orgs/${orgId}/connections/shopify/install`)
    .set(h)
    .send({ shop });
  return new URL(res.body.authorizeUrl).searchParams.get('state')!;
}
const signed = (state: string, over: Record<string, string> = {}) =>
  signOAuthQuery(
    {
      code: 'good-code',
      shop: 'new-shop.myshopify.com',
      state,
      timestamp: nowTs(),
      ...over,
    },
    'test-secret',
  );
const resign = (q: Record<string, string>, over: Record<string, string>) =>
  signOAuthQuery(
    { code: q.code!, shop: q.shop!, state: q.state!, timestamp: nowTs(), ...over },
    'test-secret',
  );

describe('GET /connections/shopify/callback', () => {
  // Every test uses the same shop domain, so free it between tests (a shop can be active in one org only).
  beforeEach(async () => {
    fake.reset(); // no scripted response or subscription leaks from one test into the next
    await owner.query(
      `update store_connections set status = 'disconnected' where external_account_id = 'new-shop.myshopify.com'`,
    );
  });
  it('connects the store: encrypted token, active status, scopes, webhooks, audit, redirect', async () => {
    const { orgId, user, h } = await createOrg('Callback Org');
    const state = await startInstall(orgId, h);
    const res = await callback(signed(state));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${WEB}/connections?shopify=connected`);
    const { rows } = await owner.query(
      `select id, status, scopes, encrypted_credentials, last_error from store_connections where org_id = $1`,
      [orgId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'active', last_error: null });
    expect(rows[0].scopes).toEqual(['read_orders', 'read_products']);
    expect(rows[0].encrypted_credentials).not.toContain('shpat_');
    const key = EnvKeyProvider.fromEnv({
      ENCRYPTION_KEY_ID: 'k1',
      ENCRYPTION_KEY: SHOPIFY_ENV.ENCRYPTION_KEY,
    });
    expect(decryptConnectionCredentials(rows[0].encrypted_credentials, key, rows[0].id)).toEqual({
      accessToken: 'shpat_fake_token',
    });
    expect(() =>
      decryptConnectionCredentials(rows[0].encrypted_credentials, key, randomUUID()),
    ).toThrow(); // bound to this connection
    // 1b-2 subscribes to the uninstall only: no customer-data topics before 1b-3.
    expect(fake.subscriptions.get('app/uninstalled')).toBe('http://api.test/webhooks/shopify');
    expect([...fake.subscriptions.keys()]).toEqual(['app/uninstalled']);
    expect(
      (
        await owner.query(
          `select actor_user_id, after_json from audit_log where org_id = $1 and action = 'connection.connected'`,
          [orgId],
        )
      ).rows,
    ).toEqual([
      { actor_user_id: user, after_json: { platform: 'shopify', shop: 'new-shop.myshopify.com' } },
    ]);
  });
  it('a reconnect updates the same row and resets an error state', async () => {
    const { orgId, h } = await createOrg('Reconnect Org');
    await callback(signed(await startInstall(orgId, h)));
    const first = await owner.query(`select id from store_connections where org_id = $1`, [orgId]);
    await owner.query(
      `update store_connections set status = 'error', last_error = 'x' where org_id = $1`,
      [orgId],
    );
    const res = await callback(signed(await startInstall(orgId, h)));
    expect(res.headers.location).toBe(`${WEB}/connections?shopify=connected`);
    const { rows } = await owner.query(
      `select id, status, last_error from store_connections where org_id = $1`,
      [orgId],
    );
    expect(rows).toEqual([{ id: first.rows[0].id, status: 'active', last_error: null }]);
  });
  it.each([
    [
      'a tampered signature',
      (q: Record<string, string>) => ({ ...q, code: 'other' }),
      'invalid_request',
    ],
    [
      'an unsigned request',
      (q: Record<string, string>) =>
        Object.fromEntries(Object.entries(q).filter(([k]) => k !== 'hmac')),
      'invalid_request',
    ],
    [
      'an invalid shop',
      (q: Record<string, string>) => resign(q, { shop: 'evil.com' }),
      'invalid_request',
    ],
    [
      'a stale timestamp',
      (q: Record<string, string>) => resign(q, { timestamp: '1000' }),
      'invalid_request',
    ],
    [
      'a state that was never issued',
      (q: Record<string, string>) => resign(q, { state: 'made-up' }),
      'state_expired',
    ],
    [
      'a state minted for another shop',
      (q: Record<string, string>) => resign(q, { shop: 'other-shop.myshopify.com' }),
      'shop_mismatch',
    ],
    [
      'a rejected authorization code',
      (q: Record<string, string>) => resign(q, { code: 'bad-code' }),
      'exchange_failed',
    ],
  ])('rejects %s without creating a connection', async (_label, mutate, code) => {
    const { orgId, h } = await createOrg(`Reject ${code} ${randomUUID().slice(0, 4)}`);
    const state = await startInstall(orgId, h);
    const res = await callback(mutate(signed(state)));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${WEB}/connections?shopify_error=${code}`);
    expect(
      (await owner.query(`select 1 from store_connections where org_id = $1`, [orgId])).rowCount,
    ).toBe(0);
  });
  it('cannot be replayed and rejects an expired state', async () => {
    const { orgId, h } = await createOrg('Replay Org');
    const state = await startInstall(orgId, h);
    expect((await callback(signed(state))).headers.location).toContain('shopify=connected');
    expect((await callback(signed(state))).headers.location).toBe(
      `${WEB}/connections?shopify_error=state_expired`,
    );
    const old = await startInstall(orgId, h);
    await owner.query(
      `update oauth_states set expires_at = now() - interval '1 minute' where org_id = $1`,
      [orgId],
    );
    expect((await callback(signed(old))).headers.location).toBe(
      `${WEB}/connections?shopify_error=state_expired`,
    );
  });
  it('consumes the state even when the shop does not match', async () => {
    const { orgId, h } = await createOrg('Mismatch Org');
    const state = await startInstall(orgId, h);
    expect(
      (await callback(signed(state, { shop: 'other-shop.myshopify.com' }))).headers.location,
    ).toBe(`${WEB}/connections?shopify_error=shop_mismatch`);
    expect((await callback(signed(state))).headers.location).toBe(
      `${WEB}/connections?shopify_error=state_expired`,
    );
    expect(
      (await owner.query(`select 1 from store_connections where org_id = $1`, [orgId])).rowCount,
    ).toBe(0);
  });
  it('refuses a shop that is actively connected to a different org', async () => {
    const one = await createOrg('Shop Owner One');
    await callback(signed(await startInstall(one.orgId, one.h)));
    const two = await createOrg('Shop Owner Two');
    const res = await callback(signed(await startInstall(two.orgId, two.h)));
    expect(res.headers.location).toBe(`${WEB}/connections?shopify_error=shop_in_use`);
    expect(
      (await owner.query(`select 1 from store_connections where org_id = $1`, [two.orgId]))
        .rowCount,
    ).toBe(0);
  });
  it('keeps the connection but warns when webhook registration fails', async () => {
    const { orgId, h } = await createOrg('Warn Org');
    const state = await startInstall(orgId, h);
    // First scripted response answers the token exchange, the second fails the first webhook registration call.
    fake.respondNext({
      status: 200,
      body: JSON.stringify({ access_token: 'shpat_x', scope: 'read_orders' }),
    });
    fake.failNext(500);
    const res = await callback(signed(state));
    expect(res.headers.location).toBe(`${WEB}/connections?shopify=connected&warning=webhooks`);
    const { rows } = await owner.query(
      `select status, last_error from store_connections where org_id = $1`,
      [orgId],
    );
    expect(rows[0]).toMatchObject({
      status: 'active',
      last_error: 'Webhook setup failed. Reconnect to retry.',
    });
  });
});
