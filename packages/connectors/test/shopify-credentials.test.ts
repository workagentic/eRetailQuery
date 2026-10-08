import { describe, expect, it } from 'vitest';
import {
  AuthError,
  credentialExpiry,
  credentialsFromGrant,
  readExpiringCredentials,
  type ShopifyTokenGrant,
} from '../src';

const NOW = new Date('2026-10-08T12:00:00.000Z');
const expiring: ShopifyTokenGrant = {
  accessToken: 'shpat_a',
  scopes: ['read_orders'],
  accessTokenExpiresInSec: 3600,
  refreshToken: 'shprt_a',
  refreshTokenExpiresInSec: 7776000,
};

describe('credentialsFromGrant', () => {
  it('stores absolute ISO expiry times for an expiring grant and never the scopes', () => {
    expect(credentialsFromGrant(expiring, NOW)).toEqual({
      accessToken: 'shpat_a',
      accessTokenExpiresAt: '2026-10-08T13:00:00.000Z',
      refreshToken: 'shprt_a',
      refreshTokenExpiresAt: '2027-01-06T12:00:00.000Z',
    });
  });
  it('stores only the access token for a non-expiring grant', () => {
    const grant = {
      ...expiring,
      accessTokenExpiresInSec: null,
      refreshToken: null,
      refreshTokenExpiresInSec: null,
    };
    expect(credentialsFromGrant(grant, NOW)).toEqual({ accessToken: 'shpat_a' });
  });
});

describe('credentialExpiry', () => {
  it('mirrors the two times as dates, and nulls for the old shape', () => {
    expect(credentialExpiry(credentialsFromGrant(expiring, NOW))).toEqual({
      accessTokenExpiresAt: new Date('2026-10-08T13:00:00.000Z'),
      refreshTokenExpiresAt: new Date('2027-01-06T12:00:00.000Z'),
    });
    expect(credentialExpiry({ accessToken: 'shpat_old' })).toEqual({
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    });
  });
});

describe('readExpiringCredentials', () => {
  it('returns null for the old shape and for values that are not credentials', () => {
    expect(readExpiringCredentials({ accessToken: 'shpat_old' })).toBeNull();
    for (const raw of [null, undefined, 'x', 5, [], {}])
      expect(readExpiringCredentials(raw)).toBeNull();
  });
  it('reads a complete expiring set with real dates', () => {
    expect(readExpiringCredentials(credentialsFromGrant(expiring, NOW))).toEqual({
      accessToken: 'shpat_a',
      accessTokenExpiresAt: new Date('2026-10-08T13:00:00.000Z'),
      refreshToken: 'shprt_a',
      refreshTokenExpiresAt: new Date('2027-01-06T12:00:00.000Z'),
    });
  });
  it.each([
    ['a refresh token without times', { accessToken: 'shpat_a', refreshToken: 'shprt_secret_1' }],
    [
      'a time without a refresh token',
      { accessToken: 'shpat_a', accessTokenExpiresAt: '2026-10-08T13:00:00.000Z' },
    ],
    [
      'a bad date',
      {
        accessToken: 'shpat_a',
        accessTokenExpiresAt: 'soon',
        refreshToken: 'shprt_secret_2',
        refreshTokenExpiresAt: '2027-01-06T12:00:00.000Z',
      },
    ],
    [
      'a missing access token',
      {
        accessTokenExpiresAt: '2026-10-08T13:00:00.000Z',
        refreshToken: 'shprt_secret_3',
        refreshTokenExpiresAt: '2027-01-06T12:00:00.000Z',
      },
    ],
  ])('throws a fixed AuthError for %s and echoes no value', (_name, raw) => {
    let caught: unknown;
    try {
      readExpiringCredentials(raw);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AuthError);
    expect((caught as Error).message).toBe('Stored credentials are unusable. Reconnect the store.');
  });
});
