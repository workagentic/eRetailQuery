'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createOrgInput, type OrgSummary } from '@erq/shared';
import { apiFetch, ApiRequestError, ORG_COOKIE } from '@/lib/api';
import { orgCookieOptions } from '@/lib/app-context';

export interface FormState {
  error?: string;
}

export async function createOrgAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = createOrgInput.safeParse({ name: formData.get('name') });
  if (!parsed.success) return { error: 'Enter your business name (2 to 100 characters).' };
  let org: OrgSummary;
  try {
    org = await apiFetch<OrgSummary>('/orgs', {
      method: 'POST',
      body: JSON.stringify(parsed.data),
    });
  } catch (e) {
    return {
      error: e instanceof ApiRequestError ? e.message : 'Something went wrong. Please try again.',
    };
  }
  (await cookies()).set(ORG_COOKIE, org.orgId, orgCookieOptions);
  redirect('/dashboard');
}
