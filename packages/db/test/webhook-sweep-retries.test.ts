import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConnectionsApi, type ConnectionsApi } from '../src';
import { startTestDatabase, type TestDatabase } from '../src/testing';

const A = '11111111-1111-4111-8111-111111111111';
let tdb: TestDatabase;
let owner: Pool;
let app: Pool;
let api: ConnectionsApi;
let seq = 0;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  app = new Pool({ connectionString: tdb.appUrl });
  api = createConnectionsApi(app);
  await owner.query(`insert into orgs (id, name, slug) values ($1, 'Org', 'org')`, [A]);
  await owner.query(
    `insert into store_connections (id, org_id, platform, external_account_id, status) values ($1, $1, 'shopify', 'a.myshopify.com', 'active')`,
    [A],
  );
}, 120_000);
afterAll(async () => {
  await app?.end();
  await owner?.end();
  await tdb?.stop();
});
beforeEach(() => owner.query('delete from webhook_events'));

/** updated_at is set on INSERT: the trigger only fires on UPDATE. */
async function add(
  topic: string,
  status: string,
  retries: number,
  minutesOld: number,
): Promise<string> {
  const { rows } = await owner.query(
    `insert into webhook_events (org_id, store_connection_id, topic, external_event_id, payload, status, sweep_retries, received_at, updated_at)
     values ($1, $1, $2, $3, '{}', $4, $5, now() - make_interval(mins => $6), now() - make_interval(mins => $6)) returning id`,
    [A, topic, `e-${++seq}`, status, retries, minutesOld],
  );
  return rows[0].id as string;
}
const listed = async () =>
  (await api.listStaleWebhookEvents(new Date(Date.now() - 10 * 60_000), 100))
    .map((e) => e.eventId)
    .sort();

describe('app_list_stale_webhook_events with a retry limit', () => {
  it('re-lists a failed live-topic event only while it has retries left and has cooled down for 10 minutes', async () => {
    const fresh = await add('app/uninstalled', 'failed', 0, 5);
    const first = await add('app/uninstalled', 'failed', 0, 20);
    const fourth = await add('products/update', 'failed', 4, 20);
    const exhausted = await add('products/update', 'failed', 5, 20);
    const beyond = await add('app/uninstalled', 'failed', 9, 20);
    const inventory = await add('inventory_levels/update', 'failed', 0, 20);
    const stray = await add('orders/updated', 'failed', 0, 20); // not a live topic: never retried
    expect(await listed()).toEqual([first, fourth, inventory].sort());
    expect(await listed()).not.toContain(stray);
    expect(await listed()).not.toContain(fresh);
    expect(await listed()).not.toContain(exhausted);
    expect(await listed()).not.toContain(beyond);
  });
  it('keeps privacy topics unlimited whatever the counter says', async () => {
    const ids = [
      await add('customers/data_request', 'failed', 99, 20),
      await add('customers/redact', 'failed', 0, 20),
      await add('shop/redact', 'failed', 5, 20),
    ];
    expect(await listed()).toEqual(ids.sort());
  });
  it('still lists received and processing events past the cutoff, and nothing that is processed, ignored or deferred', async () => {
    const received = await add('products/update', 'received', 0, 20);
    const processing = await add('products/update', 'processing', 0, 20);
    for (const status of ['processed', 'ignored', 'deferred'])
      await add('products/update', status, 0, 20);
    expect(await listed()).toEqual([received, processing].sort());
  });
  it('is SECURITY DEFINER with a pinned search_path and executable by app_user only', async () => {
    const fn = 'app_list_stale_webhook_events(timestamptz, integer)';
    const { rows } = await owner.query(
      `select prosecdef, proconfig from pg_proc where oid = $1::regprocedure`,
      [fn],
    );
    expect(rows[0].prosecdef).toBe(true);
    expect(rows[0].proconfig).toContain('search_path=pg_catalog, public, pg_temp');
    const priv = async (role: string) =>
      (
        await owner.query(`select has_function_privilege($1, $2::regprocedure, 'execute') as ok`, [
          role,
          fn,
        ])
      ).rows[0].ok;
    expect(await priv('public')).toBe(false);
    expect(await priv('app_user')).toBe(true);
  });
});
