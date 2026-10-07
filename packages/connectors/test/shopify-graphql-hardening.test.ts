import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { createShopifyGraphqlClient, PermanentError, RateLimitedError } from '../src';
import { FakeShopifyAdmin, gqlOk, gqlThrottled, paginate } from '../src/testing';

const op = {
  name: 'Ping',
  document: 'query Ping { shop { name } }',
  schema: z.object({ shop: z.object({ name: z.string() }) }),
};
const ctx = {
  externalAccountId: 'a.myshopify.com',
  credentials: { accessToken: 'shpat_secret_token_value' },
};
const clientFor = (admin: FakeShopifyAdmin) => createShopifyGraphqlClient({ http: admin });
const run = (admin: FakeShopifyAdmin, variables: Record<string, unknown> = {}) =>
  clientFor(admin)
    .query(ctx, op, variables)
    .then(
      () => new Error('unexpected success'),
      (e: unknown) => e as Error,
    );

describe('createShopifyGraphqlClient hardening', () => {
  it('clamps the 429 retry-after to 500..60000 ms and defaults bad values to 2000', async () => {
    const cases: [string, number][] = [
      ['1000000000', 60_000],
      ['0', 500],
      ['0.2', 500],
      ['3', 3000],
      ['', 2000],
      ['abc', 2000],
      ['-1', 2000],
      ['Wed, 21 Oct 2026 07:28:00 GMT', 2000],
    ];
    for (const [header, expected] of cases) {
      const admin = new FakeShopifyAdmin();
      admin.failNext(429, { 'retry-after': header });
      const err = await run(admin);
      expect(err).toBeInstanceOf(RateLimitedError);
      expect((err as RateLimitedError).retryAfterMs).toBe(expected);
    }
  });

  it('fails the page when errors accompany valid data, but THROTTLED stays a rate limit', async () => {
    const data = { shop: { name: 'Acme' } };
    const denied = new FakeShopifyAdmin().on('Ping', () => ({
      data,
      errors: [{ message: 'nope', extensions: { code: 'ACCESS_DENIED' } }],
    }));
    expect(await run(denied)).toBeInstanceOf(PermanentError);
    const plain = new FakeShopifyAdmin().on('Ping', () => ({ data, errors: [{ message: 'x' }] }));
    const e2 = await run(plain);
    expect(e2).toBeInstanceOf(PermanentError);
    expect(e2.message).toBe('Shopify returned an unexpected response.');
    const thr = new FakeShopifyAdmin().on('Ping', () => ({
      data,
      errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
    }));
    expect(await run(thr)).toBeInstanceOf(RateLimitedError);
  });

  it('tolerates null or non-object error extensions', async () => {
    for (const extensions of [null, 'THROTTLED', 5, []]) {
      const admin = new FakeShopifyAdmin().on('Ping', () => ({
        errors: [
          { message: 'm', extensions },
          { message: 't', extensions: { code: 'THROTTLED' } },
        ],
      }));
      expect(await run(admin)).toBeInstanceOf(RateLimitedError);
    }
    const odd = new FakeShopifyAdmin().on('Ping', () => ({
      errors: [{ message: 'm', extensions: null }],
    }));
    const e = await run(odd);
    expect(e).toBeInstanceOf(PermanentError);
    expect(e.message).toBe('Shopify returned an unexpected response.');
  });

  it('sends the token only in its header and validates the shop before credentials', async () => {
    const admin = new FakeShopifyAdmin().on('Ping', () => gqlOk({ shop: { name: 'A' } }));
    await clientFor(admin).query(ctx, op, { v: 1 });
    const req = admin.requests[0]!;
    expect(req.url).not.toContain('shpat_');
    expect(req.body).not.toContain('shpat_');
    expect(req.headers?.['content-type']).toBe('application/json');
    expect(req.headers?.accept).toBe('application/json');
    const none = new FakeShopifyAdmin();
    const err = await clientFor(none)
      .query({ externalAccountId: 'evil.com', credentials: null }, op, {})
      .then(
        () => new Error('unexpected success'),
        (e: unknown) => e as Error,
      );
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.message).toBe('Invalid shop domain');
    expect(none.requests).toHaveLength(0);
  });

  it('maps HTTP 204 to a permanent error', async () => {
    const admin = new FakeShopifyAdmin();
    admin.failNext(204);
    expect(await run(admin)).toBeInstanceOf(PermanentError);
  });

  it('leaks nothing on any error path', async () => {
    const setups: ((a: FakeShopifyAdmin) => void)[] = [
      (a) => a.failNext(401),
      (a) => a.failNext(403),
      (a) => a.failNext(429, { 'retry-after': '1' }),
      (a) => a.failNext(500),
      (a) => a.failNext(404),
      (a) => void a.on('Ping', () => gqlThrottled()),
      (a) =>
        void a.on('Ping', () => ({
          errors: [{ message: 'shpat_leak', extensions: { code: 'ACCESS_DENIED' } }],
        })),
      (a) => void a.on('Ping', () => ({ errors: [{ message: 'shpat_leak query Ping zzz' }] })),
      (a) => a.respondNext({ status: 200, body: 'shpat_leak not json' }),
      (a) => void a.on('Ping', () => gqlOk({ shop: { name: 5 } })),
    ];
    for (const setup of setups) {
      const admin = new FakeShopifyAdmin();
      setup(admin);
      const err = await run(admin, { secretVariable: 'zzz' });
      expect(err).toBeInstanceOf(Error);
      expect(err.message).not.toMatch(/shpat_|Ping|zzz|shop \{|secretVariable/);
      expect(err.cause).toBeUndefined();
    }
  });
});

