import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConnectionsApi, createTenantDb, type ConnectionsApi, type TenantDb } from '@erq/db';
import { startTestDatabase, type TestDatabase } from '@erq/db/testing';
import { processWebhookEvent } from '../src/webhooks/handler';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333'; // second connection in the same org
let tdb: TestDatabase;
let owner: Pool;
let app: Pool;
let db: TenantDb;
let connections: ConnectionsApi;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  app = new Pool({ connectionString: tdb.appUrl });
  db = createTenantDb(tdb.appUrl);
  connections = createConnectionsApi(app);
});
afterAll(async () => {
  await db?.close();
  await app?.end();
  await owner?.end();
  await tdb?.stop();
});

let seq = 0;
async function reset() {
  await owner.query(`truncate orgs cascade`);
  await owner.query(`insert into orgs (id, name, slug) values ($1, 'Org', 'org')`, [ORG]);
  for (const [id, shop] of [
    [ORG, 'main.myshopify.com'],
    [OTHER, 'other.myshopify.com'],
  ]) {
    await owner.query(
      `insert into store_connections (id, org_id, platform, external_account_id, status, encrypted_credentials) values ($1, $2, 'shopify', $3, 'active', 'ciphertext')`,
      [id, ORG, shop],
    );
  }
}
async function addEvent(
  topic: string,
  opts: { connection?: string; status?: string; ageMinutes?: number } = {},
) {
  const { rows } = await owner.query(
    `insert into webhook_events (org_id, store_connection_id, topic, external_event_id, payload, status, updated_at)
     values ($1, $2, $3, $4, '{"secret":"payload"}', $5, now() - ($6 || ' minutes')::interval) returning id`,
    [
      ORG,
      opts.connection ?? ORG,
      topic,
      `evt-${++seq}`,
      opts.status ?? 'received',
      String(opts.ageMinutes ?? 0),
    ],
  );
  return rows[0].id as string;
}
const status = async (id: string) =>
  (await owner.query(`select status, error from webhook_events where id = $1`, [id])).rows[0];
const deps = () => ({ db, connections });
beforeEach(reset);

