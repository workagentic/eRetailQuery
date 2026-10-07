import { describe, expect, it } from 'vitest';
import { SHOPIFY_ERROR_CODES, type ConnectionDto } from '@erq/shared';
import {
  connectionsErrorMessage,
  describeConnection,
  isShopifyAuthorizeUrl,
  shopifyErrorMessage,
  shopifyWarningMessage,
  suggestShopDomain,
} from './connections';

const NOW = new Date('2026-10-07T12:00:00Z');
const conn = (over: Partial<ConnectionDto> = {}): ConnectionDto => ({
  id: 'c1',
  platform: 'shopify',
  shop: 'a.myshopify.com',
  status: 'active',
  lastSyncedAt: null,
  lastError: null,
  ...over,
});

describe('shopifyErrorMessage', () => {
  it('returns plain English for every known code and a generic message for unknown ones', () => {
    for (const code of SHOPIFY_ERROR_CODES) {
      const m = shopifyErrorMessage(code)!;
      expect(m.length).toBeGreaterThan(10);
      expect(m).not.toContain(code);
    }
    expect(shopifyErrorMessage('<script>alert(1)</script>')).toBe(
      shopifyErrorMessage('something_else'),
    );
    expect(shopifyErrorMessage('<script>alert(1)</script>')).not.toContain('<script>');
    expect(shopifyErrorMessage('constructor')).toBe(shopifyErrorMessage('something_else'));
    expect(shopifyErrorMessage(undefined)).toBeNull();
  });
  it('has exact messages for the account-binding codes', () => {
    expect(shopifyErrorMessage('wrong_account')).toBe(
      'This connection was started from a different account. Sign in with the account that started it, or start again.',
    );
    expect(shopifyErrorMessage('not_allowed')).toBe('Only an owner or admin can connect a store.');
  });
  it('explains the webhook warning', () => {
    expect(shopifyWarningMessage('webhooks')).toMatch(/Reconnect/);
    expect(shopifyWarningMessage(undefined)).toBeNull();
    expect(shopifyWarningMessage('other')).toBeNull();
  });
});

describe('describeConnection', () => {
  it('maps statuses to plain labels, tones and reconnect options', () => {
    expect(describeConnection(conn(), NOW)).toMatchObject({
      label: 'Connected',
      tone: 'ok',
      canReconnect: false,
    });
    expect(
      describeConnection(conn({ lastError: 'Webhook setup failed. Reconnect to retry.' }), NOW),
    ).toMatchObject({ label: 'Needs attention', tone: 'warn', canReconnect: true });
    expect(
      describeConnection(
        conn({ status: 'error', lastError: 'Stored credentials could not be read.' }),
        NOW,
      ),
    ).toMatchObject({ label: 'Needs attention', tone: 'warn', canReconnect: true });
    expect(describeConnection(conn({ status: 'disconnected' }), NOW)).toMatchObject({
      label: 'Disconnected',
      tone: 'muted',
      canReconnect: true,
    });
    expect(describeConnection(conn({ status: 'pending' }), NOW)).toMatchObject({
      label: 'Setting up',
      tone: 'muted',
    });
    expect(describeConnection(conn({ status: 'demo' }), NOW)).toMatchObject({
      label: 'Demo data',
      tone: 'muted',
    });
  });
  it('says when it last synced', () => {
    expect(describeConnection(conn(), NOW).detail).toContain('never');
    expect(
      describeConnection(conn({ lastSyncedAt: '2026-10-07T11:55:00Z' }), NOW).detail,
    ).toContain('5 minutes ago');
    expect(
      describeConnection(conn({ lastSyncedAt: '2026-10-05T12:00:00Z' }), NOW).detail,
    ).toContain('2 days ago');
  });
});

describe('connectionsErrorMessage', () => {
  it('has a disconnect message and falls back to the shopify map', () => {
    expect(connectionsErrorMessage('disconnect_failed')).toBe(
      'We could not disconnect that store. Please try again.',
    );
    expect(connectionsErrorMessage('state_expired')).toBe(shopifyErrorMessage('state_expired'));
    expect(connectionsErrorMessage('nope')).toBe(shopifyErrorMessage('nope'));
    expect(connectionsErrorMessage(undefined)).toBeNull();
  });
});

