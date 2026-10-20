'use client';

import {
  Boxes,
  LayoutDashboard,
  Megaphone,
  Package,
  Plug,
  Receipt,
  Users,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { NavIcon, NavLink } from '@/lib/nav';

const ICONS: Record<NavIcon, LucideIcon> = {
  dashboard: LayoutDashboard,
  products: Package,
  ads: Megaphone,
  inventory: Boxes,
  reports: Receipt,
  connections: Plug,
  team: Users,
};

/** The main navigation. Client-side only to highlight the page you are on. */
export function NavLinks({ links }: { links: NavLink[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {links.map((l) => {
        const Icon = ICONS[l.icon];
        const active = path === l.href || path.startsWith(`${l.href}/`);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? 'page' : undefined}
            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              active
                ? 'bg-brand/15 text-white shadow-[inset_3px_0_0_var(--color-brand)]'
                : 'text-ink-muted hover:bg-white/5 hover:text-white'
            }`}
          >
            <Icon aria-hidden="true" className="size-[18px] shrink-0" strokeWidth={1.75} />
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
