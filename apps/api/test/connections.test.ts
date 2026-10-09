import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptConnectionCredentials } from '@erq/connectors';
import { FakeShopify, signOAuthRawQuery, signRawPairs } from '@erq/connectors/testing';
import { hashOAuthNonce, type ConnectionsApi } from '@erq/db';
import {
  IMPORT_NOT_STARTED_MESSAGE,
  ORDERS_HISTORY_DAYS,
  type JobQueue,
  type SyncPageJob,
} from '@erq/sync';
import { EnvKeyProvider } from '@erq/shared';
import type { SyncQueuePort } from '../src/connections/sync-queue';
import { syncStartTimeout } from '../src/connections/connections.service';
import { warnIfNoSyncQueue } from '../src/connections/connections.module';
import { NoopSyncQueue } from '../src/connections/sync-queue';
import { CONNECTIONS_API, HTTP_CLIENT, SYNC_QUEUE_PORT } from '../src/connections/tokens';
import { TENANT_DB } from '../src/db/db.module';
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

/** Records page jobs instead of talking to Redis; `fail` makes enqueue throw like a down Redis. */
class RecordingSyncQueue implements SyncQueuePort, JobQueue {
  available = true;
  fail = false;
  jobs: SyncPageJob[] = [];
  async enqueue(job: SyncPageJob): Promise<void> {
    if (this.fail) throw new Error('redis is down');
    this.jobs.push(job);
  }
  reset(): void {
    this.available = true;
    this.fail = false;
    this.jobs = [];
  }
}
const syncQueue = new RecordingSyncQueue();

