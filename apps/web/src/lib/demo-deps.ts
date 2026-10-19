import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createAccountApi } from '@erq/db';
import { ORG_COOKIE } from './api';
import { getTenantDb } from './db';
import type { DemoContextDeps } from './demo-context';
import { createSupabaseServerClient } from './supabase/server';

export const demoDeps: DemoContextDeps = {
  async getUser() {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user ? { id: user.id, email: user.email ?? '' } : null;
  },
  listOrgs: (userId) => createAccountApi(getTenantDb().pool).listUserOrgs(userId),
  savedOrgId: async () => (await cookies()).get(ORG_COOKIE)?.value,
  redirect: (path) => redirect(path),
};
