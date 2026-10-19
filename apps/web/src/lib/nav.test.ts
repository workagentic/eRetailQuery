import { describe, expect, it } from 'vitest';
import { mainNav } from './nav';

describe('mainNav', () => {
  it('shows the report pages and hides API-backed pages in demo mode', () => {
    const hrefs = mainNav(true).map((l) => l.href);
    expect(hrefs).toEqual(['/dashboard', '/products', '/ads', '/inventory', '/reports']);
  });
  it('does not link to the database-backed report pages outside demo mode', () => {
    const hrefs = mainNav(false).map((l) => l.href);
    expect(hrefs).toEqual(['/dashboard', '/connections', '/team']);
  });
});
