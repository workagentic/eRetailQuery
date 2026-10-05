import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { MeResponse, OrgSummary } from '@erq/shared';
import { apiFetch, ORG_COOKIE } from './api';

export async function loadAppContext(): Promise<{ me: MeResponse; active: OrgSummary }> {
  const me = await apiFetch<MeResponse>('/me');
  const first = me.orgs[0];
  if (!first) redirect('/onboarding');
  const saved = (await cookies()).get(ORG_COOKIE)?.value;
  const active = me.orgs.find((o) => o.orgId === saved) ?? first;
  return { me, active };
}

export const orgCookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  secure: process.env.NODE_ENV === 'production',
};
