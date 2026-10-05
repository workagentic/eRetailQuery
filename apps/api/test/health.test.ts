import { afterAll, beforeAll, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './helpers/app';

let t: TestApp | undefined;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t?.close();
});

it('GET /health returns ok when the database is reachable', async () => {
  const res = await request(t!.app.getHttpServer()).get('/health');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: 'ok' });
});

it('unknown routes use the standard error shape', async () => {
  const res = await request(t!.app.getHttpServer()).get('/nope');
  expect(res.status).toBe(404);
  expect(res.body).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
});
