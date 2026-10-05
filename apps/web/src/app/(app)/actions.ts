'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { uuidSchema, type MeResponse } from '@erq/shared';
import { apiFetch, ORG_COOKIE } from '@/lib/api';
import { orgCookieOptions } from '@/lib/app-context';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function switchOrgAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get('orgId') ?? '');
  if (!uuidSchema.safeParse(orgId).success) return;
  const me = await apiFetch<MeResponse>('/me');
  if (!me.orgs.some((o) => o.orgId === orgId)) return; // never trust the posted id
  (await cookies()).set(ORG_COOKIE, orgId, orgCookieOptions);
  redirect('/dashboard');
}

export async function signOutAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  (await cookies()).delete(ORG_COOKIE);
  redirect('/login');
}
