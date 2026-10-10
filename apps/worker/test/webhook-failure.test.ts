import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConnectionsApi, createTenantDb, type ConnectionsApi, type TenantDb } from '@erq/db';
import { startTestDatabase, type TestDatabase } from '@erq/db/testing';
import type { JobQueue } from '@erq/sync';
import { WEBHOOK_SWEEP_MAX_RETRIES, webhookAlertFor } from '../src/webhooks/alerts';
import { processWebhookEvent } from '../src/webhooks/handler';
import { sweepStaleWebhookEvents } from '../src/webhooks/sweep';

const ORG = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-08T12:00:00.000Z');
let tdb: TestDatabase;
let owner: Pool;
let app: Pool;
let db: TenantDb;
let connections: ConnectionsApi;
let seq = 0;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  app = new Pool({ connectionString: tdb.appUrl });
  db = createTenantDb(tdb.appUrl);
  connections = createConnectionsApi(app);
}, 120_000);
afterAll(async () => {
  await db?.close();
  await app?.end();
  await owner?.end();
  await tdb?.stop();
});
beforeEach(async () => {
  await owner.query(`truncate orgs cascade`);
  await owner.query(`insert into orgs (id, name, slug) values ($1, 'Org', 'org')`, [ORG]);
  await owner.query(
    `insert into store_connections (id, org_id, platform, external_account_id, status, encrypted_credentials) values ($1, $1, 'shopify', 'main.myshopify.com', 'active', 'ciphertext')`,
    [ORG],
  );
});

async function addEvent(
  topic: string,
  o: { status?: string; retries?: number; minutesOld?: number } = {},
) {
  const { rows } = await owner.query(
    `insert into webhook_events (org_id, store_connection_id, topic, external_event_id, payload, status, sweep_retries, received_at, updated_at)
     values ($1, $1, $2, $3, '{}', $4, $5, $6, $6) returning id`,
    [
      ORG,
      topic,
      `evt-${++seq}`,
      o.status ?? 'received',
      o.retries ?? 0,
      new Date(NOW.getTime() - (o.minutesOld ?? 0) * 60_000),
    ],
  );
  return rows[0].id as string;
}
const event = async (id: string) =>
  (await owner.query(`select status, error, sweep_retries from webhook_events where id = $1`, [id]))
    .rows[0];
const alertRows = async () => (await owner.query(`select * from alerts order by created_at`)).rows;
/** A db whose SECOND tenant transaction fails (the claim is the first), like a database blip during the work. */
const failingWork = (): TenantDb => {
  let calls = 0;
  return {
    ...db,
    withTenant: (org: string, fn: Parameters<TenantDb['withTenant']>[1]) =>
      ++calls === 2
        ? Promise.reject(new Error('db down shpat_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE'))
        : db.withTenant(org, fn),
  } as TenantDb;
};
const throwingQueue: JobQueue = {
  enqueue: async () => {
    throw new Error('redis down shpat_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE');
  },
};
async function backfilledCursors() {
  for (const resource of ['locations', 'products', 'inventory', 'orders']) {
    await owner.query(
      `insert into sync_cursors (org_id, store_connection_id, resource, status, last_synced_at, updated_at) values ($1, $1, $2, 'complete', $3, $3)`,
      [ORG, resource, new Date(NOW.getTime() - 3_600_000)],
    );
  }
}
const run = (id: string, over: { db?: TenantDb; sync?: { queue: JobQueue } } = {}) =>
  processWebhookEvent(
    { db: over.db ?? db, connections, sync: over.sync, now: () => NOW },
    { orgId: ORG, eventId: id },
  );

describe('webhookAlertFor', () => {
  it('uses fixed texts: high for the uninstall, medium for everything else', () => {
    expect(WEBHOOK_SWEEP_MAX_RETRIES).toBe(5);
    expect(webhookAlertFor('app/uninstalled')).toEqual({
      severity: 'high',
      message: 'Shopify could not tell us the shop uninstalled. Reconnect if you removed the app.',
    });
    expect(webhookAlertFor('products/update')).toEqual({
      severity: 'medium',
      message:
        'A live update from Shopify could not be applied. We still check your store every 15 minutes, so nothing is lost.',
    });
  });
});

