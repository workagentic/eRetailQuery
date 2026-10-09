import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConnectionsApi, createTenantDb, type ConnectionsApi, type TenantDb } from '@erq/db';
import { startTestDatabase, type TestDatabase } from '@erq/db/testing';
import { InMemoryJobQueue, type JobQueue, type SyncPageJob } from '@erq/sync';
import { processWebhookEvent } from '../src/webhooks/handler';
import {
  INVENTORY_NUDGE_DEBOUNCE_MS,
  NUDGE_DEBOUNCE_MS,
  nudgeDebounceMs,
  nudgeResourceFor,
} from '../src/webhooks/nudge';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-08T12:00:00.000Z');
const RESOURCES = ['locations', 'products', 'inventory', 'orders'];
let tdb: TestDatabase;
let owner: Pool;
let app: Pool;
let db: TenantDb;
let connections: ConnectionsApi;
let queue: InMemoryJobQueue;

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

let seq = 0;
beforeEach(async () => {
  queue = new InMemoryJobQueue();
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
});

type Per = Record<string, { status?: string; agoSec?: number | null; updatedAgoSec?: number }>;
async function seedCursors(
  connection: string,
  o: { agoSec?: number; per?: Per; only?: string[] } = {},
) {
  for (const resource of o.only ?? RESOURCES) {
    const p = o.per?.[resource] ?? {};
    const ago = p.agoSec === undefined ? (o.agoSec ?? 3600) : p.agoSec;
    await owner.query(
      `insert into sync_cursors (org_id, store_connection_id, resource, status, last_synced_at, updated_at) values ($1, $2, $3, $4, $5, $6)`,
      [
        ORG,
        connection,
        resource,
        p.status ?? 'complete',
        ago === null ? null : new Date(NOW.getTime() - ago * 1000),
        new Date(NOW.getTime() - (p.updatedAgoSec ?? ago ?? 0) * 1000),
      ],
    );
  }
}
async function addEvent(topic: string, connection = ORG) {
  const { rows } = await owner.query(
    `insert into webhook_events (org_id, store_connection_id, topic, external_event_id, payload, status) values ($1, $2, $3, $4, '{"secret":"payload"}', 'received') returning id`,
    [ORG, connection, topic, `evt-${++seq}`],
  );
  return rows[0].id as string;
}
// `null` means "no sync queue configured" (an `undefined` argument would take the default instead).
const handle = (eventId: string, sync: { queue: JobQueue } | null = { queue }) =>
  processWebhookEvent(
    { db, connections, sync: sync ?? undefined, now: () => NOW },
    { orgId: ORG, eventId },
  );
const event = async (id: string) =>
  (await owner.query(`select status, payload, error from webhook_events where id = $1`, [id]))
    .rows[0];
const jobs = (): SyncPageJob[] => {
  const out: SyncPageJob[] = [];
  for (let j = queue.take(); j; j = queue.take()) out.push(j.job);
  return out;
};
const runs = async () => (await owner.query(`select connection_id, type from sync_runs`)).rows;

describe('nudgeResourceFor', () => {
  it('maps only the two subscribed topics, and never reads the prototype', () => {
    expect(nudgeResourceFor('products/update')).toBe('products');
    expect(nudgeResourceFor('inventory_levels/update')).toBe('inventory');
    for (const topic of [
      'orders/updated',
      'app/uninstalled',
      'products/create',
      'toString',
      '__proto__',
      '',
    ]) {
      expect(nudgeResourceFor(topic)).toBeNull();
    }
  });
});

