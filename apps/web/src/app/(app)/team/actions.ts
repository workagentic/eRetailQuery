'use server';

import { createInviteInput, type CreatedInviteDto } from '@erq/shared';
import { apiFetch, ApiRequestError } from '@/lib/api';
import { loadAppContext } from '@/lib/app-context';

export interface InviteState {
  error?: string;
  acceptUrl?: string;
}

export async function createInviteAction(
  _prev: InviteState,
  formData: FormData,
): Promise<InviteState> {
  const parsed = createInviteInput.safeParse({
    email: formData.get('email'),
    role: formData.get('role'),
  });
  if (!parsed.success) return { error: 'Enter a valid email and choose a role.' };
  const { active } = await loadAppContext();
  try {
    const invite = await apiFetch<CreatedInviteDto>(`/orgs/${active.orgId}/invites`, {
      method: 'POST',
      orgId: active.orgId,
      body: JSON.stringify(parsed.data),
    });
    return { acceptUrl: invite.acceptUrl };
  } catch (e) {
    return { error: e instanceof ApiRequestError ? e.message : 'Could not create the invite.' };
  }
}
