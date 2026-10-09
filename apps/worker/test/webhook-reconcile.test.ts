import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encryptConnectionCredentials } from '@erq/connectors';
import { FakeShopify } from '@erq/connectors/testing';
import { createTenantDb, type TenantDb } from '@erq/db';
import { startTestDatabase, type TestDatabase } from '@erq/db/testing';
import { EnvKeyProvider } from '@erq/shared';
import { WEBHOOK_SETUP_FAILED_MESSAGE, createTokenService } from '@erq/sync';
import { createWebhookReconciler } from '../src/webhooks/reconcile';

const ORG = '11111111-1111-4111-8111-111111111111';
const URL_ = 'http://api.test/webhooks/shopify';
const TOPICS = ['app/uninstalled', 'products/update', 'inventory_levels/update'];
let tdb: TestDatabase;
let owner: Pool;
let db: TenantDb;
const keyProvider = new EnvKeyProvider('k1', { k1: randomBytes(32).toString('base64') });

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  db = createTenantDb(tdb.appUrl);
}, 120_000);
afterAll(async () => {
  await db?.close();
  await owner?.end();
  await tdb?.stop();
});
beforeEach(async () => {
  await owner.query(`truncate orgs cascade`);
  await owner.query(`insert into orgs (id, name, slug) values ($1, 'Org', 'org')`, [ORG]);
  await owner.query(
    `insert into store_connections (id, org_id, platform, external_account_id, status, encrypted_credentials) values ($1, $1, 'shopify', 'main.myshopify.com', 'active', $2)`,
    [ORG, encryptConnectionCredentials({ accessToken: 'shpat_reconcile_1' }, keyProvider, ORG)],
  );
});
const reconciler = (http: FakeShopify) =>
  createWebhookReconciler({
    db,
    tokens: createTokenService({ db, keyProvider }),
    http,
    callbackUrl: URL_,
    apiVersion: '2025-07',
  });
const lastError = async () =>
  (await owner.query(`select last_error from store_connections where id = $1`, [ORG])).rows[0]
    .last_error;

describe('createWebhookReconciler', () => {
  it('registers the subscribed topics with the stored token (in a header, never the body) and is idempotent', async () => {
    const http = new FakeShopify();
    await reconciler(http)({ orgId: ORG, connectionId: ORG });
    await reconciler(http)({ orgId: ORG, connectionId: ORG });
    expect([...http.subscriptions.keys()]).toEqual(TOPICS);
    expect(http.requests[0]!.headers?.['X-Shopify-Access-Token']).toBe('shpat_reconcile_1');
    expect(http.requests.map((r) => r.body).join('')).not.toContain('shpat_reconcile_1');
    expect(await lastError()).toBeNull();
  });
  it('records a rejected subscription on the connection, keeps polling, and never overwrites another warning', async () => {
    const rejecting = new FakeShopify({ rejectTopics: new Set(['products/update']) });
    await reconciler(rejecting)({ orgId: ORG, connectionId: ORG });
    expect(await lastError()).toBe(WEBHOOK_SETUP_FAILED_MESSAGE);
    await owner.query(`update store_connections set last_error = 'Something else' where id = $1`, [
      ORG,
    ]);
    await reconciler(rejecting)({ orgId: ORG, connectionId: ORG });
    expect(await lastError()).toBe('Something else');
  });
  it('clears only its own warning once every topic is registered', async () => {
    await owner.query(`update store_connections set last_error = $2 where id = $1`, [
      ORG,
      WEBHOOK_SETUP_FAILED_MESSAGE,
    ]);
    await reconciler(new FakeShopify())({ orgId: ORG, connectionId: ORG });
    expect(await lastError()).toBeNull();
    await owner.query(`update store_connections set last_error = 'Something else' where id = $1`, [
      ORG,
    ]);
    await reconciler(new FakeShopify())({ orgId: ORG, connectionId: ORG });
    expect(await lastError()).toBe('Something else');
  });
  it('does nothing for a connection that is not active or has no credentials', async () => {
    const http = new FakeShopify();
    await owner.query(`update store_connections set status = 'error' where id = $1`, [ORG]);
    await reconciler(http)({ orgId: ORG, connectionId: ORG });
    await owner.query(
      `update store_connections set status = 'active', encrypted_credentials = null where id = $1`,
      [ORG],
    );
    await reconciler(http)({ orgId: ORG, connectionId: ORG });
    expect(http.requests).toEqual([]);
  });
});
