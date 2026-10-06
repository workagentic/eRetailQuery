import { describe, expect, it } from 'vitest';
import type { ConnectionDto } from '@erq/shared';
import {
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
    for (const code of [
      'invalid_request',
      'state_expired',
      'shop_mismatch',
      'shop_in_use',
      'exchange_failed',
      'not_configured',
      'server_error',
    ]) {
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

describe('suggestShopDomain', () => {
  it.each([
    ['my-store', 'my-store.myshopify.com', true],
    ['  My-Store.myshopify.com  ', 'my-store.myshopify.com', true],
    ['https://my-store.myshopify.com/admin', 'my-store.myshopify.com', true],
    ['http://my-store.myshopify.com/', 'my-store.myshopify.com', true],
    ['evil.com', 'evil.com', false],
    ['a b', 'a b.myshopify.com', false],
    ['', '', false],
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
  });
});