beforeAll(async () => {
  fake = new FakeShopify();
  t = await createTestApp({
    env: SHOPIFY_ENV,
    overrides: [
      { provide: HTTP_CLIENT, useValue: fake },
      { provide: SYNC_QUEUE_PORT, useValue: syncQueue },
    ],
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
async function addMember(orgId: string, role: 'admin' | 'analyst' | 'viewer') {
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
    // Shopify sends the browser to the web app, which forwards the query to the authenticated API callback.
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3000/connections/shopify/callback',
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
        sync: {
          state: 'never',
          resource: null,
          recordsProcessed: 0,
          coveredFrom: null,
          historyLimited: true,
          error: null,
          canStart: true,
          resources: [
            { resource: 'locations', state: 'never', lastCompletedAt: null, error: null },
            { resource: 'products', state: 'never', lastCompletedAt: null, error: null },
            { resource: 'inventory', state: 'never', lastCompletedAt: null, error: null },
            { resource: 'orders', state: 'never', lastCompletedAt: null, error: null },
          ],
          unlinkedLines: 0,
        },
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

const WEB = 'http://localhost:3000';
const SHOP = 'new-shop.myshopify.com';
const nowTs = () => String(Math.floor(Date.now() / 1000));
const rawSigned = (
  state: string,
  shop = SHOP,
  over: Record<string, string> = {},
  mode: 'encoded' | 'decoded' = 'encoded',
) =>
  signOAuthRawQuery(
    {
      code: 'good-code',
      host: 'YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvYQ==',
      shop,
      state,
      timestamp: nowTs(),
      ...over,
    },
    'test-secret',
    mode,
  );
const callbackOn = (app: TestApp, headers: Record<string, string>, query: string) =>
  request(app.app.getHttpServer())
    .post('/connections/shopify/callback')
    .set(headers)
    .send({ query });
const callbackAs = (headers: Record<string, string>, query: string) =>
  callbackOn(t, headers, query);
const authOnly = (h: Record<string, string>) => ({ authorization: h.authorization! });
const connected = `${WEB}/connections?shopify=connected`;
const failed = (code: string) => `${WEB}/connections?shopify_error=${code}`;

async function startInstall(orgId: string, h: Record<string, string>, shop = SHOP) {
  const res = await request(server())
    .post(`/orgs/${orgId}/connections/shopify/install`)
    .set(h)
    .send({ shop });
  return new URL(res.body.authorizeUrl).searchParams.get('state')!;
}
/** The token exchange is the first network call after the pre-checks; a refused callback must never reach it. */
const exchangeRequests = () =>
  fake.requests.filter((r) => new URL(r.url).pathname === '/admin/oauth/access_token');
const connectionCount = async (orgId: string) =>
  (await owner.query(`select 1 from store_connections where org_id = $1`, [orgId])).rowCount;

describe('with Shopify configured but no encryption key', () => {
  it(
    'refuses install with 503 before the merchant consents, and the callback says not_configured',
    { timeout: 180_000 },
    async () => {
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
        const cb = await callbackOn(keyless, auth, rawSigned('any-state', 'a.myshopify.com'));
        expect(cb.status).toBe(200);
        expect(cb.body).toEqual({ redirectTo: failed('not_configured') });
      } finally {
        await keyless.close();
      }
    },
  );
});

describe('without Shopify configuration', () => {
  it(
    'answers 503 shopify_not_configured while /health still works',
    { timeout: 180_000 },
    async () => {
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
        const cb = await callbackOn(bare, auth, rawSigned('any-state'));
        expect(cb.status).toBe(200);
        expect(cb.body).toEqual({ redirectTo: failed('not_configured') });
      } finally {
        await bare.close();
      }
    },
  );
});

describe('POST /connections/shopify/callback', () => {
  // Most tests use the same shop domain, so free it between tests (a shop can be active in one org only).
  beforeEach(async () => {
    fake.reset(); // no scripted response or subscription leaks from one test into the next
    await owner.query(
      `update store_connections set status = 'disconnected' where external_account_id = $1`,
      [SHOP],
    );
  });

  it.each(['encoded', 'decoded'] as const)(
    'connects the store for the user who started it (%s signature): encrypted token, webhooks, audit',
    async (mode) => {
      const { orgId, user, h } = await createOrg(`Callback Org ${mode}`);
      const state = await startInstall(orgId, h);
      const res = await callbackAs(authOnly(h), rawSigned(state, SHOP, {}, mode));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ redirectTo: connected });
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
      expect(
        decryptConnectionCredentials(rows[0].encrypted_credentials, key, rows[0].id),
      ).toMatchObject({
        accessToken: 'shpat_fake_token',
        refreshToken: 'shprt_fake_refresh',
      });
      expect(() =>
        decryptConnectionCredentials(rows[0].encrypted_credentials, key, randomUUID()),
      ).toThrow(); // bound to this connection
      // 1b-2 subscribes to the uninstall only: no customer-data topics before 1b-3.
      expect(fake.subscriptions.get('app/uninstalled')).toBe('http://api.test/webhooks/shopify');
      // Only non-customer topics; order, refund and customer topics wait for protected customer data approval.
      expect([...fake.subscriptions.keys()]).toEqual([
        'app/uninstalled',
        'products/update',
        'inventory_levels/update',
      ]);
      expect(
        (
          await owner.query(
            `select actor_user_id, after_json from audit_log where org_id = $1 and action = 'connection.connected'`,
            [orgId],
          )
        ).rows,
      ).toEqual([{ actor_user_id: user, after_json: { platform: 'shopify', shop: SHOP } }]);
    },
  );

  it('stores an expiring token set encrypted, mirrors only the expiry times in plain columns, and keeps both tokens out of audit rows, the list and jobs', async () => {
    const { orgId, h } = await createOrg('Expiring Org');
    const state = await startInstall(orgId, h);
    fake.respondNext({
      status: 200,
      body: JSON.stringify({
        access_token: 'shpat_unique_91bb',
        scope: 'read_orders',
        expires_in: 3600,
        refresh_token: 'shprt_unique_91bb',
        refresh_token_expires_in: 7776000,
      }),
    });
    const before = Date.now();
    const res = await callbackAs(authOnly(h), rawSigned(state));
    expect(res.body).toEqual({ redirectTo: connected });
    const { rows } = await owner.query(
      `select id, encrypted_credentials, access_token_expires_at, refresh_token_expires_at from store_connections where org_id = $1`,
      [orgId],
    );
    const key = EnvKeyProvider.fromEnv({
      ENCRYPTION_KEY_ID: 'k1',
      ENCRYPTION_KEY: SHOPIFY_ENV.ENCRYPTION_KEY,
    });
    const creds = decryptConnectionCredentials(
      rows[0].encrypted_credentials,
      key,
      rows[0].id,
    ) as Record<string, string>;
    expect(Object.keys(creds).sort()).toEqual([
      'accessToken',
      'accessTokenExpiresAt',
      'refreshToken',
      'refreshTokenExpiresAt',
    ]);
    expect([creds.accessToken, creds.refreshToken]).toEqual([
      'shpat_unique_91bb',
      'shprt_unique_91bb',
    ]);
    const accessAt = new Date(creds.accessTokenExpiresAt!).getTime();
    expect(accessAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(accessAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
    expect(rows[0].access_token_expires_at.toISOString()).toBe(creds.accessTokenExpiresAt);
    expect(rows[0].refresh_token_expires_at.toISOString()).toBe(creds.refreshTokenExpiresAt);
    const audit = await owner.query(`select * from audit_log where org_id = $1`, [orgId]);
    const listed = await request(server()).get(`/orgs/${orgId}/connections`).set(h);
    const visible = JSON.stringify([rows, audit.rows, listed.body, syncQueue.jobs]);
    for (const secret of ['shpat_unique_91bb', 'shprt_unique_91bb'])
      expect(visible).not.toContain(secret);
  });

  it('stores a non-expiring response as the old shape with empty expiry columns', async () => {
    const { orgId, h } = await createOrg('Non Expiring Org');
    const state = await startInstall(orgId, h);
    fake.respondNext({
      status: 200,
      body: JSON.stringify({ access_token: 'shpat_old_77', scope: 'read_orders' }),
    });
    await callbackAs(authOnly(h), rawSigned(state));
    const { rows } = await owner.query(
      `select id, encrypted_credentials, access_token_expires_at, refresh_token_expires_at from store_connections where org_id = $1`,
      [orgId],
    );
    const key = EnvKeyProvider.fromEnv({
      ENCRYPTION_KEY_ID: 'k1',
      ENCRYPTION_KEY: SHOPIFY_ENV.ENCRYPTION_KEY,
    });
    expect(decryptConnectionCredentials(rows[0].encrypted_credentials, key, rows[0].id)).toEqual({
      accessToken: 'shpat_old_77',
    });
    expect([rows[0].access_token_expires_at, rows[0].refresh_token_expires_at]).toEqual([
      null,
      null,
    ]);
  });

  it('refuses another account, even an admin of the same org, and burns the state', async () => {
    const { orgId, h } = await createOrg('Wrong Account Org');
    const admin = await addMember(orgId, 'admin');
    const stranger = { authorization: `Bearer ${await t.signToken({ sub: randomUUID() })}` };
    for (const other of [admin, stranger]) {
      const state = await startInstall(orgId, h);
      fake.reset();
      const res = await callbackAs(authOnly(other), rawSigned(state));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ redirectTo: failed('wrong_account') });
      expect(exchangeRequests()).toEqual([]);
      // The right user cannot finish it afterwards: the link is single use.
      expect((await callbackAs(authOnly(h), rawSigned(state))).body).toEqual({
        redirectTo: failed('state_expired'),
      });
    }
    expect(await connectionCount(orgId)).toBe(0);
  });

  it('refuses a starter who is no longer an owner or admin of the org', async () => {
    const { orgId, user, h } = await createOrg('Demoted Org');
    const state = await startInstall(orgId, h);
    fake.reset();
    await owner.query(`update org_members set role = 'viewer' where org_id = $1 and user_id = $2`, [
      orgId,
      user,
    ]);
    expect((await callbackAs(authOnly(h), rawSigned(state))).body).toEqual({
      redirectTo: failed('not_allowed'),
    });
    expect((await callbackAs(authOnly(h), rawSigned(state))).body).toEqual({
      redirectTo: failed('state_expired'),
    });

    const second = await createOrg('Removed Org');
    const admin = await addMember(second.orgId, 'admin');
    const adminState = await startInstall(second.orgId, admin);
    await owner.query(`delete from org_members where org_id = $1 and role = 'admin'`, [
      second.orgId,
    ]);
    expect((await callbackAs(authOnly(admin), rawSigned(adminState))).body).toEqual({
      redirectTo: failed('not_allowed'),
    });
    expect(await connectionCount(orgId)).toBe(0);
    expect(await connectionCount(second.orgId)).toBe(0);
    expect(exchangeRequests()).toEqual([]);
  });

  it('also refuses a starter who was demoted to analyst', async () => {
    const { orgId, user, h } = await createOrg('Analyst Demoted Org');
    const state = await startInstall(orgId, h);
    fake.reset();
    await owner.query(
      `update org_members set role = 'analyst' where org_id = $1 and user_id = $2`,
      [orgId, user],
    );
    expect((await callbackAs(authOnly(h), rawSigned(state))).body).toEqual({
      redirectTo: failed('not_allowed'),
    });
    expect(exchangeRequests()).toEqual([]);
    expect(await connectionCount(orgId)).toBe(0);
  });

  it('checks the user and the role before the shop (a mismatched shop never hides them)', async () => {
    const { orgId, user, h } = await createOrg('Order Org');
    const stranger = { authorization: `Bearer ${await t.signToken({ sub: randomUUID() })}` };
    const wrongUser = await startInstall(orgId, h);
    fake.reset();
    expect(
      (await callbackAs(authOnly(stranger), rawSigned(wrongUser, 'other-shop.myshopify.com'))).body,
    ).toEqual({ redirectTo: failed('wrong_account') });
    const demoted = await startInstall(orgId, h);
    await owner.query(`update org_members set role = 'viewer' where org_id = $1 and user_id = $2`, [
      orgId,
      user,
    ]);
    expect(
      (await callbackAs(authOnly(h), rawSigned(demoted, 'other-shop.myshopify.com'))).body,
    ).toEqual({ redirectTo: failed('not_allowed') });
    expect(exchangeRequests()).toEqual([]);
  });

  it('answers 401 when signed out or with an invalid token', async () => {
    const { orgId, h } = await createOrg('Signed Out Org');
    const state = await startInstall(orgId, h);
    const signedOut = await request(server())
      .post('/connections/shopify/callback')
      .send({ query: rawSigned(state) });
    expect(signedOut.status).toBe(401);
    const badToken = await callbackAs({ authorization: 'Bearer not-a-jwt' }, rawSigned(state));
    expect(badToken.status).toBe(401);
    expect(await connectionCount(orgId)).toBe(0);
  });

  it.each([
    [
      'a tampered value',
      (s: string) => rawSigned(s).replace('code=good-code', 'code=other'),
      'invalid_request',
    ],
    [
      'a missing hmac',
      (s: string) => rawSigned(s).replace(/&hmac=[0-9a-f]+$/, ''),
      'invalid_request',
    ],
    [
      'a repeated key',
      (s: string) =>
        signRawPairs(
          [
            'code=good-code',
            `shop=${SHOP}`,
            `state=${encodeURIComponent(s)}`,
            `timestamp=${nowTs()}`,
            'shop=other-shop.myshopify.com',
          ],
          'test-secret',
        ),
      'invalid_request',
    ],
    ['an invalid shop', (s: string) => rawSigned(s, 'evil.com'), 'invalid_request'],
    [
      'a stale timestamp',
      (s: string) => rawSigned(s, SHOP, { timestamp: '1000' }),
      'invalid_request',
    ],
    ['a state that was never issued', () => rawSigned('made-up'), 'state_expired'],
    [
      'a state minted for another shop',
      (s: string) => rawSigned(s, 'other-shop.myshopify.com'),
      'shop_mismatch',
    ],
    [
      'a rejected authorization code',
      (s: string) => rawSigned(s, SHOP, { code: 'bad-code' }),
      'exchange_failed',
    ],
  ])('rejects %s without creating a connection', async (_label, build, code) => {
    const { orgId, h } = await createOrg(`Reject ${code} ${randomUUID().slice(0, 4)}`);
    const state = await startInstall(orgId, h);
    const res = await callbackAs(authOnly(h), build(state));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ redirectTo: failed(code) });
    expect(await connectionCount(orgId)).toBe(0);
  });

  it('rejects a malformed body with 400 validation_failed', async () => {
    const { orgId, h } = await createOrg('Malformed Org');
    for (const body of [{}, { query: '' }, { query: 42 }, { query: 'a'.repeat(4097) }]) {
      const res = await request(server())
        .post('/connections/shopify/callback')
        .set(authOnly(h))
        .send(body);
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
    }
    expect(await connectionCount(orgId)).toBe(0);
  });

  it('cannot be replayed and rejects an expired state', async () => {
    const { orgId, h } = await createOrg('Replay Org');
    const state = await startInstall(orgId, h);
    expect((await callbackAs(authOnly(h), rawSigned(state))).body).toEqual({
      redirectTo: connected,
    });
    expect((await callbackAs(authOnly(h), rawSigned(state))).body).toEqual({
      redirectTo: failed('state_expired'),
    });
    const old = await startInstall(orgId, h);
    await owner.query(
      `update oauth_states set expires_at = now() - interval '1 minute' where org_id = $1`,
      [orgId],
    );
    expect((await callbackAs(authOnly(h), rawSigned(old))).body).toEqual({
      redirectTo: failed('state_expired'),
    });
  });

  it('consumes the state even when the shop does not match', async () => {
    const { orgId, h } = await createOrg('Mismatch Org');
    const state = await startInstall(orgId, h);
    fake.reset();
    const res = await callbackAs(authOnly(h), rawSigned(state, 'other-shop.myshopify.com'));
    expect(res.body).toEqual({ redirectTo: failed('shop_mismatch') });
    expect(exchangeRequests()).toEqual([]);
    expect((await callbackAs(authOnly(h), rawSigned(state))).body).toEqual({
      redirectTo: failed('state_expired'),
    });
    expect(await connectionCount(orgId)).toBe(0);
  });

  it('a reconnect updates the same row and resets an error state', async () => {
    const { orgId, h } = await createOrg('Reconnect Org');
    await callbackAs(authOnly(h), rawSigned(await startInstall(orgId, h)));
    const first = await owner.query(`select id from store_connections where org_id = $1`, [orgId]);
    await owner.query(
      `update store_connections set status = 'error', last_error = 'x' where org_id = $1`,
      [orgId],
    );
    const res = await callbackAs(authOnly(h), rawSigned(await startInstall(orgId, h)));
    expect(res.body).toEqual({ redirectTo: connected });
    const { rows } = await owner.query(
      `select id, status, last_error from store_connections where org_id = $1`,
      [orgId],
    );
    expect(rows).toEqual([{ id: first.rows[0].id, status: 'active', last_error: null }]);
  });

  it('refuses a shop that is actively connected to a different org', async () => {
    const one = await createOrg('Shop Owner One');
    await callbackAs(authOnly(one.h), rawSigned(await startInstall(one.orgId, one.h)));
    const two = await createOrg('Shop Owner Two');
    const twoState = await startInstall(two.orgId, two.h);
    fake.reset();
    const res = await callbackAs(authOnly(two.h), rawSigned(twoState));
    expect(res.body).toEqual({ redirectTo: failed('shop_in_use') });
    expect(exchangeRequests()).toEqual([]);
    expect(await connectionCount(two.orgId)).toBe(0);
  });

  it('maps the unique index violation to shop_in_use when the pre-check misses', async () => {
    const one = await createOrg('Index Owner One');
    await callbackAs(authOnly(one.h), rawSigned(await startInstall(one.orgId, one.h)));
    const two = await createOrg('Index Owner Two');
    const state = await startInstall(two.orgId, two.h);
    // Simulate the race window: the fast pre-check sees nothing, so only the database index can refuse.
    const api = t.app.get<ConnectionsApi>(CONNECTIONS_API);
    const spy = vi.spyOn(api, 'findStoreConnection').mockResolvedValueOnce(null);
    try {
      const res = await callbackAs(authOnly(two.h), rawSigned(state));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(res.body).toEqual({ redirectTo: failed('shop_in_use') });
    } finally {
      spy.mockRestore();
    }
    expect(await connectionCount(two.orgId)).toBe(0);
  });

  it.each([
    ['a generic database error', new Error('connection reset')],
    [
      'a unique violation on a different constraint',
      Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'store_connections_org_platform_acct_uq',
      }),
    ],
  ])('answers server_error, not shop_in_use, for %s', async (_label, failure) => {
    const { orgId, h } = await createOrg(`Server Error Org ${randomUUID().slice(0, 4)}`);
    const state = await startInstall(orgId, h);
    const db = t.app.get<{ withTenant: (...args: unknown[]) => Promise<unknown> }>(TENANT_DB);
    const original = db.withTenant.bind(db);
    let calls = 0;
    // The first withTenant call is the role check; the second is the connection upsert, which fails.
    const spy = vi.spyOn(db, 'withTenant').mockImplementation((...args: unknown[]) => {
      if (++calls === 2) return Promise.reject(failure);
      return original(...args);
    });
    try {
      const res = await callbackAs(authOnly(h), rawSigned(state));
      expect(res.body).toEqual({ redirectTo: failed('server_error') });
    } finally {
      spy.mockRestore();
    }
    expect(await connectionCount(orgId)).toBe(0);
  });

  it('lets exactly one of two orgs win a concurrent connect of the same new shop', async () => {
    const shop = `race-${randomUUID().slice(0, 8)}.myshopify.com`;
    const one = await createOrg('Race One');
    const two = await createOrg('Race Two');
    const s1 = await startInstall(one.orgId, one.h, shop);
    const s2 = await startInstall(two.orgId, two.h, shop);
    const results = await Promise.all([
      callbackAs(authOnly(one.h), rawSigned(s1, shop)),
      callbackAs(authOnly(two.h), rawSigned(s2, shop)),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.map((r) => r.body.redirectTo as string).sort()).toEqual(
      [connected, failed('shop_in_use')].sort(),
    );
    const { rows } = await owner.query(
      `select org_id from store_connections where external_account_id = $1 and status <> 'disconnected'`,
      [shop],
    );
    expect(rows).toHaveLength(1);
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
    const res = await callbackAs(authOnly(h), rawSigned(state));
    expect(res.body).toEqual({
      redirectTo: `${WEB}/connections?shopify=connected&warning=webhooks`,
    });
    const { rows } = await owner.query(
      `select status, last_error from store_connections where org_id = $1`,
      [orgId],
    );
    expect(rows[0]).toMatchObject({
      status: 'active',
      last_error: 'Webhook setup failed. Reconnect to retry.',
    });
  });

  it('no longer serves the old public GET route', async () => {
    const { orgId, h } = await createOrg('Old Route Org');
    const state = await startInstall(orgId, h);
    const res = await request(server()).get(`/connections/shopify/callback?${rawSigned(state)}`);
    expect(res.status).toBe(404);
    expect(await connectionCount(orgId)).toBe(0);
  });
});

