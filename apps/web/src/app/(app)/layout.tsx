import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { loadAppContext } from '@/lib/app-context';
import { isDemoMode } from '@/lib/demo-mode';
import { mainNav } from '@/lib/nav';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const { me, active } = await loadAppContext();
  const demo = isDemoMode();
  return (
    <AppShell links={mainNav(demo)} orgs={me.orgs} active={active} email={me.user.email} demo={demo}>
      {children}
    </AppShell>
  );
}
