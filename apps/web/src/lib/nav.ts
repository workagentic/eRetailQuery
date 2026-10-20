export type NavIcon = 'dashboard' | 'products' | 'ads' | 'inventory' | 'reports' | 'connections' | 'team';

export interface NavLink {
  href: string;
  label: string;
  icon: NavIcon;
}

/**
 * The report pages read the database directly and exist only in demo mode (docs/demo.md); outside it the
 * app keeps its API-backed pages. Team and Connections need the API, so demo mode hides them.
 */
export function mainNav(demo: boolean): NavLink[] {
  return demo
    ? [
        { href: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
        { href: '/products', label: 'Products', icon: 'products' },
        { href: '/ads', label: 'Ads', icon: 'ads' },
        { href: '/inventory', label: 'Inventory', icon: 'inventory' },
        { href: '/reports', label: 'Profit & loss', icon: 'reports' },
      ]
    : [
        { href: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
        { href: '/connections', label: 'Connections', icon: 'connections' },
        { href: '/team', label: 'Team', icon: 'team' },
      ];
}
