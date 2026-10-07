import { describe, expect, it } from 'vitest';
import { SHOPIFY_ERROR_CODES, type ConnectionDto, type ConnectionSyncDto } from '@erq/shared';
import {
  connectionsErrorMessage,
  describeConnection,
  describeSync,
  STALE_AFTER_MS,
  isShopifyAuthorizeUrl,
  shopifyErrorMessage,
  shopifyWarningMessage,
  suggestShopDomain,
} from './connections';

const NOW = new Date('2026-10-07T12:00:00Z');
const sync = (over: Partial<ConnectionSyncDto> = {}): ConnectionSyncDto => ({
  state: 'idle',
  resource: null,
  recordsProcessed: 0,
  coveredFrom: null,
  historyLimited: false,
  error: null,
  canStart: true,
  ...over,
});
const conn = (over: Partial<ConnectionDto> = {}): ConnectionDto => ({
  id: 'c1',
  platform: 'shopify',
  shop: 'a.myshopify.com',
  status: 'active',
  lastSyncedAt: null,
  lastError: null,
  sync: sync(),
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

describe('describeSync', () => {
  const FIVE_MIN_AGO = '2026-10-07T11:55:00Z';
  const ACTIVE = { status: 'active', lastError: null } as const;
  const d = (
    s: Partial<ConnectionSyncDto>,
    last: string | null = null,
    c: Parameters<typeof describeSync>[3] = ACTIVE,
  ) => describeSync(sync(s), last, NOW, c);

  it('says what is importing, with a thousands separator, and blocks a second start', () => {
    expect(d({ state: 'running', resource: 'orders', recordsProcessed: 1200 })).toEqual({
      headline: 'Importing orders, 1,200 so far',
      detail: null,
      tone: 'muted',
      canSync: false,
    });
    expect(d({ state: 'running', resource: 'inventory', recordsProcessed: 3 }).headline).toBe(
      'Importing stock levels, 3 so far',
    );
    expect(d({ state: 'running', resource: 'products', recordsProcessed: 5 }).headline).toBe(
      'Importing products, 5 so far',
    );
    expect(d({ state: 'running', resource: 'locations', recordsProcessed: 1 }).headline).toBe(
      'Importing locations, 1 so far',
    );
    expect(d({ state: 'running', resource: null }).headline).toBe('Importing your data, 0 so far');
    expect(d({ state: 'running', resource: 'mystery', recordsProcessed: 2 }).headline).toBe(
      'Importing your data, 2 so far',
    );
    expect(d({ state: 'running', resource: 'orders', recordsProcessed: 1234567 }).headline).toBe(
      'Importing orders, 1,234,567 so far',
    );
  });

  it('says plainly that a failed import stopped, where, and why', () => {
    expect(d({ state: 'failed', resource: 'orders', error: 'Shopify rate limit hit.' })).toEqual({
      headline: 'Import stopped',
      detail: 'Stopped while importing orders. Shopify rate limit hit.',
      tone: 'warn',
      canSync: true,
    });
    expect(d({ state: 'failed', resource: 'orders', error: 'No full stop' }).detail).toBe(
      'Stopped while importing orders. No full stop.',
    );
    expect(d({ state: 'failed', resource: 'products', error: null }).detail).toBe(
      'Stopped while importing products. Try Sync now.',
    );
    expect(d({ state: 'failed', resource: null, error: null }).detail).toBe(
      'Stopped while importing your data. Try Sync now.',
    );
    expect(d({ state: 'failed', resource: 'orders', error: 'Boom.' }, FIVE_MIN_AGO).detail).toBe(
      'Stopped while importing orders. Boom. Last successful sync 5 minutes ago.',
    );
    expect(d({ state: 'failed', canStart: false }).canSync).toBe(false);
  });

  it('shows when the last import finished instead of claiming to be up to date', () => {
    expect(d({ state: 'idle' }, FIVE_MIN_AGO)).toEqual({
      headline: 'Last import finished 5 minutes ago',
      detail: null,
      tone: 'ok',
      canSync: true,
    });
    expect(d({ state: 'idle', canStart: false }, FIVE_MIN_AGO).canSync).toBe(false);
  });

  it('warns when the last import is more than two days old, and not at exactly two days', () => {
    expect(STALE_AFTER_MS).toBe(2 * 24 * 60 * 60 * 1000);
    const exactly = new Date(NOW.getTime() - STALE_AFTER_MS).toISOString();
    const justOver = new Date(NOW.getTime() - STALE_AFTER_MS - 1000).toISOString();
    expect(d({ state: 'idle' }, exactly)).toMatchObject({
      headline: 'Last import finished 2 days ago',
      detail: null,
      tone: 'ok',
    });
    expect(d({ state: 'idle' }, justOver)).toEqual({
      headline: 'Last import finished 2 days ago',
      detail: 'This may be out of date. Try Sync now.',
      tone: 'warn',
      canSync: true,
    });
  });

  it('treats an idle connection that never recorded a sync as not imported', () => {
    expect(d({ state: 'idle' }, null)).toMatchObject({
      headline: 'Not imported yet',
      detail: 'Press Sync now to start.',
    });
    expect(d({ state: 'idle' }, 'not a date').headline).toBe('Not imported yet');
  });

  it('says never imported, and why Sync now is unavailable for every status', () => {
    expect(d({ state: 'never', canStart: true })).toEqual({
      headline: 'Not imported yet',
      detail: 'Press Sync now to start.',
      tone: 'muted',
      canSync: true,
    });
    expect(d({ state: 'never', canStart: false })).toEqual({
      headline: 'Not imported yet',
      detail: 'Importing is not available on this server yet.',
      tone: 'muted',
      canSync: false,
    });
    const pending = d({ state: 'never', canStart: true }, null, {
      status: 'pending',
      lastError: null,
    });
    expect(pending.detail).toBe('Waiting for the connection to finish setting up.');
    expect(pending.canSync).toBe(false);
    const demo = d({ state: 'never', canStart: true }, null, { status: 'demo', lastError: null });
    expect(demo.detail).toBe('This is sample data, so there is nothing to import.');
    expect(demo.canSync).toBe(false);
  });

  it('tells the owner how far back the orders go and why not further', () => {
    expect(d({ state: 'idle', coveredFrom: '2026-10-09T03:00:00Z' }, FIVE_MIN_AGO).detail).toBe(
      'Showing orders from Oct 9, 2026.',
    );
    expect(
      d({ state: 'idle', coveredFrom: '2026-08-01T00:00:00Z', historyLimited: true }, FIVE_MIN_AGO)
        .detail,
    ).toBe(
      "Showing orders from Aug 1, 2026. Older history needs Shopify's approval to read all orders.",
    );
    expect(
      d({ state: 'running', resource: 'orders', coveredFrom: '2026-08-01T00:00:00Z' }).detail,
    ).toBe('Showing orders from Aug 1, 2026.');
  });

  it('ignores a coveredFrom that is not a date', () => {
    expect(d({ state: 'idle', coveredFrom: 'garbage' }, FIVE_MIN_AGO).detail).toBeNull();
  });

  it('does not call a connection in error up to date, even when the import looks idle', () => {
    expect(
      d({ state: 'idle' }, FIVE_MIN_AGO, { status: 'error', lastError: 'Bad token.' }),
    ).toEqual({
      headline: 'Not up to date',
      detail: 'Bad token. Last synced 5 minutes ago.',
      tone: 'warn',
      canSync: true,
    });
    expect(d({ state: 'never' }, null, { status: 'error', lastError: 'Bad token' })).toMatchObject({
      headline: 'Not imported yet',
      detail: 'Bad token. Not synced yet.',
      tone: 'warn',
    });
    expect(d({ state: 'idle' }, FIVE_MIN_AGO, { status: 'error', lastError: null }).detail).toBe(
      'Something went wrong with this connection. Last synced 5 minutes ago.',
    );
  });

  it('keeps a failed import message ahead of the connection error', () => {
    expect(
      d({ state: 'failed', resource: 'orders', error: 'Boom.' }, null, {
        status: 'error',
        lastError: 'Bad token.',
      }).detail,
    ).toBe('Stopped while importing orders. Boom.');
  });

  it('cannot sync a connection that is not connected', () => {
    for (const status of ['disconnected', 'pending', 'demo'] as const) {
      expect(d({ state: 'never' }, null, { status, lastError: null }).canSync).toBe(false);
    }
    expect(
      d({ state: 'idle' }, FIVE_MIN_AGO, { status: 'disconnected', lastError: null }),
    ).toMatchObject({
      headline: 'Not connected',
      detail: 'Reconnect this store to import your data.',
      tone: 'muted',
      canSync: false,
    });
  });
});
