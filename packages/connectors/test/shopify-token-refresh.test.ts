import { describe, expect, it } from 'vitest';
import {
  AuthError,
  PermanentError,
  RateLimitedError,
  SHOPIFY_RECONNECT_MESSAGE,
  TransientError,
  refreshAccessToken,
} from '../src';
import { FakeShopify } from '../src/testing';

const p = {
  shop: 'a.myshopify.com',
  apiKey: 'k',
  apiSecret: 's3cret',
  refreshToken: 'shprt_seed_token',
};
const fakeWithSeed = () => {
  const http = new FakeShopify({ token: 'shpat_abc', refreshToken: 'shprt_abc' });
  http.acceptRefreshToken(p.refreshToken);
  return http;
};

describe('refreshAccessToken', () => {
  it('sends the documented request and returns the rotated pair', async () => {
    const http = fakeWithSeed();
    await expect(refreshAccessToken(http, p)).resolves.toEqual({
      accessToken: 'shpat_abc_1',
      accessTokenExpiresInSec: 3600,
      refreshToken: 'shprt_abc_1',
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
      grant_type: 'refresh_token',
      refresh_token: 'shprt_seed_token',
    });
  });
  it('rotates: the old refresh token is dead after one use, the new one works once', async () => {
    const http = fakeWithSeed();
    const first = await refreshAccessToken(http, p);
    await expect(refreshAccessToken(http, p)).rejects.toMatchObject({
      name: 'AuthError',
      message: SHOPIFY_RECONNECT_MESSAGE,
    });
    const second = await refreshAccessToken(http, { ...p, refreshToken: first.refreshToken });
    expect(second.refreshToken).toBe('shprt_abc_2');
    expect(http.presentedRefreshTokens).toEqual([
      'shprt_seed_token',
      'shprt_seed_token',
      'shprt_abc_1',
    ]);
  });
  it('treats a 401 as final with the fixed reconnect text, and a 403 the same', async () => {
    for (const status of [401, 403]) {
      const http = fakeWithSeed();
      http.failNext(status);
      await expect(refreshAccessToken(http, p)).rejects.toMatchObject({
        name: 'AuthError',
        message: 'Shopify no longer accepts this connection. Reconnect the store.',
      });
    }
  });
  it('maps retryable failures and honours retry-after', async () => {
    const cases: [number, new (...a: never[]) => Error][] = [
      [429, RateLimitedError],
      [500, TransientError],
      [503, TransientError],
      [400, PermanentError],
      [404, PermanentError],
    ];
    for (const [status, type] of cases) {
      const http = fakeWithSeed();
      http.failNext(status);
      await expect(refreshAccessToken(http, p)).rejects.toBeInstanceOf(type);
    }
    const http = fakeWithSeed();
    http.failNext(429, { 'retry-after': '3' });
    await expect(refreshAccessToken(http, p)).rejects.toMatchObject({ retryAfterMs: 3000 });
  });
  it('a transient failure consumes nothing: the SAME refresh token still works afterwards', async () => {
    const http = fakeWithSeed();
    http.failNext(503);
    await expect(refreshAccessToken(http, p)).rejects.toBeInstanceOf(TransientError);
    await expect(refreshAccessToken(http, p)).resolves.toMatchObject({
      refreshToken: 'shprt_abc_1',
    });
    expect(http.presentedRefreshTokens).toEqual(['shprt_seed_token']);
  });
  it.each([
    ['not JSON', 'oops'],
    ['no refresh token', JSON.stringify({ access_token: 'shpat_x', scope: '', expires_in: 3600 })],
    ['a non-expiring answer', JSON.stringify({ access_token: 'shpat_x', scope: '' })],
  ])(
    'rejects an unreadable or incomplete answer (%s) with a fixed message',
    async (_name, body) => {
      const http = fakeWithSeed();
      http.respondNext({ status: 200, body });
      await expect(refreshAccessToken(http, p)).rejects.toMatchObject({
        name: 'PermanentError',
        message: 'Shopify returned an unreadable token response',
      });
    },
  );
  it('rejects an invalid shop before any request', async () => {
    const http = fakeWithSeed();
    await expect(refreshAccessToken(http, { ...p, shop: 'evil.com' })).rejects.toBeInstanceOf(
      PermanentError,
    );
    expect(http.requests).toHaveLength(0);
  });
  it('never puts the secret or any token in an error message', async () => {
    for (const status of [400, 401, 403, 429, 500, 503]) {
      const http = fakeWithSeed();
      http.failNext(status);
      const err = (await refreshAccessToken(http, p).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      for (const secret of ['s3cret', 'shprt_seed_token', 'shpat_abc', 'shprt_abc']) {
        expect(err.message).not.toContain(secret);
      }
    }
    const rotated = fakeWithSeed();
    await refreshAccessToken(rotated, p);
    const err = (await refreshAccessToken(rotated, p).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(AuthError);
    for (const secret of ['s3cret', 'shprt_seed_token', 'shprt_abc_1', 'shpat_abc_1']) {
      expect(err.message).not.toContain(secret);
    }
  });
});
