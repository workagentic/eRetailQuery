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

  it('falls back for null and undefined, and honours a custom fallback', () => {
    expect(safeNextPath(null)).toBe('/dashboard');
    expect(safeNextPath(undefined, '/home')).toBe('/home');
  });
});