describe('processWebhookEvent', () => {
  it('uninstall disconnects the connection, wipes the token, audits, and is not repeated on redelivery', async () => {
    const id = await addEvent('app/uninstalled');
    expect(await processWebhookEvent(deps(), { orgId: ORG, eventId: id })).toBe('processed');
    expect(
      (
        await owner.query(
          `select status, encrypted_credentials from store_connections where id = $1`,
          [ORG],
        )
      ).rows[0],
    ).toEqual({ status: 'disconnected', encrypted_credentials: null });
    expect(
      (
        await owner.query(
          `select actor_user_id from audit_log where org_id = $1 and action = 'connection.uninstalled'`,
          [ORG],
        )
      ).rows,
    ).toEqual([{ actor_user_id: null }]);
    expect((await status(id)).status).toBe('processed');
    expect(await processWebhookEvent(deps(), { orgId: ORG, eventId: id })).toBe('skipped');
    expect(
      (await owner.query(`select 1 from audit_log where action = 'connection.uninstalled'`))
        .rowCount,
    ).toBe(1);
    expect(
      (await owner.query(`select status from store_connections where id = $1`, [OTHER])).rows[0]
        .status,
    ).toBe('active');
  });
  it('defers data topics for 1b-3 and ignores unknown topics', async () => {
    for (const topic of [
      'orders/create',
      'orders/updated',
      'orders/cancelled',
      'refunds/create',
      'products/create',
      'products/update',
      'products/delete',
      'inventory_levels/update',
    ]) {
      const id = await addEvent(topic);
      expect(await processWebhookEvent(deps(), { orgId: ORG, eventId: id }), topic).toBe(
        'deferred',
      );
      expect((await status(id)).status).toBe('deferred');
    }
    const id = await addEvent('themes/publish');
    expect(await processWebhookEvent(deps(), { orgId: ORG, eventId: id })).toBe('ignored');
    expect((await status(id)).status).toBe('ignored');
  });
  it('records customer privacy requests without payload and leaves data alone', async () => {
    for (const topic of ['customers/data_request', 'customers/redact']) {
      const id = await addEvent(topic);
      expect(await processWebhookEvent(deps(), { orgId: ORG, eventId: id })).toBe('processed');
      expect((await status(id)).status).toBe('processed');
    }
    const audit = await owner.query(
      `select after_json from audit_log where org_id = $1 and action = 'privacy.request_recorded' order by created_at`,
      [ORG],
    );
    expect(audit.rows.map((r) => r.after_json)).toEqual([
      { topic: 'customers/data_request' },
      { topic: 'customers/redact' },
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain('payload');
    expect(
      (await owner.query(`select status from store_connections where id = $1`, [ORG])).rows[0]
        .status,
    ).toBe('active');
  });
  it('shop/redact purges that connection (ledger included) and nothing else', async () => {
    await owner.query(`insert into products (id, org_id, title) values ($1, $1, 'P')`, [ORG]);
    await owner.query(
      `insert into skus (id, org_id, product_id, sku_code, selling_price_cents) values ($1, $1, $1, 'S', 100)`,
      [ORG],
    );
    for (const c of [ORG, OTHER]) {
      await owner.query(
        `insert into locations (id, org_id, store_connection_id, external_id, name, type, source) values ($1, $2, $1, 'l', 'L', 'warehouse', 'shopify')`,
        [c, ORG],
      );
      await owner.query(
        `insert into inventory_movements (org_id, sku_id, location_id, delta, reason) values ($1, $1, $2, 1, 'adjustment')`,
        [ORG, c],
      );
    }
    const id = await addEvent('shop/redact', { connection: ORG });
    expect(await processWebhookEvent(deps(), { orgId: ORG, eventId: id })).toBe('processed');
    expect(
      (await owner.query(`select 1 from store_connections where id = $1`, [ORG])).rowCount,
    ).toBe(0);
    expect(
      (await owner.query(`select 1 from inventory_movements where location_id = $1`, [ORG]))
        .rowCount,
    ).toBe(0);
    expect(
      (await owner.query(`select 1 from store_connections where id = $1`, [OTHER])).rowCount,
    ).toBe(1);
    expect(
      (await owner.query(`select 1 from inventory_movements where location_id = $1`, [OTHER]))
        .rowCount,
    ).toBe(1);
    expect((await owner.query(`select 1 from skus where id = $1`, [ORG])).rowCount).toBe(1);
    expect(
      (await owner.query(`select 1 from audit_log where action = 'store_connection.purged'`))
        .rowCount,
    ).toBe(1);
  });
  it('two concurrent deliveries of the same event do the work once', async () => {
    const id = await addEvent('app/uninstalled');
    const results = await Promise.all([
      processWebhookEvent(deps(), { orgId: ORG, eventId: id }),
      processWebhookEvent(deps(), { orgId: ORG, eventId: id }),
    ]);
    expect(results.filter((r) => r === 'processed')).toHaveLength(1);
    expect(results.filter((r) => r === 'skipped')).toHaveLength(1);
    expect(
      (await owner.query(`select 1 from audit_log where action = 'connection.uninstalled'`))
        .rowCount,
    ).toBe(1);
  });
  it('marks a failure with a sanitized message, rethrows, and a retry succeeds', async () => {
    const id = await addEvent('shop/redact', { connection: OTHER });
    const broken: ConnectionsApi = {
      ...connections,
      purgeStoreConnection: async () => {
        throw new Error('db down shpat_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE');
      },
    };
    await expect(
      processWebhookEvent({ db, connections: broken }, { orgId: ORG, eventId: id }),
    ).rejects.toThrow('db down');
    const failed = await status(id);
    expect(failed.status).toBe('failed');
    expect(failed.error).not.toMatch(/shpat_/);
    expect(await processWebhookEvent(deps(), { orgId: ORG, eventId: id })).toBe('processed');
  });
  it('reclaims an event stuck in processing for over 10 minutes but not a fresh one', async () => {
    const stale = await addEvent('products/update', { status: 'processing', ageMinutes: 30 });
    const fresh = await addEvent('products/update', { status: 'processing', ageMinutes: 1 });
    expect(await processWebhookEvent(deps(), { orgId: ORG, eventId: stale })).toBe('deferred');
    expect(await processWebhookEvent(deps(), { orgId: ORG, eventId: fresh })).toBe('skipped');
  });
  it('skips a missing event and refuses to touch another org', async () => {
    expect(
      await processWebhookEvent(deps(), {
        orgId: ORG,
        eventId: '99999999-9999-4999-8999-999999999999',
      }),
    ).toBe('skipped');
    const id = await addEvent('app/uninstalled');
    expect(
      await processWebhookEvent(deps(), {
        orgId: '22222222-2222-4222-8222-222222222222',
        eventId: id,
      }),
    ).toBe('skipped');
    expect((await status(id)).status).toBe('received');
  });
  it('rethrows the original error when recording the failure also fails', async () => {
    const id = await addEvent('shop/redact', { connection: OTHER });
    let calls = 0;
    const flaky: TenantDb = {
      ...db,
      withTenant: ((orgId: string, fn: never) => {
        if (++calls >= 2) throw new Error('mark failed');
        return db.withTenant(orgId, fn);
      }) as TenantDb['withTenant'],
    };
    const broken: ConnectionsApi = {
      ...connections,
      purgeStoreConnection: async () => {
        throw new Error('original boom');
      },
    };
    await expect(
      processWebhookEvent({ db: flaky, connections: broken }, { orgId: ORG, eventId: id }),
    ).rejects.toThrow('original boom');
  });
});
