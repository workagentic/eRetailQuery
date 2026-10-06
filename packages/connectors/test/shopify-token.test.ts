import { describe, expect, it } from 'vitest';
import {
  AuthError,
  exchangeCodeForToken,
  PermanentError,
  RateLimitedError,
  TransientError,
} from '../src';
import { FakeShopify } from '../src/testing';

const p = { shop: 'a.myshopify.com', apiKey: 'k', apiSecret: 's3cret', code: 'good-code' };

describe('exchangeCodeForToken', () => {
  it('returns the token and scopes and sends the documented request', async () => {
    const http = new FakeShopify({ token: 'shpat_abc', scope: 'read_orders,read_products' });
    await expect(exchangeCodeForToken(http, p)).resolves.toEqual({
      accessToken: 'shpat_abc',
      scopes: ['read_orders', 'read_products'],
    });
    const req = http.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://a.myshopify.com/admin/oauth/access_token');
    expect(req.headers?.['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(req.body!))).toEqual({
      client_id: 'k',
      client_secret: 's3cret',
      code: 'good-code',
    });
  });
  it('maps a rejected code, bad credentials, rate limits and server errors', async () => {
    await expect(
      exchangeCodeForToken(new FakeShopify(), { ...p, code: 'bad' }),
    ).rejects.toBeInstanceOf(PermanentError);
    const cases: [number, new (...a: never[]) => Error][] = [
      [401, AuthError],
      [403, AuthError],
      [429, RateLimitedError],
      [500, TransientError],
      [503, TransientError],
    ];
    for (const [status, type] of cases) {
      const http = new FakeShopify();
      http.failNext(status);
      await expect(exchangeCodeForToken(http, p)).rejects.toBeInstanceOf(type);
    }
  });
  it('honours retry-after on 429', async () => {
    const http = new FakeShopify();
    http.failNext(429, { 'retry-after': '3' });
    await expect(exchangeCodeForToken(http, p)).rejects.toMatchObject({ retryAfterMs: 3000 });
  });
  it('rejects an invalid shop before any request and never leaks secrets in errors', async () => {
    const http = new FakeShopify();
    await expect(exchangeCodeForToken(http, { ...p, shop: 'evil.com' })).rejects.toBeInstanceOf(
      PermanentError,
    );
    expect(http.requests).toHaveLength(0);
    const err = await exchangeCodeForToken(new FakeShopify(), { ...p, code: 'bad' }).catch(
      (e) => e,
    );
    expect(String(err.message)).not.toMatch(/s3cret|bad|good-code/);
  });
  it('treats a malformed success body as permanent', async () => {
    const http = new FakeShopify();
    http.respondNext({ status: 200, body: '{"nope":1}' });
    await expect(exchangeCodeForToken(http, p)).rejects.toBeInstanceOf(PermanentError);
  });
});