describe('the sweep retry budget', () => {
  const enqueued: string[] = [];
  const enqueuer = {
    enqueue: async (job: { eventId: string }) => {
      enqueued.push(job.eventId);
    },
  };
  const clock = { ms: Date.parse('2026-10-08T12:00:00.000Z') };
  const sweep = () =>
    sweepStaleWebhookEvents({ connections, enqueuer, db, now: () => new Date(clock.ms) });
  const stamp = (id: string, minutesOld: number) =>
    owner.query(`update webhook_events set updated_at = $2 where id = $1`, [
      id,
      new Date(clock.ms - minutesOld * 60_000),
    ]);
  // These tests place updated_at themselves, so the trigger that stamps it with the real clock is switched off.
  beforeAll(() => owner.query(`alter table webhook_events disable trigger set_updated_at`));
  afterAll(() => owner.query(`alter table webhook_events enable trigger set_updated_at`));
  beforeEach(() => {
    enqueued.length = 0;
    clock.ms = Date.parse('2026-10-08T12:00:00.000Z');
  });

  it('retries a failed live-topic event at most 5 times, one every 10 minutes, and counts each retry', async () => {
    const id = await addEvent('app/uninstalled', { status: 'failed', minutesOld: 30 });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(await sweep(), `sweep ${attempt}`).toBe(1);
      expect((await event(id)).sweep_retries).toBe(attempt);
      await stamp(id, 0); // the retry just failed again: its last attempt is now
      expect(await sweep(), `cool-down ${attempt}`).toBe(0);
      clock.ms += 11 * 60_000; // past the 10 minute cool-down
    }
    clock.ms += 6 * 3_600_000;
    expect(await sweep()).toBe(0); // the budget is spent
    expect((await event(id)).status).toBe('failed'); // and the event stays failed
    expect(enqueued).toEqual([id, id, id, id, id]);
  });
  it('never stops retrying a privacy event and never counts it', async () => {
    const id = await addEvent('shop/redact', { status: 'failed', minutesOld: 30 });
    for (let i = 0; i < 8; i += 1) {
      expect(await sweep(), `sweep ${i}`).toBe(1);
      clock.ms += 11 * 60_000;
    }
    expect((await event(id)).sweep_retries).toBe(0);
  });
  it('does not count a retry for an event that is merely received or processing', async () => {
    const received = await addEvent('products/update', { status: 'received', minutesOld: 30 });
    expect(await sweep()).toBe(1);
    expect((await event(received)).sweep_retries).toBe(0);
  });
});

describe('the alert at exhaustion', () => {
  it('writes ONE high alert for a failing app/uninstalled once its retries are used up, however often it fails again', async () => {
    const id = await addEvent('app/uninstalled', { status: 'received', retries: 5 });
    await expect(run(id, { db: failingWork() })).rejects.toThrow('db down');
    expect((await event(id)).status).toBe('failed');
    await expect(run(id, { db: failingWork() })).rejects.toThrow('db down'); // a failed event is claimable again
    const rows = await alertRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      org_id: ORG,
      type: 'webhook_failed',
      severity: 'high',
      store_connection_id: ORG,
      entity_ref: `webhook_event:${id}`,
      message: 'Shopify could not tell us the shop uninstalled. Reconnect if you removed the app.',
      resolved_at: null,
    });
    expect(JSON.stringify(rows)).not.toMatch(/shpat_|db down/); // the error text never reaches an alert
    expect(JSON.stringify(await event(id))).not.toMatch(/shpat_/);
  });
  it('writes a medium alert for a failing nudge', async () => {
    await backfilledCursors();
    const id = await addEvent('products/update', { retries: 5 });
    await expect(run(id, { sync: { queue: throwingQueue } })).rejects.toThrow('redis down');
    expect((await alertRows()).map((r) => r.severity)).toEqual(['medium']);
  });
  it('writes no alert while retries remain', async () => {
    const id = await addEvent('app/uninstalled', { retries: WEBHOOK_SWEEP_MAX_RETRIES - 1 });
    await expect(run(id, { db: failingWork() })).rejects.toThrow('db down');
    expect(await alertRows()).toEqual([]);
    expect((await event(id)).status).toBe('failed');
  });
  it('never raises this alert for a privacy topic, which keeps retrying', async () => {
    const id = await addEvent('customers/redact', { retries: 99 });
    await expect(run(id, { db: failingWork() })).rejects.toThrow('db down');
    expect(await alertRows()).toEqual([]);
  });
});

