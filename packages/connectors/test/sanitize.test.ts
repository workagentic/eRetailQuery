import { describe, expect, it } from 'vitest';
import { sanitizeMessage } from '../src';

describe('sanitizeMessage', () => {
  it('redacts Shopify tokens, bearer tokens and secret-looking key=value pairs', () => {
    const out = sanitizeMessage(
      'failed shpat_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE with Bearer abc.def-ghi and access_token=xyz client_secret: s3cr3t',
    );
    expect(out).not.toMatch(/shpat_|abc\.def|xyz|s3cr3t/);
    expect(out).toContain('[redacted]');
  });
  it('drops URL query strings and fragments', () => {
    expect(sanitizeMessage('GET https://a.myshopify.com/admin?code=abc&hmac=def#frag failed')).toBe(
      'GET https://a.myshopify.com/admin?[redacted] failed',
    );
  });
  it('redacts long opaque tokens but keeps ordinary words and uuids', () => {
    const uuid = '3b241101-e2bb-4255-8caf-4136c566a962';
    const out = sanitizeMessage(`run ${uuid} used ${'A'.repeat(40)}`);
    expect(out).toContain(uuid);
    expect(out).not.toContain('A'.repeat(40));
  });
  it('caps the length, accepts non-strings and never throws', () => {
    expect(sanitizeMessage('word '.repeat(500)).length).toBe(500);
    expect(
      sanitizeMessage({
        message: {
          toString: () => {
            throw new Error('x');
          },
        },
      }),
    ).toBeTypeOf('string');
    expect(sanitizeMessage(new Error('boom'))).toBe('boom');
    expect(sanitizeMessage({ a: 1 })).toBe('[object Object]');
    expect(sanitizeMessage(undefined)).toBe('undefined');
  });
  it('redacts JSON-style and quoted secrets', () => {
    const json = sanitizeMessage('{"access_token":"abc","client_secret": "s3cr3t", "code":"q1"}');
    expect(json).not.toMatch(/abc|s3cr3t|q1/);
    const quoted = sanitizeMessage('password: "two words" then ok');
    expect(quoted).not.toMatch(/two|words/);
    expect(quoted).toContain('then ok');
    expect(sanitizeMessage("token='a b c' end")).not.toMatch(/a b c/);
  });
  it('redacts access_token inside a URL query, base64 bearers and hex hmacs', () => {
    expect(sanitizeMessage('GET /x?access_token=abc123 failed')).not.toContain('abc123');
    expect(sanitizeMessage('Authorization: Bearer YWJjZGVm+/ghi==')).not.toContain('YWJjZGVm');
    const hmac = 'a1b2c3d4'.repeat(8);
    expect(sanitizeMessage(`bad ${hmac} sig`)).not.toContain(hmac);
  });
  it('redacts long opaque runs regardless of case', () => {
    expect(sanitizeMessage('A'.repeat(40))).not.toContain('AAAA');
    expect(sanitizeMessage('a'.repeat(40))).not.toContain('aaaa');
  });
  it('redacts uppercase Shopify token prefixes', () => {
    expect(sanitizeMessage('SHPAT_0123abc')).not.toMatch(/SHPAT_0123/);
  });
  it('redacts refresh tokens by prefix and by key, using the real values', () => {
    const short = 'shprt_0123456789abcdef'; // too short for the long-token rule: only the prefix rule can catch it
    const out = sanitizeMessage(
      `refresh failed ${short} refresh_token=plainvalue1 {"refresh_token":"jsonvalue2"} refresh_token: colon3`,
    );
    for (const secret of [short, 'plainvalue1', 'jsonvalue2', 'colon3']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('[redacted]');
  });
});