describe('first backfill after connect', () => {
  const BF_SHOP = 'backfill-shop.myshopify.com';
  const MINUTE = 60_000;
  const DAY = 86_400_000;
  beforeEach(async () => {
    fake.reset();
    syncQueue.reset();
    await owner.query(
      `update store_connections set status = 'disconnected' where external_account_id = $1`,
      [BF_SHOP],
    );
  });
  const connect = async (orgId: string, h: Record<string, string>) =>
    callbackAs(authOnly(h), rawSigned(await startInstall(orgId, h, BF_SHOP), BF_SHOP));
  const daysBack = (iso: string) => (Date.now() - new Date(iso).getTime()) / DAY;

  it('enqueues one locations job that chains the rest, with a 60 day window without read_all_orders', async () => {
    const { orgId, h } = await createOrg('Backfill Org');
    const res = await connect(orgId, h);
    expect(res.body).toEqual({ redirectTo: connected });
    expect(syncQueue.jobs).toHaveLength(1);
    const job = syncQueue.jobs[0]!;
    expect(job).toMatchObject({
      orgId,
      resource: 'locations',
      then: { resources: ['products', 'inventory', 'orders'], mode: 'backfill' },
    });
    const since = new Date(job.then!.since!).getTime();
    const expected = Date.now() - ORDERS_HISTORY_DAYS.limited * DAY;
    expect(Math.abs(since - expected)).toBeLessThan(MINUTE);
    const runs = await owner.query(
      `select r.status, r.type from sync_runs r where r.org_id = $1 and r.id = $2`,
      [orgId, job.syncRunId],
    );
    expect(runs.rows).toEqual([{ status: 'running', type: 'backfill' }]);
    const cursors = await owner.query(
      `select resource, status from sync_cursors where org_id = $1`,
      [orgId],
    );
    expect(cursors.rows).toEqual([{ resource: 'locations', status: 'running' }]);
    expect(
      (await owner.query(`select last_error from store_connections where org_id = $1`, [orgId]))
        .rows,
    ).toEqual([{ last_error: null }]);
  });

  it('reaches back 365 days when read_all_orders was granted', async () => {
    const { orgId, h } = await createOrg('Backfill Full Org');
    fake.respondNext({
      status: 200,
      body: JSON.stringify({ access_token: 'shpat_x', scope: 'read_orders,read_all_orders' }),
    });
    await connect(orgId, h);
    expect(syncQueue.jobs).toHaveLength(1);
    expect(syncQueue.jobs[0]!.then).toMatchObject({
      mode: 'backfill',
      resources: ['products', 'inventory', 'orders'],
    });
    expect(daysBack(syncQueue.jobs[0]!.then!.since!)).toBeGreaterThan(364.9);
    expect(daysBack(syncQueue.jobs[0]!.then!.since!)).toBeLessThan(365.1);
  });

  it('keeps the connection and records a retry hint when the queue is down', async () => {
    const { orgId, h } = await createOrg('Backfill Down Org');
    syncQueue.fail = true;
    const res = await connect(orgId, h);
    expect(res.body).toEqual({ redirectTo: connected });
    const { rows } = await owner.query(
      `select status, last_error from store_connections where org_id = $1`,
      [orgId],
    );
    expect(rows).toEqual([
      { status: 'active', last_error: 'Could not start the first import. Use Sync now.' },
    ]);
    // The half-started run is released, so Sync now (or a reconnect) can start again.
    const runs = await owner.query(`select status from sync_runs where org_id = $1`, [orgId]);
    expect(runs.rows).toEqual([{ status: 'failed' }]);
    const cursors = await owner.query(
      `select status, current_sync_run_id from sync_cursors where org_id = $1`,
      [orgId],
    );
    expect(cursors.rows).toEqual([{ status: 'failed', current_sync_run_id: null }]);
    syncQueue.fail = false;
    const retry = await connect(orgId, h);
    expect(retry.body).toEqual({ redirectTo: connected });
    expect(syncQueue.jobs).toHaveLength(1);
  });

  it('stores the webhook warning, not the import one, when both fail (a reconnect fixes both)', async () => {
    const { orgId, h } = await createOrg('Backfill Both Down Org');
    syncQueue.fail = true;
    fake.respondNext({
      status: 200,
      body: JSON.stringify({ access_token: 'shpat_x', scope: 'read_orders' }),
    });
    fake.failNext(500);
    const res = await connect(orgId, h);
    expect(res.body).toEqual({
      redirectTo: `${WEB}/connections?shopify=connected&warning=webhooks`,
    });
    const { rows } = await owner.query(
      `select status, last_error from store_connections where org_id = $1`,
      [orgId],
    );
    expect(rows).toEqual([
      { status: 'active', last_error: 'Webhook setup failed. Reconnect to retry.' },
    ]);
    syncQueue.fail = false;
  });

  it('uses the shared import-not-started text that the sync engine clears', () => {
    expect(IMPORT_NOT_STARTED_MESSAGE).toBe('Could not start the first import. Use Sync now.');
  });

  it('answers the callback even when the queue never responds', async () => {
    const { orgId, h } = await createOrg('Backfill Hang Org');
    const hang = syncQueue.enqueue.bind(syncQueue);
    syncQueue.enqueue = () => new Promise<void>(() => undefined);
    const before = syncStartTimeout.ms;
    syncStartTimeout.ms = 50;
    try {
      const res = await connect(orgId, h);
      expect(res.body).toEqual({ redirectTo: connected });
    } finally {
      syncStartTimeout.ms = before;
      syncQueue.enqueue = hang;
    }
    const { rows } = await owner.query(
      `select status, last_error from store_connections where org_id = $1`,
      [orgId],
    );
    expect(rows).toEqual([
      { status: 'active', last_error: 'Could not start the first import. Use Sync now.' },
    ]);
  });

  it('warns at boot only when production has no sync queue', () => {
    const warn = vi.fn();
    const logger = { warn } as never;
    warnIfNoSyncQueue(new NoopSyncQueue(), { NODE_ENV: 'development' } as never, logger);
    warnIfNoSyncQueue(syncQueue, { NODE_ENV: 'production' } as never, logger);
    expect(warn).not.toHaveBeenCalled();
    warnIfNoSyncQueue(new NoopSyncQueue(), { NODE_ENV: 'production' } as never, logger);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does nothing and stores no error when no queue is configured', async () => {
    const { orgId, h } = await createOrg('Backfill Noop Org');
    syncQueue.available = false;
    const res = await connect(orgId, h);
    expect(res.body).toEqual({ redirectTo: connected });
    expect(syncQueue.jobs).toEqual([]);
    expect((await owner.query(`select 1 from sync_runs where org_id = $1`, [orgId])).rowCount).toBe(
      0,
    );
    expect(
      (await owner.query(`select last_error from store_connections where org_id = $1`, [orgId]))
        .rows,
    ).toEqual([{ last_error: null }]);
  });

  it('does not start a second chain when reconnecting while the first is running', async () => {
    const { orgId, h } = await createOrg('Backfill Reconnect Org');
    await connect(orgId, h);
    expect(syncQueue.jobs).toHaveLength(1);
    const again = await connect(orgId, h);
    expect(again.body).toEqual({ redirectTo: connected });
    expect(syncQueue.jobs).toHaveLength(1);
    expect((await owner.query(`select 1 from sync_runs where org_id = $1`, [orgId])).rowCount).toBe(
      1,
    );
  });

  it('never puts a token, credentials or the callback query in a job', async () => {
    const { orgId, h } = await createOrg('Backfill Secrets Org');
    const state = await startInstall(orgId, h, BF_SHOP);
    const query = rawSigned(state, BF_SHOP, { code: 'code-9f3a1c' });
    fake.respondNext({
      status: 200,
      body: JSON.stringify({ access_token: 'shpat_unique_77aa', scope: 'read_orders' }),
    });
    await callbackAs(authOnly(h), query);
    expect(syncQueue.jobs).toHaveLength(1);
    const payload = JSON.stringify(syncQueue.jobs[0]);
    for (const secret of ['shpat_unique_77aa', 'code-9f3a1c', state, 'test-secret', 'hmac']) {
      expect(payload).not.toContain(secret);
    }
  });
});

