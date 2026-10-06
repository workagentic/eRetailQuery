import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConnectionsApi, createTenantDb, type ConnectionsApi, type TenantDb } from '@erq/db';
import { startTestDatabase, type TestDatabase } from '@erq/db/testing';
import type { WebhookJob } from '@erq/shared';
import { processWebhookEvent } from '../src/webhooks/handler';
import { sweepStaleWebhookEvents } from '../src/webhooks/sweep';

const ORG = '11111111-1111-4111-8111-111111111111';
let tdb: TestDatabase;
let owner: Pool;
let app: Pool;
let connections: ConnectionsApi;
let db: TenantDb;

beforeAll(async () => {
  tdb = await startTestDatabase();
  owner = new Pool({ connectionString: tdb.ownerUrl });
  app = new Pool({ connectionString: tdb.appUrl });
  connections = createConnectionsApi(app);
  db = createTenantDb(tdb.appUrl);
});
afterAll(async () => {
  await db?.close();
  await app?.end();
  await owner?.end();
  await tdb?.stop();
});

let seq = 0;
const add = async (status: string, ageMinutes: number) =>
  (
    await owner.query(
      `insert into webhook_events (org_id, store_connection_id, topic, external_event_id, payload, status, received_at)
       values ($1, $1, 'orders/updated', $2, '{}', $3, now() - ($4 || ' minutes')::interval) returning id`,
      [ORG, `s-${++seq}`, status, String(ageMinutes)],
    )
  ).rows[0].id as string;

beforeEach(async () => {
  await owner.query(`truncate orgs cascade`);
  await owner.query(`insert into orgs (id, name, slug) values ($1, 'Org', 'org')`, [ORG]);
  await owner.query(
    `insert into store_connections (id, org_id, platform, external_account_id, status) values ($1, $1, 'shopify', 's.myshopify.com', 'active')`,
    [ORG],
  );
});

describe('sweepStaleWebhookEvents', () => {
  it('enqueues only events that are still received and older than the cutoff', async () => {
    const stale = await add('received', 30);
    await add('received', 1);
    await add('processed', 120);
    await add('deferred', 120);
    await add('failed', 120);
    const jobs: WebhookJob[] = [];
    const n = await sweepStaleWebhookEvents({
      connections,
      enqueuer: { enqueue: async (j) => void jobs.push(j) },
    });
    expect(n).toBe(1);
    expect(jobs).toEqual([{ orgId: ORG, eventId: stale }]);
  });
  it('keeps going when one enqueue fails and reports how many were enqueued', async () => {
    const first = await add('received', 60);
    const second = await add('received', 30);
    const jobs: WebhookJob[] = [];
    const n = await sweepStaleWebhookEvents({
      connections,
      enqueuer: {
        enqueue: async (j) => {
          if (j.eventId === first) throw new Error('redis down');
          jobs.push(j);
        },
      },
    });
    expect(n).toBe(1);
    expect(jobs).toEqual([{ orgId: ORG, eventId: second }]);
  });
  it('honours a custom age and limit', async () => {
    await add('received', 90);
    await add('received', 80);
    await add('received', 70);
    const jobs: WebhookJob[] = [];
    const n = await sweepStaleWebhookEvents(
      { connections, enqueuer: { enqueue: async (j) => void jobs.push(j) } },
      { olderThanMs: 75 * 60_000, limit: 5 },
    );
    expect(n).toBe(2);
  });
  it('passes a retry bucket derived from the sweep window', async () => {
    await add('received', 30);
    const buckets: (string | undefined)[] = [];
    const real = Date.now();
    await sweepStaleWebhookEvents({
      connections,
      now: () => new Date(real),
      enqueuer: { enqueue: async (_j, o) => void buckets.push(o?.retryBucket) },
    });
    expect(buckets).toEqual([String(Math.floor(real / (10 * 60_000)))]);
  });
  it('recovers an event stuck in processing: the sweep lists it and a handler run reclaims it', async () => {
    const { rows } = await owner.query(
      `insert into webhook_events (org_id, store_connection_id, topic, external_event_id, payload, status, updated_at)
       values ($1, $1, 'app/uninstalled', 'crash-1', '{}', 'processing', now() - interval '30 minutes') returning id`,
      [ORG],
    );
    const id = rows[0].id as string;
    const jobs: WebhookJob[] = [];
    const n = await sweepStaleWebhookEvents({
      connections,
      enqueuer: { enqueue: async (j) => void jobs.push(j) },
    });
    expect(n).toBe(1);
    expect(jobs).toEqual([{ orgId: ORG, eventId: id }]);
    expect(await processWebhookEvent({ db, connections }, jobs[0]!)).toBe('processed');
    expect(
      (await owner.query(`select status from webhook_events where id = $1`, [id])).rows[0].status,
    ).toBe('processed');
    expect(
      (await owner.query(`select status from store_connections where id = $1`, [ORG])).rows[0]
        .status,
    ).toBe('disconnected');
  });
});