describe('a nudge', () => {
  it('starts an incremental sync of exactly the nudged resource, closes the event and scrubs its payload', async () => {
    await seedCursors(ORG);
    const id = await addEvent('products/update');
    expect(await handle(id)).toBe('processed');
    const [job, ...rest] = jobs();
    expect(rest).toEqual([]);
    expect(job).toMatchObject({ orgId: ORG, connectionId: ORG, resource: 'products' });
    expect(job!.then).toBeUndefined();
    expect(await runs()).toEqual([{ connection_id: ORG, type: 'incremental' }]);
    expect(await event(id)).toMatchObject({ status: 'processed', payload: {} });
  });
  it('maps inventory_levels/update to the inventory resource', async () => {
    await seedCursors(ORG);
    expect(await handle(await addEvent('inventory_levels/update'))).toBe('processed');
    expect(jobs()[0]).toMatchObject({ resource: 'inventory' });
  });
  it('turns a burst of 20 events into ONE sync', async () => {
    await seedCursors(ORG);
    const outcomes: string[] = [];
    for (let i = 0; i < 20; i += 1)
      outcomes.push(await handle(await addEvent('inventory_levels/update')));
    expect(new Set(outcomes)).toEqual(new Set(['processed']));
    expect(jobs()).toHaveLength(1);
    expect(await runs()).toHaveLength(1);
  });
  it('is debounced for 60 seconds after the resource last completed, starting again at exactly 60 s', async () => {
    expect(NUDGE_DEBOUNCE_MS).toBe(60_000);
    await seedCursors(ORG, { per: { products: { agoSec: 59 } } });
    expect(await handle(await addEvent('products/update'))).toBe('processed');
    expect(jobs()).toEqual([]);
    await owner.query('delete from sync_cursors');
    await seedCursors(ORG, { per: { products: { agoSec: 60 } } });
    await handle(await addEvent('products/update'));
    expect(jobs()).toHaveLength(1);
  });
  it('debounces an inventory nudge for 10 minutes (a full pass), while a products nudge keeps its 60 s', async () => {
    expect(INVENTORY_NUDGE_DEBOUNCE_MS).toBe(10 * 60_000);
    expect(nudgeDebounceMs('inventory')).toBe(INVENTORY_NUDGE_DEBOUNCE_MS);
    for (const r of ['products', 'locations', 'orders'] as const)
      expect(nudgeDebounceMs(r)).toBe(NUDGE_DEBOUNCE_MS);
    // inventory completed 9 min 59 s ago: dropped. A products nudge in the same state (5 min ago) starts.
    await seedCursors(ORG, { per: { inventory: { agoSec: 599 }, products: { agoSec: 300 } } });
    expect(await handle(await addEvent('inventory_levels/update'))).toBe('processed');
    expect(jobs()).toEqual([]);
    expect(await handle(await addEvent('products/update'))).toBe('processed');
    expect(jobs()).toHaveLength(1);
    // exactly 10 minutes ago: the inventory nudge starts
    await owner.query('delete from sync_cursors');
    await owner.query('delete from sync_runs');
    await seedCursors(ORG, { per: { inventory: { agoSec: 600 } } });
    await handle(await addEvent('inventory_levels/update'));
    expect(jobs()).toHaveLength(1);
    // a FAILED inventory attempt 5 minutes ago also waits (the back-off uses the same window)
    await owner.query('delete from sync_cursors');
    await owner.query('delete from sync_runs');
    await seedCursors(ORG, {
      per: { inventory: { status: 'failed', agoSec: 7200, updatedAgoSec: 300 } },
    });
    await handle(await addEvent('inventory_levels/update'));
    expect(jobs()).toEqual([]);
  });
  it('is dropped while ANY cursor of the connection is running', async () => {
    await seedCursors(ORG, { per: { orders: { status: 'running' } } });
    expect(await handle(await addEvent('products/update'))).toBe('processed');
    expect(jobs()).toEqual([]);
    expect(await runs()).toEqual([]);
  });
  it.each(['pending', 'error', 'disconnected', 'demo'])(
    'is dropped for a %s connection',
    async (status) => {
      await seedCursors(ORG);
      await owner.query(`update store_connections set status = $2 where id = $1`, [ORG, status]);
      const id = await addEvent('products/update');
      expect(await handle(id)).toBe('processed');
      expect(jobs()).toEqual([]);
      expect((await event(id)).status).toBe('processed');
    },
  );
  it('is dropped for a connection that never finished its first import (a nudge never starts a backfill)', async () => {
    await handle(await addEvent('products/update')); // no cursors at all
    await seedCursors(ORG, { only: ['locations', 'products', 'inventory'] });
    await handle(await addEvent('products/update'));
    expect(jobs()).toEqual([]);
    expect(await runs()).toEqual([]);
  });
  it('waits 60 s after a FAILED attempt of the nudged resource', async () => {
    await seedCursors(ORG, {
      per: { products: { status: 'failed', agoSec: 7200, updatedAgoSec: 30 } },
    });
    await handle(await addEvent('products/update'));
    expect(jobs()).toEqual([]);
    await owner.query('delete from sync_cursors');
    await seedCursors(ORG, {
      per: { products: { status: 'failed', agoSec: 7200, updatedAgoSec: 61 } },
    });
    await handle(await addEvent('products/update'));
    expect(jobs()).toHaveLength(1);
  });
  it("only touches the event's own connection", async () => {
    await seedCursors(ORG);
    await seedCursors(OTHER);
    await handle(await addEvent('products/update', OTHER));
    expect(jobs()[0]).toMatchObject({ connectionId: OTHER });
    expect(await runs()).toEqual([{ connection_id: OTHER, type: 'incremental' }]);
  });
  it('ends ignored (never throws) when no sync queue is configured', async () => {
    await seedCursors(ORG);
    const id = await addEvent('products/update');
    expect(await handle(id, null)).toBe('ignored');
    expect(await event(id)).toMatchObject({ status: 'ignored', payload: {} });
    expect(await runs()).toEqual([]);
  });
  it('a queue failure fails the event with a sanitized message, leaves no running cursor, and the retry works', async () => {
    await seedCursors(ORG);
    const broken: JobQueue = {
      enqueue: async () => {
        throw new Error('redis down shpat_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE');
      },
    };
    const id = await addEvent('products/update');
    await expect(handle(id, { queue: broken })).rejects.toThrow('redis down');
    const failed = await event(id);
    expect(failed.status).toBe('failed');
    expect(failed.error).not.toMatch(/shpat_/);
    const cursor = (
      await owner.query(
        `select status from sync_cursors where store_connection_id = $1 and resource = 'products'`,
        [ORG],
      )
    ).rows[0];
    expect(cursor.status).toBe('failed'); // not 'running': enqueueSync freed it
    await owner.query(`delete from sync_cursors`);
    await seedCursors(ORG);
    expect(await handle(id)).toBe('processed'); // the failed event is claimable again
    expect(jobs()).toHaveLength(1);
  });
  it('still parks the other data topics as deferred, with no job', async () => {
    await seedCursors(ORG);
    for (const topic of [
      'orders/updated',
      'orders/create',
      'refunds/create',
      'products/create',
      'products/delete',
    ]) {
      expect(await handle(await addEvent(topic))).toBe('deferred');
    }
    expect(jobs()).toEqual([]);
  });
});
