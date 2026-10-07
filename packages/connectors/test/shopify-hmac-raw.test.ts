import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyOAuthRawQuery } from '../src';
import { signOAuthRawQuery, signRawPairs } from '../src/testing';

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
    const wrong = createHmac('sha256', SECRET).update('something else').digest('hex');
    expect(
      verifyOAuthRawQuery(raw.replace(/hmac=[0-9a-f]+$/, `hmac=${wrong}`), SECRET, { now: NOW }),
    ).toBe(false);
  });
  const basePairs = (): string[] =>
    Object.entries(params()).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  const signedWith = (extra: string[], mode: 'encoded' | 'decoded') =>
    signRawPairs([...basePairs(), ...extra], SECRET, mode);

  it.each(['encoded', 'decoded'] as const)(
    'rejects, even when correctly signed (%s): repeated keys, pairs without =, empty key, malformed escapes, oversize input',
    (mode) => {
      const bad = (extra: string[]) =>
        verifyOAuthRawQuery(signedWith(extra, mode), SECRET, { now: NOW });
      expect(bad(['shop=b.myshopify.com'])).toBe(false);
      expect(bad(['%73hop=b.myshopify.com'])).toBe(false);
      expect(bad(['%68mac=' + 'a'.repeat(64)])).toBe(false);
      expect(bad(['flag'])).toBe(false);
      expect(bad(['=x'])).toBe(false);
      expect(bad(['pad=%zz'])).toBe(false);
      expect(bad([`pad=${'x'.repeat(5000)}`])).toBe(false);
      expect(verifyOAuthRawQuery('', SECRET, { now: NOW })).toBe(false);
      expect(verifyOAuthRawQuery('?', SECRET, { now: NOW })).toBe(false);
      // sanity: the same signing path with a harmless extra pair is accepted
      expect(bad(['extra=1'])).toBe(true);
    },
  );
  it('rejects a 63-character hmac and accepts an uppercase 64-hex hmac (same as the object form)', () => {
    const raw = signOAuthRawQuery(params(), SECRET, 'encoded');
    expect(
      verifyOAuthRawQuery(raw.replace(/hmac=([0-9a-f]{63})[0-9a-f]$/, 'hmac=$1'), SECRET, {
        now: NOW,
      }),
    ).toBe(false);
    const upper = raw.replace(/hmac=([0-9a-f]+)$/, (_m, h: string) => `hmac=${h.toUpperCase()}`);
    expect(verifyOAuthRawQuery(upper, SECRET, { now: NOW })).toBe(true);
  });
  it('accepts a + in a value signed over the encoded form', () => {
    const raw = signRawPairs([...basePairs(), 'note=a+b'], SECRET, 'encoded');
    expect(verifyOAuthRawQuery(raw, SECRET, { now: NOW })).toBe(true);
    // signed over the decoded form ("a b"), the + decodes to a space and also verifies
    expect(
      verifyOAuthRawQuery(signRawPairs([...basePairs(), 'note=a+b'], SECRET, 'decoded'), SECRET, {
        now: NOW,
      }),
    ).toBe(true);
  });
  it('does not let a decoded signature be reused after folding a pair into another value', () => {
    const signed = signRawPairs(
      ['shop=a.myshopify.com', 'state=n0nce', `timestamp=${ts}`],
      SECRET,
      'decoded',
    );
    expect(verifyOAuthRawQuery(signed, SECRET, { now: NOW })).toBe(true);
    const hmac = signed.split('&').pop();
    const folded = `shop=a.myshopify.com%26state%3Dn0nce&timestamp=${ts}&${hmac}`;
    expect(verifyOAuthRawQuery(folded, SECRET, { now: NOW })).toBe(false);
    const folded2 = `shop=a.myshopify.com%26state=n0nce&timestamp=${ts}&${hmac}`;
    expect(verifyOAuthRawQuery(folded2, SECRET, { now: NOW })).toBe(false);
  });
  it('still verifies an encoded-mode query whose decoded value contains & or =', () => {
    const raw = signOAuthRawQuery({ ...params(), note: 'a&b=c' }, SECRET, 'encoded');
    expect(raw).toContain('note=a%26b%3Dc');
    expect(verifyOAuthRawQuery(raw, SECRET, { now: NOW })).toBe(true);
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
