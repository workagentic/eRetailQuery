// packages/connectors/test/shopify-hmac.test.ts
import { describe, expect, it } from 'vitest';
import {
  buildAuthorizeUrl,
  parseWebhookHeaders,
  verifyOAuthQuery,
  verifyWebhookSignature,
} from '../src';
import { signOAuthQuery, signWebhook } from '../src/testing';

const SECRET = 'hush';
const NOW = new Date('2026-10-07T12:00:00Z');
const ts = (d: Date) => String(Math.floor(d.getTime() / 1000));
const params = (): Record<string, string> => ({
  code: 'c0de',
  shop: 'a.myshopify.com',
  state: 'n0nce',
  timestamp: ts(NOW),
  host: 'YWRtaW4=',
});

describe('verifyOAuthQuery', () => {
  it('accepts a correctly signed, fresh query (parameter order does not matter)', () => {
    const q = signOAuthQuery(params(), SECRET);
    const reversed = Object.fromEntries(Object.entries(q).reverse());
    expect(verifyOAuthQuery(reversed, SECRET, { now: NOW })).toBe(true);
  });
  it('rejects tampering, the wrong secret, a missing or malformed hmac and repeated parameters', () => {
    const q = signOAuthQuery(params(), SECRET);
    expect(verifyOAuthQuery({ ...q, code: 'other' }, SECRET, { now: NOW })).toBe(false);
    expect(verifyOAuthQuery(q, 'wrong', { now: NOW })).toBe(false);
    const noHmac: Record<string, string | undefined> = { ...q, hmac: undefined };
    expect(verifyOAuthQuery(noHmac, SECRET, { now: NOW })).toBe(false);
    expect(verifyOAuthQuery({ ...q, shop: ['a.myshopify.com', 'b'] }, SECRET, { now: NOW })).toBe(
      false,
    );
    expect(verifyOAuthQuery({ ...q, hmac: 'zz' }, SECRET, { now: NOW })).toBe(false);
    expect(verifyOAuthQuery({ ...q, hmac: q.hmac!.slice(0, -2) }, SECRET, { now: NOW })).toBe(
      false,
    );
  });
  it('rejects stale, far-future and missing timestamps', () => {
    const old = signOAuthQuery(
      { ...params(), timestamp: ts(new Date(NOW.getTime() - 3600_000)) },
      SECRET,
    );
    expect(verifyOAuthQuery(old, SECRET, { now: NOW })).toBe(false);
    const future = signOAuthQuery(
      { ...params(), timestamp: ts(new Date(NOW.getTime() + 3600_000)) },
      SECRET,
    );
    expect(verifyOAuthQuery(future, SECRET, { now: NOW })).toBe(false);
    const noTs: Record<string, string> = params();
    delete noTs.timestamp;
    expect(verifyOAuthQuery(signOAuthQuery(noTs, SECRET), SECRET, { now: NOW })).toBe(false);
  });
});

describe('verifyWebhookSignature', () => {
  const body = '{"id":1,"note":"héllo"}';
  it('accepts a signature over the exact bytes (string or Buffer)', () => {
    const sig = signWebhook(body, SECRET);
    expect(verifyWebhookSignature(body, sig, SECRET)).toBe(true);
    expect(verifyWebhookSignature(Buffer.from(body), sig, SECRET)).toBe(true);
  });
  it('rejects a changed body, another secret, and missing or malformed headers', () => {
    const sig = signWebhook(body, SECRET);
    expect(verifyWebhookSignature(body + ' ', sig, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, signWebhook(body, 'other'), SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, '', SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, 'not base64 !!', SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, sig.slice(0, -4), SECRET)).toBe(false);
  });
});

describe('parseWebhookHeaders', () => {
  const ok = {
    'X-Shopify-Topic': 'orders/updated',
    'x-shopify-shop-domain': 'a.myshopify.com',
    'X-SHOPIFY-WEBHOOK-ID': 'abc-123',
    'x-shopify-event-id': 'evt-1',
  };
  it('reads headers case-insensitively', () => {
    expect(parseWebhookHeaders(ok)).toEqual({
      topic: 'orders/updated',
      shop: 'a.myshopify.com',
      webhookId: 'abc-123',
      eventId: 'evt-1',
    });
  });
  it('returns null when a required header is missing or the shop is invalid', () => {
    expect(parseWebhookHeaders({ ...ok, 'x-shopify-shop-domain': 'evil.com' })).toBeNull();
    const noTopic: Record<string, string> = { ...ok };
    delete noTopic['X-Shopify-Topic'];
    expect(parseWebhookHeaders(noTopic)).toBeNull();
    expect(parseWebhookHeaders({ ...ok, 'X-SHOPIFY-WEBHOOK-ID': '' })).toBeNull();
  });
});

describe('buildAuthorizeUrl', () => {
  it('builds the documented authorize URL', () => {
    const u = new URL(
      buildAuthorizeUrl({
        shop: 'a.myshopify.com',
        apiKey: 'k',
        scopes: ['read_orders', 'read_products'],
        redirectUri: 'https://api.example.com/connections/shopify/callback',
        state: 'n',
      }),
    );
    expect(u.origin + u.pathname).toBe('https://a.myshopify.com/admin/oauth/authorize');
    expect(u.searchParams.get('client_id')).toBe('k');
    expect(u.searchParams.get('scope')).toBe('read_orders,read_products');
    expect(u.searchParams.get('redirect_uri')).toBe(
      'https://api.example.com/connections/shopify/callback',
    );
    expect(u.searchParams.get('state')).toBe('n');
  });
  it('refuses an invalid shop', () => {
    expect(() =>
      buildAuthorizeUrl({
        shop: 'evil.com',
        apiKey: 'k',
        scopes: ['x'],
        redirectUri: 'https://x.test',
        state: 'n',
      }),
    ).toThrow(RangeError);
  });
});