describe('FakeShopifyAdmin', () => {
  const post = (admin: FakeShopifyAdmin, body: string) =>
    admin.request({ method: 'POST', url: 'https://a.myshopify.com/x', body });
  it('404s unknown operations and 400s malformed bodies', async () => {
    const admin = new FakeShopifyAdmin();
    expect((await post(admin, JSON.stringify({ operationName: 'Nope' }))).status).toBe(404);
    expect((await post(admin, 'not json')).status).toBe(400);
  });
  it('consumes scripted responses first and in order', async () => {
    const admin = new FakeShopifyAdmin().on('A', () => ({ data: 1 }));
    admin.failNext(500);
    admin.respondNext({ status: 200, body: 'x' });
    const body = JSON.stringify({ operationName: 'A' });
    expect((await post(admin, body)).status).toBe(500);
    expect((await post(admin, body)).body).toBe('x');
    expect((await post(admin, body)).body).toBe('{"data":1}');
    expect(admin.callsOf('A')).toBe(1);
  });
  it('counts per operation and passes variables and an increasing index', async () => {
    const seen: [unknown, number][] = [];
    const admin = new FakeShopifyAdmin()
      .on('A', (v, i) => {
        seen.push([v, i]);
        return {};
      })
      .on('B', () => ({}));
    await post(admin, JSON.stringify({ operationName: 'A', variables: { k: 1 } }));
    await post(admin, JSON.stringify({ operationName: 'A' }));
    await post(admin, JSON.stringify({ operationName: 'B' }));
    expect(seen).toEqual([
      [{ k: 1 }, 0],
      [{}, 1],
    ]);
    expect(admin.callsOf('A')).toBe(2);
    expect(admin.callsOf('B')).toBe(1);
    expect(admin.callsOf('C')).toBe(0);
  });
  it('fails clearly when a handler returns undefined', async () => {
    const admin = new FakeShopifyAdmin().on('A', () => undefined);
    await expect(post(admin, JSON.stringify({ operationName: 'A' }))).rejects.toThrow(
      'FakeShopifyAdmin handler for A returned undefined',
    );
  });
  it('paginate rejects a non-numeric cursor', () => {
    expect(() => paginate([1, 2], 1, 'abc')).toThrow(Error);
    expect(() => paginate([1, 2], 1, '')).toThrow(Error);
  });
});