describe('describeConnection details', () => {
  it('formats relative times exactly', () => {
    const at = (iso: string) => describeConnection(conn({ lastSyncedAt: iso }), NOW).detail;
    expect(at('2026-10-07T11:59:30Z')).toBe('Last synced just now');
    expect(at('2026-10-07T11:59:00Z')).toBe('Last synced 1 minute ago');
    expect(at('2026-10-07T09:00:00Z')).toBe('Last synced 3 hours ago');
    expect(at('2026-10-06T12:00:00Z')).toBe('Last synced 1 day ago');
    expect(at('not a date')).toBe('Last synced never');
  });
  it('shows the error text then the last synced text for warn states', () => {
    const synced = '2026-10-07T11:55:00Z';
    expect(
      describeConnection(conn({ lastError: 'Webhook setup failed.', lastSyncedAt: synced }), NOW)
        .detail,
    ).toBe('Webhook setup failed. Last synced 5 minutes ago');
    expect(describeConnection(conn({ status: 'error', lastError: null }), NOW).detail).toBe(
      'Something went wrong with this connection. Last synced never',
    );
    expect(describeConnection(conn({ status: 'error', lastError: 'Bad token.' }), NOW).detail).toBe(
      'Bad token. Last synced never',
    );
  });
  it('does not offer reconnect for pending or demo', () => {
    expect(describeConnection(conn({ status: 'pending' }), NOW).canReconnect).toBe(false);
    expect(describeConnection(conn({ status: 'demo' }), NOW).canReconnect).toBe(false);
  });
});

describe('suggestShopDomain', () => {
  it.each([
    ['my-store', 'my-store.myshopify.com', true],
    ['  My-Store.myshopify.com  ', 'my-store.myshopify.com', true],
    ['https://my-store.myshopify.com/admin', 'my-store.myshopify.com', true],
    ['http://my-store.myshopify.com/', 'my-store.myshopify.com', true],
    ['evil.com', 'evil.com', false],
    ['a b', 'a b.myshopify.com', false],
    ['', '', false],
    ['https://my-store.myshopify.com/admin?x=1#y', 'my-store.myshopify.com', true],
    ['HTTPS://My-Store.MyShopify.com/Admin', 'my-store.myshopify.com', true],
    ['a-', 'a-.myshopify.com', false],
    ['a'.repeat(63), `${'a'.repeat(63)}.myshopify.com`, true],
    ['a'.repeat(64), `${'a'.repeat(64)}.myshopify.com`, false],
  ])('suggests %j as %j (valid: %s)', (input, value, valid) => {
    expect(suggestShopDomain(input)).toEqual({ value, valid });
  });
});

describe('isShopifyAuthorizeUrl', () => {
  it('accepts only https URLs on a myshopify.com host', () => {
    expect(isShopifyAuthorizeUrl('https://a.myshopify.com/admin/oauth/authorize?x=1')).toBe(true);
    expect(isShopifyAuthorizeUrl('http://a.myshopify.com/admin')).toBe(false);
    expect(isShopifyAuthorizeUrl('https://evil.com/a.myshopify.com')).toBe(false);
    expect(isShopifyAuthorizeUrl('https://a.myshopify.com.evil.com/')).toBe(false);
    expect(isShopifyAuthorizeUrl('https://a.myshopify.com@evil.com/')).toBe(false);
    expect(isShopifyAuthorizeUrl('//a.myshopify.com')).toBe(false);
    expect(isShopifyAuthorizeUrl('javascript:alert(1)')).toBe(false);
    expect(isShopifyAuthorizeUrl(undefined)).toBe(false);
    expect(isShopifyAuthorizeUrl('https://a.myshopify.com:8443/x')).toBe(false);
    expect(isShopifyAuthorizeUrl('https://evil.com/?a=.myshopify.com')).toBe(false);
    expect(isShopifyAuthorizeUrl('https://user:pw@a.myshopify.com/x')).toBe(false);
    // URL parsing lowercases the host, so an uppercase host is the same safe host.
    expect(isShopifyAuthorizeUrl('https://A.myshopify.com/x')).toBe(true);
  });
});
