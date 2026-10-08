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
  it('asks for an expiring offline token and returns the lifetimes and the refresh token', async () => {
    const http = new FakeShopify({
      token: 'shpat_abc',
      refreshToken: 'shprt_abc',
      scope: 'read_orders,read_products',
    });
    await expect(exchangeCodeForToken(http, p)).resolves.toEqual({
      accessToken: 'shpat_abc',
      accessTokenExpiresInSec: 3600,
      refreshToken: 'shprt_abc',
      refreshTokenExpiresInSec: 7776000,
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
      expiring: '1',
    });
  });
  it('treats a response without any expiry field as a non-expiring token', async () => {
    const http = new FakeShopify();
    http.respondNext({
      status: 200,
      body: JSON.stringify({ access_token: 'shpat_old', scope: 'read_orders' }),
    });
    await expect(exchangeCodeForToken(http, p)).resolves.toEqual({
      accessToken: 'shpat_old',
      accessTokenExpiresInSec: null,
      refreshToken: null,
      refreshTokenExpiresInSec: null,
      scopes: ['read_orders'],
    });
  });
  it.each([
    ['only a refresh token', { refresh_token: 'shprt_x' }],
    ['only a lifetime', { expires_in: 3600 }],
    ['no refresh lifetime', { expires_in: 3600, refresh_token: 'shprt_x' }],
    ['a zero lifetime', { expires_in: 0, refresh_token: 'shprt_x', refresh_token_expires_in: 10 }],
    [
      'a fractional lifetime',
      { expires_in: 1.5, refresh_token: 'shprt_x', refresh_token_expires_in: 10 },
    ],
  ])(
    'rejects a partial or invalid expiring set (%s) with a fixed message',
    async (_name, extra) => {
      const http = new FakeShopify();
      http.respondNext({
        status: 200,
        body: JSON.stringify({ access_token: 'shpat_secret_value', scope: '', ...extra }),
      });
      await expect(exchangeCodeForToken(http, p)).rejects.toMatchObject({
        name: 'PermanentError',
        message: 'Shopify returned an unreadable token response',
      });
    },
  );
  it('never puts the secret, the code or a token in an error message', async () => {
    for (const status of [400, 401, 403, 429, 500, 503]) {
      const http = new FakeShopify({ token: 'shpat_abc', refreshToken: 'shprt_abc' });
      http.failNext(status);
      const err = (await exchangeCodeForToken(http, p).catch((e: unknown) => e)) as Error;
      for (const secret of ['s3cret', 'good-code', 'shpat_abc', 'shprt_abc']) {
        expect(err.message).not.toContain(secret);
      }
    }
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
  it.each([[''], ['   '], ['soon'], ['-5']])(
    'treats a retry-after of %j as missing (2000 ms)',
    async (value) => {
      const http = new FakeShopify();
      http.failNext(429, { 'retry-after': value });
      await expect(exchangeCodeForToken(http, p)).rejects.toMatchObject({ retryAfterMs: 2000 });
    },
  );
  it('treats a missing retry-after as 2000 ms', async () => {
    const http = new FakeShopify();
    http.failNext(429);
    await expect(exchangeCodeForToken(http, p)).rejects.toMatchObject({ retryAfterMs: 2000 });
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