describe('sync summary', () => {
  beforeEach(() => syncQueue.reset());
  const RESOURCES = ['locations', 'products', 'inventory', 'orders'] as const;
  async function conn(
    orgId: string,
    over: { status?: string; scopes?: string[]; shop?: string } = {},
  ) {
    const { rows } = await owner.query(
      `insert into store_connections (org_id, platform, external_account_id, status, scopes, encrypted_credentials)
       values ($1, 'shopify', $2, $3, $4, 'ciphertext-secret') returning id`,
      [
        orgId,
        over.shop ?? `s-${randomUUID().slice(0, 8)}.myshopify.com`,
        over.status ?? 'active',
        over.scopes ?? ['read_orders'],
      ],
    );
    return rows[0].id as string;
  }
  const cursor = (
    orgId: string,
    id: string,
    resource: string,
    status: string,
    extra: { records?: number; error?: string; synced?: boolean } = {},
  ) =>
    owner.query(
      `insert into sync_cursors (org_id, store_connection_id, resource, status, records_processed, last_error, last_synced_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        orgId,
        id,
        resource,
        status,
        extra.records ?? 0,
        extra.error ?? null,
        extra.synced ? new Date() : null,
      ],
    );
  const summary = async (orgId: string, h: Record<string, string>, id: string) => {
    const res = await request(server()).get(`/orgs/${orgId}/connections`).set(h);
    expect(res.status).toBe(200);
    return (res.body as { id: string; sync: Record<string, unknown> }[]).find((c) => c.id === id)!
      .sync;
  };

  it('is never with no cursors, and reads historyLimited from the stored scopes', async () => {
    const { orgId, h } = await createOrg('Sum Never');
    const a = await conn(orgId, { scopes: ['read_orders'] });
    const b = await conn(orgId, { scopes: ['read_orders', 'read_all_orders'] });
    expect(await summary(orgId, h, a)).toEqual({
      state: 'never',
      resource: null,
      recordsProcessed: 0,
      coveredFrom: null,
      historyLimited: true,
      error: null,
      canStart: true,
      resources: [
        { resource: 'locations', state: 'never', lastCompletedAt: null, error: null },
        { resource: 'products', state: 'never', lastCompletedAt: null, error: null },
        { resource: 'inventory', state: 'never', lastCompletedAt: null, error: null },
        { resource: 'orders', state: 'never', lastCompletedAt: null, error: null },
      ],
      unlinkedLines: 0,
    });
    expect(await summary(orgId, h, b)).toMatchObject({ historyLimited: false });
  });

  it('shows the first running resource with its progress', async () => {
    const { orgId, h } = await createOrg('Sum Running');
    const id = await conn(orgId);
    await cursor(orgId, id, 'products', 'complete', { synced: true });
    await cursor(orgId, id, 'orders', 'running', { records: 1200 });
    await cursor(orgId, id, 'inventory', 'failed', { error: 'ignored while running' });
    expect(await summary(orgId, h, id)).toMatchObject({
      state: 'running',
      resource: 'orders',
      recordsProcessed: 1200,
      error: null,
    });
  });

  it('shows a failed resource with its stored sanitized error', async () => {
    const { orgId, h } = await createOrg('Sum Failed');
    const id = await conn(orgId);
    await cursor(orgId, id, 'locations', 'complete', { synced: true });
    await cursor(orgId, id, 'products', 'failed', { error: 'Shopify said no', records: 7 });
    expect(await summary(orgId, h, id)).toMatchObject({
      state: 'failed',
      resource: 'products',
      error: 'Shopify said no',
    });
  });

  it('is idle only when all four resources are complete; three of four is still never', async () => {
    const { orgId, h } = await createOrg('Sum Idle');
    const id = await conn(orgId);
    for (const r of RESOURCES.slice(0, 3)) await cursor(orgId, id, r, 'complete', { synced: true });
    expect(await summary(orgId, h, id)).toMatchObject({ state: 'never' });
    await cursor(orgId, id, 'orders', 'complete', { synced: true });
    expect(await summary(orgId, h, id)).toMatchObject({ state: 'idle', resource: null });
  });

  it('coveredFrom is the oldest placed_at of that connection only', async () => {
    const { orgId, h } = await createOrg('Sum Covered');
    const id = await conn(orgId);
    const other = await conn(orgId);
    const ins = (cid: string, ext: string, at: string) =>
      owner.query(
        `insert into orders (org_id, store_connection_id, external_order_id, channel, status, placed_at, currency,
           gross_cents, discount_cents, shipping_charged_cents, tax_cents, refund_cents, net_cents, external_updated_at)
         values ($1, $2, $3, 'shopify_online', 'open', $4, 'USD', 100, 0, 0, 0, 0, 100, now())`,
        [orgId, cid, ext, at],
      );
    await ins(id, 'o1', '2026-03-05T10:00:00Z');
    await ins(id, 'o2', '2026-02-01T08:30:00Z');
    await ins(other, 'o3', '2025-01-01T00:00:00Z');
    expect(await summary(orgId, h, id)).toMatchObject({ coveredFrom: '2026-02-01T08:30:00.000Z' });
    expect(await summary(orgId, h, other)).toMatchObject({
      coveredFrom: '2025-01-01T00:00:00.000Z',
    });
    // A test order (Shopify's test checkout) is not real history: it never widens coveredFrom.
    await ins(id, 'o-test', '2024-06-01T00:00:00Z');
    await owner.query(`update orders set is_test = true where external_order_id = 'o-test'`);
    expect(await summary(orgId, h, id)).toMatchObject({ coveredFrom: '2026-02-01T08:30:00.000Z' });
    const onlyTest = await conn(orgId);
    await ins(onlyTest, 'o-test-2', '2024-06-01T00:00:00Z');
    await owner.query(`update orders set is_test = true where external_order_id = 'o-test-2'`);
    expect(await summary(orgId, h, onlyTest)).toMatchObject({ coveredFrom: null });
  });

  it('canStart is false for unusable connections and when no queue is configured', async () => {
    const { orgId, h } = await createOrg('Sum CanStart');
    const dis = await conn(orgId, { status: 'disconnected' });
    const err = await conn(orgId, { status: 'error' });
    expect(await summary(orgId, h, dis)).toMatchObject({ canStart: false });
    expect(await summary(orgId, h, err)).toMatchObject({ canStart: true });
    syncQueue.available = false;
    expect(await summary(orgId, h, err)).toMatchObject({ canStart: false });
  });

  it('never leaks another org summary, credentials or ciphertext', async () => {
    const a = await createOrg('Sum Iso A');
    const b = await createOrg('Sum Iso B');
    const id = await conn(a.orgId);
    await cursor(a.orgId, id, 'orders', 'running', { records: 5 });
    const res = await request(server()).get(`/orgs/${b.orgId}/connections`).set(b.h);
    expect(res.body).toEqual([]);
    const own = await request(server()).get(`/orgs/${a.orgId}/connections`).set(a.h);
    expect(JSON.stringify(own.body)).not.toMatch(/ciphertext|secret|credential|token/i);
  });

  it('uses a bounded number of tenant transactions however many connections exist', async () => {
    const { orgId, h } = await createOrg('Sum Bounded');
    for (let i = 0; i < 6; i++) {
      const id = await conn(orgId);
      await cursor(orgId, id, 'orders', 'complete', { synced: true });
    }
    const db = t.app.get(TENANT_DB) as { withTenant: (...a: never[]) => unknown };
    const calls = vi.fn();
    const orig = db.withTenant.bind(db);
    db.withTenant = ((...a: never[]) => {
      calls();
      return orig(...a);
    }) as never;
    try {
      const res = await request(server()).get(`/orgs/${orgId}/connections`).set(h);
      expect(res.body).toHaveLength(6);
      expect(calls.mock.calls.length).toBeLessThanOrEqual(2); // never one per connection
    } finally {
      db.withTenant = orig as never;
    }
  });
});

describe('sync now', () => {
  beforeEach(() => syncQueue.reset());
  async function conn(orgId: string, status = 'active') {
    const { rows } = await owner.query(
      `insert into store_connections (org_id, platform, external_account_id, status, scopes)
       values ($1, 'shopify', $2, $3, array['read_orders']) returning id`,
      [orgId, `n-${randomUUID().slice(0, 8)}.myshopify.com`, status],
    );
    return rows[0].id as string;
  }
  const post = (orgId: string, id: string, h: Record<string, string>) =>
    request(server()).post(`/orgs/${orgId}/connections/${id}/sync`).set(h);
  const audit = (orgId: string, id: string) =>
    owner.query(
      `select actor_user_id, after_json from audit_log where org_id = $1 and entity_id = $2 and action = 'connection.sync_requested'`,
      [orgId, id],
    );

  it('starts a backfill on a never-synced connection, audits it, and refuses a duplicate while running', async () => {
    const { orgId, user, h } = await createOrg('Sync Backfill');
    const id = await conn(orgId);
    const res = await post(orgId, id, h);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ started: true });
    expect(syncQueue.jobs).toHaveLength(1);
    expect(syncQueue.jobs[0]).toMatchObject({
      orgId,
      resource: 'locations',
      then: { resources: ['products', 'inventory', 'orders'], mode: 'backfill' },
    });
    expect(syncQueue.jobs[0]!.then!.since).toBeTruthy();
    expect((await audit(orgId, id)).rows).toEqual([
      { actor_user_id: user, after_json: { mode: 'backfill' } },
    ]);
    const again = await post(orgId, id, h);
    expect(again.status).toBe(201);
    expect(again.body).toEqual({ started: false });
    expect(syncQueue.jobs).toHaveLength(1);
  });

  it('runs incremental (no since) once all four resources have completed', async () => {
    const { orgId, user, h } = await createOrg('Sync Incremental');
    const id = await conn(orgId);
    for (const r of ['locations', 'products', 'inventory', 'orders']) {
      await owner.query(
        `insert into sync_cursors (org_id, store_connection_id, resource, status, last_synced_at)
         values ($1, $2, $3, 'complete', now())`,
        [orgId, id, r],
      );
    }
    const res = await post(orgId, id, h);
    expect(res.body).toEqual({ started: true });
    expect(syncQueue.jobs).toHaveLength(1);
    expect(syncQueue.jobs[0]!.then).toMatchObject({ mode: 'incremental' });
    expect(syncQueue.jobs[0]!.then!.since ?? null).toBeNull();
    expect((await audit(orgId, id)).rows).toEqual([
      { actor_user_id: user, after_json: { mode: 'incremental' } },
    ]);
  });

  it('can recover an error-status connection', async () => {
    const { orgId, h } = await createOrg('Sync Recover');
    const id = await conn(orgId, 'error');
    expect((await post(orgId, id, h)).body).toEqual({ started: true });
  });

  it('is admin only: viewers and analysts get 403 and nothing starts', async () => {
    const { orgId } = await createOrg('Sync Roles');
    const id = await conn(orgId);
    for (const role of ['viewer', 'analyst'] as const) {
      const res = await post(orgId, id, await addMember(orgId, role));
      expect(res.status).toBe(403);
    }
    expect(syncQueue.jobs).toHaveLength(0);
    expect((await audit(orgId, id)).rowCount).toBe(0);
  });

  it('answers 404 for unknown ids and other orgs, 400 for malformed ids, and starts nothing', async () => {
    const a = await createOrg('Sync Own');
    const b = await createOrg('Sync Other');
    const foreign = await conn(b.orgId);
    const unknown = await post(a.orgId, randomUUID(), a.h);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('connection_not_found');
    expect((await post(a.orgId, foreign, a.h)).status).toBe(404);
    expect((await post(a.orgId, 'not-a-uuid', a.h)).status).toBe(400);
    expect(syncQueue.jobs).toHaveLength(0);
  });

  it('answers 409 connection_not_active for disconnected, pending and demo connections', async () => {
    const { orgId, h } = await createOrg('Sync Inactive');
    for (const status of ['disconnected', 'pending', 'demo']) {
      const res = await post(orgId, await conn(orgId, status), h);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({
        code: 'connection_not_active',
        message: 'Reconnect this store first.',
      });
    }
    expect(syncQueue.jobs).toHaveLength(0);
  });

  it('answers 503 sync_not_available when no queue is configured', async () => {
    const { orgId, h } = await createOrg('Sync NoQueue');
    const id = await conn(orgId);
    syncQueue.available = false;
    const res = await post(orgId, id, h);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({
      code: 'sync_not_available',
      message: 'Importing is not available on this server yet.',
    });
    expect((await audit(orgId, id)).rowCount).toBe(0);
  });

  it('does not start a second chain while any resource is still running', async () => {
    const { orgId, h } = await createOrg('Sync PastLocations');
    const id = await conn(orgId);
    await owner.query(
      `insert into sync_cursors (org_id, store_connection_id, resource, status, last_synced_at)
       values ($1, $2, 'locations', 'complete', now()), ($1, $2, 'orders', 'running', null)`,
      [orgId, id],
    );
    const res = await post(orgId, id, h);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ started: false });
    expect(syncQueue.jobs).toHaveLength(0);
    expect((await audit(orgId, id)).rowCount).toBe(0);
    const list = await request(server()).get(`/orgs/${orgId}/connections`).set(h);
    expect(list.body[0].sync).toMatchObject({ state: 'running', canStart: false });
  });

  it('leaves no running cursor when the queue fails, and a retry then works', async () => {
    const { orgId, h } = await createOrg('Sync QueueDown');
    const id = await conn(orgId);
    syncQueue.fail = true;
    const res = await post(orgId, id, h);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: {
        code: 'sync_not_available',
        message: 'Could not start the sync. Try again in a moment.',
      },
    });
    const runs = await owner.query(`select status from sync_runs where org_id = $1`, [orgId]);
    expect(runs.rows).toEqual([{ status: 'failed' }]);
    const cursors = await owner.query(`select status from sync_cursors where org_id = $1`, [orgId]);
    expect(cursors.rows.every((r) => r.status !== 'running')).toBe(true);
    syncQueue.fail = false;
    expect((await post(orgId, id, h)).body).toEqual({ started: true });
  });
});

describe('per-resource sync status', () => {
  async function connection(orgId: string, shop: string, lastSyncedAt: string | null = null) {
    const { rows } = await owner.query(
      `insert into store_connections (org_id, platform, external_account_id, status, encrypted_credentials, last_synced_at)
       values ($1, 'shopify', $2, 'active', 'ciphertext', $3) returning id`,
      [orgId, shop, lastSyncedAt],
    );
    return rows[0].id as string;
  }
  const cursor = (
    org: string,
    conn: string,
    resource: string,
    status: string,
    syncedAt: string | null,
    error: string | null = null,
  ) =>
    owner.query(
      `insert into sync_cursors (org_id, store_connection_id, resource, status, last_synced_at, last_error) values ($1, $2, $3, $4, $5, $6)`,
      [org, conn, resource, status, syncedAt, error],
    );
  const first = async (orgId: string, h: Record<string, string>) =>
    (await request(server()).get(`/orgs/${orgId}/connections`).set(h)).body[0];
  async function lineOn(
    org: string,
    conn: string,
    ext: string,
    opts: { variant: string | null; test?: boolean; sku?: string | null },
  ) {
    const { rows } = await owner.query(
      `insert into orders (org_id, store_connection_id, external_order_id, channel, status, placed_at, currency, gross_cents,
         discount_cents, shipping_charged_cents, tax_cents, refund_cents, net_cents, is_test, external_updated_at)
       values ($1, $2, $3, 'shopify_online', 'closed', now(), 'USD', 0, 0, 0, 0, 0, 0, $4, now()) returning id`,
      [org, conn, ext, opts.test ?? false],
    );
    await owner.query(
      `insert into order_lines (org_id, order_id, sku_id, external_line_id, external_variant_id, title, quantity, unit_price_cents)
       values ($1, $2, $3, 'l-1', $4, 'Line', 1, 100)`,
      [org, rows[0].id, opts.sku ?? null, opts.variant],
    );
  }

  it('reports each resource with its own state, completion time and error, in import order', async () => {
    const { orgId, h } = await createOrg('Resources Org');
    const id = await connection(orgId, 'res1.myshopify.com');
    await cursor(orgId, id, 'locations', 'complete', '2026-10-08T12:00:00.000Z');
    await cursor(orgId, id, 'products', 'running', '2026-10-08T11:30:00.000Z');
    await cursor(
      orgId,
      id,
      'inventory',
      'failed',
      '2026-10-08T11:00:00.000Z',
      'Shopify rate limit hit.',
    );
    const body = await first(orgId, h);
    expect(body.sync.resources).toEqual([
      {
        resource: 'locations',
        state: 'idle',
        lastCompletedAt: '2026-10-08T12:00:00.000Z',
        error: null,
      },
      {
        resource: 'products',
        state: 'running',
        lastCompletedAt: '2026-10-08T11:30:00.000Z',
        error: null,
      },
      {
        resource: 'inventory',
        state: 'failed',
        lastCompletedAt: '2026-10-08T11:00:00.000Z',
        error: 'Shopify rate limit hit.',
      },
      { resource: 'orders', state: 'never', lastCompletedAt: null, error: null },
    ]);
    // the aggregate fields keep their meaning
    expect(body.sync).toMatchObject({ state: 'running', resource: 'products' });
  });
  it('a cursor row that never completed reads never, even when it exists', async () => {
    const { orgId, h } = await createOrg('Never Org');
    const id = await connection(orgId, 'res2.myshopify.com');
    await cursor(orgId, id, 'orders', 'idle', null);
    const body = await first(orgId, h);
    expect(body.sync.resources.find((r: { resource: string }) => r.resource === 'orders')).toEqual({
      resource: 'orders',
      state: 'never',
      lastCompletedAt: null,
      error: null,
    });
  });
  it('leaves the connection time as the stored column (the oldest resource, never "now")', async () => {
    const { orgId, h } = await createOrg('Column Org');
    await connection(orgId, 'res3.myshopify.com', '2026-10-08T10:00:00.000Z');
    expect((await first(orgId, h)).lastSyncedAt).toBe('2026-10-08T10:00:00.000Z');
  });
  it('counts only unlinked lines of this connection that carry a variant, never test orders or other orgs', async () => {
    const { orgId, h } = await createOrg('Unlinked Org');
    const id = await connection(orgId, 'res4.myshopify.com');
    const sibling = await connection(orgId, 'res5.myshopify.com');
    await lineOn(orgId, id, 'o-1', { variant: 'v-1' });
    await lineOn(orgId, id, 'o-2', { variant: 'v-2' });
    await lineOn(orgId, id, 'o-3', { variant: null }); // no variant: nothing to link to
    await lineOn(orgId, id, 'o-4', { variant: 'v-4', test: true }); // test orders are not real sales
    await lineOn(orgId, sibling, 'o-5', { variant: 'v-5' }); // another connection
    const other = await createOrg('Other Unlinked Org');
    const otherConn = await connection(other.orgId, 'res6.myshopify.com');
    await lineOn(other.orgId, otherConn, 'o-6', { variant: 'v-6' }); // another org
    const body = (await request(server()).get(`/orgs/${orgId}/connections`).set(h)).body;
    const mine = body.find((c: { id: string }) => c.id === id);
    const theirs = body.find((c: { id: string }) => c.id === sibling);
    expect([mine.sync.unlinkedLines, theirs.sync.unlinkedLines]).toEqual([2, 1]);
    expect(JSON.stringify(body)).not.toContain(other.orgId);
  });
  it('is readable by a viewer and never exposes credentials', async () => {
    const { orgId } = await createOrg('Viewer Resources Org');
    await connection(orgId, 'res7.myshopify.com');
    const viewer = await addMember(orgId, 'viewer');
    const res = await request(server()).get(`/orgs/${orgId}/connections`).set(viewer);
    expect(res.status).toBe(200);
    expect(res.body[0].sync.resources).toHaveLength(4);
    expect(JSON.stringify(res.body)).not.toMatch(/ciphertext|credential|token/i);
  });
});
