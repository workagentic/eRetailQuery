import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../src/testing';

const O1 = '11111111-1111-4111-8111-111111111111';
const O2 = '22222222-2222-4222-8222-222222222222';
let tdb: TestDatabase;
let owner: Pool;

const insert = (client: Pool | PoolClient, org: string, shop: string, status: string) =>
  client.query(
    `insert into store_connections (org_id, platform, external_account_id, status) values ($1, 'shopify', $2, $3)`,
    [org, shop, status],
  );

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  for (const [org, slug] of [
    [O1, 'o1'],
    [O2, 'o2'],
  ]) {
    await owner.query(`insert into orgs (id, name, slug) values ($1, $2, $2)`, [org, slug]);
  }
});
afterAll(async () => {
  await owner?.end();
  await tdb?.stop();
});

describe('store_connections_active_shop_uq', () => {
  it('refuses a second non-disconnected connection of the same shop in another org', async () => {
    await insert(owner, O1, 'one.myshopify.com', 'active');
    await expect(insert(owner, O2, 'one.myshopify.com', 'active')).rejects.toMatchObject({
      code: '23505',
      constraint: 'store_connections_active_shop_uq',
    });
    await expect(insert(owner, O2, 'one.myshopify.com', 'pending')).rejects.toMatchObject({
      code: '23505',
    });
    await expect(insert(owner, O2, 'one.myshopify.com', 'error')).rejects.toMatchObject({
      code: '23505',
    });
  });
  it('allows disconnected and demo duplicates and a reconnect inside the same org', async () => {
    await insert(owner, O2, 'one.myshopify.com', 'disconnected');
    await insert(owner, O1, 'demo.myshopify.com', 'demo');
    await insert(owner, O2, 'demo.myshopify.com', 'demo');
    await owner.query(
      `update store_connections set status = 'active' where org_id = $1 and external_account_id = 'demo.myshopify.com'`,
      [O1],
    );
  });
  it('lets exactly one of two concurrent connects of a new shop win', async () => {
    const results = await Promise.allSettled([
      insert(owner, O1, 'race.myshopify.com', 'active'),
      insert(owner, O2, 'race.myshopify.com', 'active'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
});

describe('preflight and payload scrub migration', () => {
  const sqlFile = () => {
    const dir = path.resolve(__dirname, '../migrations');
    const name = readdirSync(dir).find((f) => /^\d{4}_shopify_active_shop_preflight\.sql$/.test(f));
    if (!name) throw new Error('preflight migration not found');
    return readFileSync(path.join(dir, name), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
  };
  it('empties every stored webhook payload', async () => {
    const { rows } = await owner.query(
      `select id from store_connections where external_account_id = 'one.myshopify.com' and status = 'active'`,
    );
    await owner.query(
      `insert into webhook_events (org_id, store_connection_id, topic, external_event_id, payload) values ($1, $2, 'orders/create', 'evt-scrub', '{"customer":"x"}')`,
      [O1, rows[0].id],
    );
    for (const statement of sqlFile()) await owner.query(statement);
    expect(
      (
        await owner.query(
          `select payload from webhook_events where external_event_id = 'evt-scrub'`,
        )
      ).rows[0].payload,
    ).toEqual({});
  });
  it('the preflight aborts and names the shop when duplicates already exist', async () => {
    const client = await owner.connect();
    try {
      await client.query('begin');
      await client.query('drop index store_connections_active_shop_uq');
      await insert(client, O1, 'dup.myshopify.com', 'active');
      await insert(client, O2, 'dup.myshopify.com', 'active');
      let message = '';
      try {
        for (const statement of sqlFile()) await client.query(statement);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain('dup.myshopify.com');
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});

describe('webhook_events_status_updated_idx', () => {
  it('exists on (status, updated_at)', async () => {
    const { rows } = await owner.query(
      `select indexdef from pg_indexes where indexname = 'webhook_events_status_updated_idx'`,
    );
    expect(rows[0].indexdef).toMatch(/\(status, updated_at\)/);
  });
});
