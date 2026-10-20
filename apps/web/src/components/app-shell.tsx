import type { OrgSummary } from '@erq/shared';
import { LogOut, Menu, TrendingUp } from 'lucide-react';
import type { ReactNode } from 'react';
import { signOutAction } from '@/app/(app)/actions';
import type { NavLink } from '@/lib/nav';
import { DemoBanner } from './demo-banner';
import { NavLinks } from './nav-links';
import { OrgSwitcher } from './org-switcher';

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid size-8 place-items-center rounded-lg bg-brand text-white">
        <TrendingUp aria-hidden="true" className="size-[18px]" strokeWidth={2.25} />
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-white">eRetailQuery</span>
    </div>
  );
}

function Account({ email, orgName }: { email: string; orgName: string }) {
  return (
    <div className="flex flex-col gap-3 border-t border-ink-line pt-4">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-white">{orgName}</div>
        <div className="truncate text-xs text-ink-muted">{email}</div>
      </div>
      <form action={signOutAction}>
        <button
          type="submit"
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink-muted transition-colors hover:bg-white/5 hover:text-white"
        >
          <LogOut aria-hidden="true" className="size-4" strokeWidth={1.75} />
          Sign out
        </button>
      </form>
    </div>
  );
}

/** Dark sidebar on large screens, a menu drawer (no JavaScript) on small ones. */
export function AppShell({
  links,
  orgs,
  active,
  email,
  demo,
  children,
}: {
  links: NavLink[];
  orgs: OrgSummary[];
  active: OrgSummary;
  email: string;
  demo: boolean;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col justify-between bg-ink p-4 lg:flex">
        <div className="flex flex-col gap-8">
          <div className="px-1 pt-1">
            <Brand />
          </div>
          <NavLinks links={links} />
        </div>
        <Account email={email} orgName={active.name} />
      </aside>

      <header className="sticky top-0 z-20 bg-ink text-white lg:hidden">
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 [&::-webkit-details-marker]:hidden">
            <Brand />
            <span className="grid size-9 place-items-center rounded-lg border border-ink-line">
              <Menu aria-hidden="true" className="size-5" />
              <span className="sr-only">Menu</span>
            </span>
          </summary>
          <div className="flex flex-col gap-6 border-t border-ink-line p-4">
            <NavLinks links={links} />
            <Account email={email} orgName={active.name} />
          </div>
        </details>
      </header>

      <div className="lg:pl-64">
        {demo && <DemoBanner />}
        <main className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 sm:px-8 sm:py-8">
          {orgs.length > 1 && (
            <div className="flex justify-end">
              <OrgSwitcher orgs={orgs} activeId={active.orgId} />
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}
