import { describe, expect, it } from 'vitest';
import { isValidShopDomain, normalizeShopInput } from '../src';

describe('isValidShopDomain', () => {
  it.each([
    'my-store.myshopify.com',
    'a.myshopify.com',
    'store123.myshopify.com',
    '0-x.myshopify.com',
  ])('accepts %s', (s) => expect(isValidShopDomain(s)).toBe(true));
  it.each([
    '',
    'myshopify.com',
    '.myshopify.com',
    '-x.myshopify.com',
    'evil.com/.myshopify.com',
    'a.myshopify.com.evil.com',
    'a.myshopify.com/path',
    'a.myshopify.com:8080',
    'user@a.myshopify.com',
    'a.myshopify.com.',
    'A.myshopify.com',
    'a b.myshopify.com',
    'a..myshopify.com',
    'sub.a.myshopify.com',
    'a.myshopify.co',
    'ａ.myshopify.com',
    'xn--a.myshopify.com\n',
    `${'a'.repeat(250)}.myshopify.com`,
  ])('rejects %j', (s) => expect(isValidShopDomain(s)).toBe(false));
  it('normalizes only case and surrounding whitespace', () => {
    expect(normalizeShopInput('  My-Store.MyShopify.com ')).toBe('my-store.myshopify.com');
    expect(normalizeShopInput('https://a.myshopify.com')).toBe('https://a.myshopify.com');
  });
});