describe('a stale uninstall after a reconnect', () => {
  const connection = async () =>
    (
      await owner.query(
        `select status, encrypted_credentials from store_connections where id = $1`,
        [ORG],
      )
    ).rows[0];
  it('leaves a reinstalled shop connected when the reconnect retired the failed uninstall (sweep plus handler run)', async () => {
    const id = await addEvent('app/uninstalled', { status: 'failed', minutesOld: 30 });
    // What the API's reconnect transaction does (apps/api connections.service retirePendingUninstalls).
    await owner.query(`update webhook_events set status = 'ignored' where id = $1`, [id]);
    const enqueued: string[] = [];
    const swept = await sweepStaleWebhookEvents({
      connections,
      db,
      enqueuer: { enqueue: async (j) => void enqueued.push(j.eventId) },
      now: () => new Date(),
    });
    expect(swept).toBe(0);
    expect(await run(id)).toBe('skipped');
    expect(await connection()).toEqual({ status: 'active', encrypted_credentials: 'ciphertext' });
  });
  it('stops an in-flight uninstall whose event was retired by a reconnect after the claim', async () => {
    const id = await addEvent('app/uninstalled', { status: 'failed', minutesOld: 30 });
    let calls = 0;
    const reconnectAfterClaim = {
      ...db,
      withTenant: async (org: string, fn: Parameters<TenantDb['withTenant']>[1]) => {
        // Between the claim (call 1) and the work (call 2) the reconnect commits.
        if (++calls === 2)
          await owner.query(`update webhook_events set status = 'ignored' where id = $1`, [id]);
        return db.withTenant(org, fn);
      },
    } as TenantDb;
    expect(await run(id, { db: reconnectAfterClaim })).toBe('skipped');
    expect(await connection()).toEqual({ status: 'active', encrypted_credentials: 'ciphertext' });
    expect((await event(id)).status).toBe('ignored');
  });
});

describe('a later success', () => {
  it('resolves the alert an exhausted earlier failure raised', async () => {
    const id = await addEvent('app/uninstalled', { retries: 5 });
    await expect(run(id, { db: failingWork() })).rejects.toThrow('db down');
    expect((await alertRows()).map((r) => r.resolved_at)).toEqual([null]);
    expect(await run(id)).toBe('processed');
    const rows = await alertRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].resolved_at).not.toBeNull();
  });
});

describe('lock order between a reconnect and an uninstall', () => {
  it('a reconnect holding the connection row and an uninstall run never deadlock: the uninstall waits, then skips', async () => {
    const id = await addEvent('app/uninstalled', { status: 'failed', minutesOld: 30 });
    const reconnect = await owner.connect();
    try {
      // The reconnect transaction (apps/api completeInstall): the upsert locks the connection row first...
      await reconnect.query('begin');
      const { rows } = await reconnect.query<{ pid: number }>('select pg_backend_pid() as pid');
      await reconnect.query(
        `insert into store_connections (org_id, platform, external_account_id, status) values ($1, 'shopify', 'main.myshopify.com', 'active')
         on conflict (org_id, platform, external_account_id) do update set status = 'active', updated_at = now()`,
        [ORG],
      );
      // ...while the uninstall run starts and must block on that row before it locks its event row.
      const handler = run(id);
      const deadline = Date.now() + 15_000;
      for (;;) {
        const waiting = await owner.query(
          `select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and pid <> $1 and datname = current_database()`,
          [rows[0]!.pid],
        );
        if (waiting.rows[0].n > 0) break;
        if (Date.now() > deadline)
          throw new Error('the uninstall run never waited on the connection row');
        await new Promise((r) => setTimeout(r, 20));
      }
      // ...then the reconnect retires the event. With the inverted order this statement would deadlock.
      await reconnect.query(
        `update webhook_events set status = 'ignored', updated_at = now() where id = $1 and status in ('received', 'failed', 'processing')`,
        [id],
      );
      await reconnect.query('commit');
      expect(await handler).toBe('skipped');
    } finally {
      await reconnect.query('rollback').catch(() => undefined);
      reconnect.release();
    }
    const conn = (
      await owner.query(
        `select status, encrypted_credentials from store_connections where id = $1`,
        [ORG],
      )
    ).rows[0];
    expect(conn).toEqual({ status: 'active', encrypted_credentials: 'ciphertext' });
    expect((await event(id)).status).toBe('ignored');
  }, 30_000);
});
