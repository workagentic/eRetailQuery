import { describe, expect, it } from 'vitest';
import { safeNextPath } from './safe-next';

describe('safeNextPath', () => {
  it.each([
    ['/dashboard', '/dashboard'],
    ['/invite/abc_DEF-123', '/invite/abc_DEF-123'],
    ['/team?tab=members', '/team?tab=members'],
  ])('keeps same-site path %j', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });

  it.each([
    '//evil.com',
    '///evil.com',
    'https://evil.com',
    'http://evil.com/x',
    'javascript:alert(1)',
    '/\\evil.com',
    '\\\\evil.com',
    '/\t/evil.com',
    '/\n/evil.com',
    '/\r/evil.com',
    'evil.com',
    ' //evil.com',
    '',
  ])('falls back for %j', (input) => {
    expect(safeNextPath(input)).toBe('/dashboard');
  });

  it.each(['/..//evil.com', '/.//evil.com', '/a/..//evil.com', '/%2e%2e//evil.com'])(
    'falls back when dot-segments normalise to a scheme-relative path: %j',
    (input) => {
      expect(safeNextPath(input)).toBe('/dashboard');
    },
  );

  it.each([
    ['/a/../b', '/b'],
    ['/dashboard?next=//x', '/dashboard?next=//x'],
  ])('keeps normalised same-site path %j', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });

  it('never returns a result starting with // or containing a backslash', () => {
    const attacks = [
      '//evil.com',
      '/..//evil.com',
      '/.//evil.com',
      '/a/..//evil.com',
      '/%2e%2e//evil.com',
      '/%2e//evil.com',
      '/./\t/evil.com',
      '/a/../\n/evil.com',
      '/\\evil.com',
      '/a/..\\evil.com',
      '/%5cevil.com',
      '/..///evil.com',
      '/a/b/../../..//evil.com',
      'https://evil.com',
      '/;//evil.com/../..//x',
    ];
    for (const x of attacks) {
      const out = safeNextPath(x);
      expect(out.startsWith('//'), x).toBe(false);
      expect(out.includes('\\'), x).toBe(false);
    }
  });

  it('falls back for null and undefined, and honours a custom fallback', () => {
    expect(safeNextPath(null)).toBe('/dashboard');
    expect(safeNextPath(undefined, '/home')).toBe('/home');
  });
});
