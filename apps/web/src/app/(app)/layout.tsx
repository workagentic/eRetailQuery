import { Button } from '@erq/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { OrgSwitcher } from '@/components/org-switcher';
import { DemoBanner } from '@/components/demo-banner';
import { loadAppContext } from '@/lib/app-context';
import { isDemoMode } from '@/lib/demo-mode';
import { mainNav } from '@/lib/nav';
import { signOutAction } from './actions';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const { me, active } = await loadAppContext();
  const demo = isDemoMode();
  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3">
          <span className="font-semibold">eRetailQuery</span>
          <nav aria-label="Main" className="flex gap-4 text-sm">
            {mainNav(demo).map((l) => (
              <Link key={l.href} href={l.href}>
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <OrgSwitcher orgs={me.orgs} activeId={active.orgId} />
            <form action={signOutAction}>
              <Button variant="ghost" size="sm" type="submit">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>
      {demo && <DemoBanner />}
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
