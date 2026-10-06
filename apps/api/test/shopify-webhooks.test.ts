import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signWebhook } from '@erq/connectors/testing';
import type { WebhookJob } from '@erq/shared';
import { WEBHOOK_ENQUEUE_TIMEOUT_MS } from '../src/connections/connections.service';
import { WEBHOOK_QUEUE_PORT } from '../src/connections/tokens';
import type { WebhookQueue } from '../src/connections/webhook-queue';
import { createTestApp, type TestApp } from './helpers/app';

const SECRET = 'test-secret';
class RecordingQueue implements WebhookQueue {
  jobs: WebhookJob[] = [];
  failNext = false;
  hangNext = false;
  async enqueue(job: WebhookJob): Promise<void> {
    if (this.hangNext) {
      this.hangNext = false;
      return new Promise<void>(() => {}); // Redis down with commands queued forever
    }
    if (this.failNext) {
      this.failNext = false;
      throw new Error('redis down');
    }
    this.jobs.push(job);
  }
}
let t: TestApp;
let owner: Pool;
const queue = new RecordingQueue();
let orgId: string;
let connectionId: string;

beforeAll(async () => {
  t = await createTestApp({
    env: {
      API_PUBLIC_URL: 'http://api.test',
      SHOPIFY_API_KEY: 'k',
      SHOPIFY_API_SECRET: SECRET,
      ENCRYPTION_KEY_ID: 'k1',
      ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    },
    overrides: [{ provide: WEBHOOK_QUEUE_PORT, useValue: queue }],
  });
  owner = new Pool({ connectionString: t.tdb.ownerUrl });
  const user = randomUUID();
  const h = { authorization: `Bearer ${await t.signToken({ sub: user })}` };
  orgId = (await request(t.app.getHttpServer()).post('/orgs').set(h).send({ name: 'Hook Org' }))
    .body.orgId;
  connectionId = (
    await owner.query(
      `insert into store_connections (org_id, platform, external_account_id, status) values ($1, 'shopify', 'hook.myshopify.com', 'active') returning id`,
      [orgId],
    )
  ).rows[0].id;
});
afterAll(async () => {
  await owner?.end();
  await t?.close();
});
beforeEach(() => {
  queue.jobs = [];
});

const post = (body: string, headers: Record<string, string>) => {
  let r = request(t.app.getHttpServer())
    .post('/webhooks/shopify')
    .set('content-type', 'application/json');
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r.send(body);
};
const hdr = (body: string, over: Record<string, string> = {}): Record<string, string> => ({
  'x-shopify-hmac-sha256': signWebhook(body, SECRET),
  'x-shopify-topic': 'orders/updated',
  'x-shopify-shop-domain': 'hook.myshopify.com',
  'x-shopify-webhook-id': randomUUID(),
  ...over,
});
const without = (h: Record<string, string>, key: string): Record<string, string> => {
  const copy = { ...h };
  delete copy[key];
  return copy;
};
const events = async () =>
  (
    await owner.query(`select * from webhook_events where org_id = $1 order by received_at`, [
      orgId,
    ])
  ).rows;

