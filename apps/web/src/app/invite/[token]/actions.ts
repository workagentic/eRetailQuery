'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiFetch, ApiRequestError, ORG_COOKIE } from '@/lib/api';
import { orgCookieOptions } from '@/lib/app-context';

export interface AcceptState {
  error?: string;
}

export async function acceptInviteAction(token: string): Promise<AcceptState> {
  try {
    const { orgId } = await apiFetch<{ orgId: string }>(
      `/invites/${encodeURIComponent(token)}/accept`,
      { method: 'POST' },
    );
    (await cookies()).set(ORG_COOKIE, orgId, orgCookieOptions);
  } catch (e) {
    if (e instanceof ApiRequestError) return { error: e.message };
    return { error: 'Could not accept the invite. Please try again.' };
  }
  redirect('/dashboard');
}
