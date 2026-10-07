import { describe, expect, it } from 'vitest';
import { verifyOAuthRawQuery } from '../src';
import { signOAuthRawQuery } from '../src/testing';

const SECRET = 'hush';
const NOW = new Date('2026-10-08T12:00:00Z');
const ts = String(Math.floor(NOW.getTime() / 1000));
const params = (): Record<string, string> => ({
  code: 'c0de',
  host: 'YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvYQ==',
  shop: 'a.myshopify.com',
  state: 'n0nce',
  timestamp: ts,
});

describe('verifyOAuthRawQuery', () => {
  it.each(['encoded', 'decoded'] as const)('accepts a query signed over the %s values', (mode) => {
    const raw = signOAuthRawQuery(params(), SECRET, mode);
    expect(raw).toContain('host=YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvYQ%3D%3D');
    expect(verifyOAuthRawQuery(raw, SECRET, { now: NOW })).toBe(true);
    expect(verifyOAuthRawQuery(`?${raw}`, SECRET, { now: NOW })).toBe(true);
  });
  it('does not depend on parameter order', () => {
    const raw = signOAuthRawQuery(params(), SECRET, 'encoded');
    const [hmac, ...rest] = raw.split('&').reverse();
    expect(verifyOAuthRawQuery([hmac, ...rest].join('&'), SECRET, { now: NOW })).toBe(true);
  });
  it('rejects tampering, another secret, a missing or malformed hmac', () => {
    const raw = signOAuthRawQuery(params(), SECRET, 'encoded');
    expect(verifyOAuthRawQuery(raw.replace('c0de', 'other'), SECRET, { now: NOW })).toBe(false);
    expect(verifyOAuthRawQuery(raw, 'wrong', { now: NOW })).toBe(false);
    expect(verifyOAuthRawQuery(raw.replace(/&hmac=[0-9a-f]+$/, ''), SECRET, { now: NOW })).toBe(
      false,
    );
    expect(
      verifyOAuthRawQuery(raw.replace(/hmac=[0-9a-f]+$/, 'hmac=zz'), SECRET, { now: NOW }),
    ).toBe(false);
    expect(
      verifyOAuthRawQuery(raw.replace(/hmac=[0-9a-f]{2}/, 'hmac=00'), SECRET, { now: NOW }),
    ).toBe(false);
  });
  it('rejects repeated keys (also when one is percent-encoded), pairs without = and empty or oversize input', () => {
    const raw = signOAuthRawQuery(params(), SECRET, 'encoded');
    expect(verifyOAuthRawQuery(`${raw}&shop=b.myshopify.com`, SECRET, { now: NOW })).toBe(false);
    expect(verifyOAuthRawQuery(`${raw}&%73hop=b.myshopify.com`, SECRET, { now: NOW })).toBe(false);
    expect(verifyOAuthRawQuery(`${raw}&flag`, SECRET, { now: NOW })).toBe(false);
    expect(verifyOAuthRawQuery('', SECRET, { now: NOW })).toBe(false);
    expect(verifyOAuthRawQuery('?', SECRET, { now: NOW })).toBe(false);
    expect(verifyOAuthRawQuery(`${raw}&pad=${'x'.repeat(5000)}`, SECRET, { now: NOW })).toBe(false);
  });
  it('enforces the timestamp window (stale, far future, missing, non-numeric)', () => {
    const old = String(Math.floor(NOW.getTime() / 1000) - 3600);
    const future = String(Math.floor(NOW.getTime() / 1000) + 3600);
    expect(
      verifyOAuthRawQuery(signOAuthRawQuery({ ...params(), timestamp: old }, SECRET), SECRET, {
        now: NOW,
      }),
    ).toBe(false);
    expect(
      verifyOAuthRawQuery(signOAuthRawQuery({ ...params(), timestamp: future }, SECRET), SECRET, {
        now: NOW,
      }),
    ).toBe(false);
    const noTs = params();
    delete (noTs as Partial<Record<string, string>>).timestamp;
    expect(verifyOAuthRawQuery(signOAuthRawQuery(noTs, SECRET), SECRET, { now: NOW })).toBe(false);
    expect(
      verifyOAuthRawQuery(signOAuthRawQuery({ ...params(), timestamp: 'abc' }, SECRET), SECRET, {
        now: NOW,
      }),
    ).toBe(false);
  });
});
