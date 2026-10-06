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
    expect(sanitizeMessage('x'.repeat(2000)).length).toBe(500);
    expect(sanitizeMessage(new Error('boom'))).toBe('boom');
    expect(sanitizeMessage({ a: 1 })).toBe('[object Object]');
    expect(sanitizeMessage(undefined)).toBe('undefined');
  });
});