describe('POST /webhooks/shopify', () => {
  it('verifies the raw body, stores the event once and enqueues one job', async () => {
    const body = '{"id": 1,  "note": "spacing   matters"}'; // odd spacing: the HMAC covers the exact bytes
    const headers = hdr(body);
    const res = await post(body, headers);
    expect(res.status).toBe(200);
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      topic: 'orders/updated',
      status: 'received',
      store_connection_id: connectionId,
      external_event_id: headers['x-shopify-webhook-id'],
    });
    expect(rows[0].payload).toEqual({ id: 1, note: 'spacing   matters' });
    expect(queue.jobs).toEqual([{ orgId, eventId: rows[0].id }]);
  });
  it('a redelivery of the same webhook id is stored once and enqueued once', async () => {
    const body = '{"id":2}';
    const headers = hdr(body);
    expect((await post(body, headers)).status).toBe(200);
    expect((await post(body, headers)).status).toBe(200);
    expect(
      (await events()).filter((e) => e.external_event_id === headers['x-shopify-webhook-id']),
    ).toHaveLength(1);
    expect(queue.jobs).toHaveLength(1);
  });
  it('rejects bad, missing and wrong-secret signatures and tampered bodies without storing anything', async () => {
    const before = (await events()).length;
    const body = '{"id":3}';
    for (const headers of [
      hdr(body, { 'x-shopify-hmac-sha256': signWebhook(body, 'wrong-secret') }),
      hdr(body, { 'x-shopify-hmac-sha256': 'garbage!!' }),
      without(hdr(body), 'x-shopify-hmac-sha256'),
    ]) {
      expect((await post(body, headers)).status).toBe(401);
    }
    expect((await post('{"id":4}', hdr(body))).status).toBe(401); // signature belongs to another body
    expect((await events()).length).toBe(before);
    expect(queue.jobs).toHaveLength(0);
  });
  it('answers 200 and stores nothing for an unknown shop; rejects missing topic headers', async () => {
    const body = '{"id":5}';
    const before = (await events()).length;
    expect(
      (await post(body, hdr(body, { 'x-shopify-shop-domain': 'nobody.myshopify.com' }))).status,
    ).toBe(200);
    expect((await events()).length).toBe(before);
    expect(queue.jobs).toHaveLength(0);
    expect((await post(body, without(hdr(body), 'x-shopify-topic'))).status).toBe(401);
  });
  it('stores events for a disconnected connection (privacy webhooks arrive after uninstall)', async () => {
    await owner.query(`update store_connections set status = 'disconnected' where id = $1`, [
      connectionId,
    ]);
    const body = '{"shop_id":1}';
    expect((await post(body, hdr(body, { 'x-shopify-topic': 'shop/redact' }))).status).toBe(200);
    expect((await events()).some((e) => e.topic === 'shop/redact')).toBe(true);
    await owner.query(`update store_connections set status = 'active' where id = $1`, [
      connectionId,
    ]);
  });
  it('still answers 200 and keeps the event when the queue is down', async () => {
    queue.failNext = true;
    const body = '{"id":6}';
    const headers = hdr(body);
    expect((await post(body, headers)).status).toBe(200);
    const row = (await events()).find(
      (e) => e.external_event_id === headers['x-shopify-webhook-id'],
    );
    expect(row.status).toBe('received');
    expect(queue.jobs).toHaveLength(0);
  });
  it('answers 200 within the enqueue timeout when the queue never answers, keeping the event received', async () => {
    queue.hangNext = true;
    const body = '{"id":9}';
    const headers = hdr(body);
    const started = Date.now();
    const res = await post(body, headers);
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(WEBHOOK_ENQUEUE_TIMEOUT_MS - 100);
    expect(elapsed).toBeLessThan(WEBHOOK_ENQUEUE_TIMEOUT_MS + 3000);
    const row = (await events()).find(
      (e) => e.external_event_id === headers['x-shopify-webhook-id'],
    );
    expect(row.status).toBe('received');
    expect(queue.jobs).toHaveLength(0);
  });
  it('rejects a signed but non-JSON body with 400 and stores nothing', async () => {
    const body = 'not json';
    const before = (await events()).length;
    const res = await post(body, hdr(body));
    expect(res.status).toBe(400);
    // body-parser rejects it before the receiver runs, so this is the filter's code, not invalid_payload
    expect(res.body).toEqual({ error: { code: 'bad_request', message: expect.any(String) } });
    expect((await events()).length).toBe(before);
  });
  it('rejects a repeated hmac header', async () => {
    const body = '{"id":7}';
    const before = (await events()).length;
    const h = hdr(body);
    const res = await request(t.app.getHttpServer())
      .post('/webhooks/shopify')
      .set('content-type', 'application/json')
      .set(h)
      // superagent's typings only allow a string; Node sends an array value as a repeated header
      .set('x-shopify-hmac-sha256', [
        h['x-shopify-hmac-sha256'],
        h['x-shopify-hmac-sha256'],
      ] as unknown as string)
      .send(body);
    expect(res.status).toBe(401);
    expect((await events()).length).toBe(before);
  });
  it('accepts a signed payload of about 500kb', async () => {
    const body = JSON.stringify({ id: 8, note: 'x'.repeat(500_000) });
    const headers = hdr(body);
    expect((await post(body, headers)).status).toBe(200);
    expect(
      (await events()).filter((e) => e.external_event_id === headers['x-shopify-webhook-id']),
    ).toHaveLength(1);
  });
  it('still rejects an oversize body on other routes with 413', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/orgs')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ name: 'x'.repeat(200_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payload_too_large');
  });
});

describe('POST /webhooks/shopify without Shopify configuration', () => {
  it('answers 503 shopify_not_configured', { timeout: 180_000 }, async () => {
    const bare = await createTestApp();
    try {
      const body = '{"id":1}';
      const res = await request(bare.app.getHttpServer())
        .post('/webhooks/shopify')
        .set('content-type', 'application/json')
        .set(hdr(body))
        .send(body);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('shopify_not_configured');
    } finally {
      await bare.close();
    }
  });
});
