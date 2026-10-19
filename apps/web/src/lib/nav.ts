export interface NavLink {
  href: string;
  label: string;
}

/**
 * The report pages read the database directly and exist only in demo mode (docs/demo.md); outside it the
 * app keeps its API-backed pages. Team and Connections need the API, so demo mode hides them.
 */
export function mainNav(demo: boolean): NavLink[] {
  return demo
    ? [
        { href: '/dashboard', label: 'Dashboard' },
        { href: '/products', label: 'Products' },
        { href: '/ads', label: 'Ads' },
        { href: '/inventory', label: 'Inventory' },
        { href: '/reports', label: 'Profit & loss' },
      ]
    : [
        { href: '/dashboard', label: 'Dashboard' },
        { href: '/connections', label: 'Connections' },
        { href: '/team', label: 'Team' },
      ];
}
