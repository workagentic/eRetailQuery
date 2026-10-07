'use server';

import type { InstallResponse, SyncNowResponse } from '@erq/shared';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch, ApiRequestError } from '@/lib/api';
import { loadAppContext } from '@/lib/app-context';
import { isShopifyAuthorizeUrl } from '@/lib/connections';

export async function startShopifyInstall(
  _prev: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string }> {
  const shop = formData.get('shop');
  if (typeof shop !== 'string' || shop.trim() === '') {
    return { error: 'Enter your Shopify store address.' };
  }
  let authorizeUrl: string;
  try {
    const { active } = await loadAppContext();
    const res = await apiFetch<InstallResponse>(
      `/orgs/${active.orgId}/connections/shopify/install`,
      { method: 'POST', orgId: active.orgId, body: JSON.stringify({ shop: shop.trim() }) },
    );
    authorizeUrl = res.authorizeUrl;
  } catch (e) {
    return {
      error:
        e instanceof ApiRequestError
          ? e.message
          : 'Could not start the connection. Please try again.',
    };
  }
  if (!isShopifyAuthorizeUrl(authorizeUrl)) {
    return { error: 'Shopify returned an unexpected address, so we stopped. Please try again.' };
  }
  // redirect() throws, so it must stay outside the try block.
  redirect(authorizeUrl);
}

export async function disconnectConnection(formData: FormData): Promise<void> {
  const id = formData.get('id');
  if (typeof id !== 'string' || id === '') redirect('/connections?shopify_error=disconnect_failed');
  const { active } = await loadAppContext();
  let failed = false;
  try {
    await apiFetch(`/orgs/${active.orgId}/connections/${encodeURIComponent(id)}/disconnect`, {
      method: 'POST',
      orgId: active.orgId,
    });
  } catch {
    failed = true;
  }
  if (failed) redirect('/connections?shopify_error=disconnect_failed');
  revalidatePath('/connections');
}

export interface SyncNowState {
  error?: string;
  started?: boolean;
}

const SYNC_FAILED = 'We could not start the import. Please try again.';

// 409 (connection not active) and 503 (imports not available) carry plain API messages worth showing.
export async function syncNowAction(
  _prev: SyncNowState | undefined,
  formData: FormData,
): Promise<SyncNowState> {
  const id = formData.get('id');
  if (typeof id !== 'string' || id === '') return { error: SYNC_FAILED };
  // Outside the try so a redirect for an unauthenticated user is not swallowed.
  const { active } = await loadAppContext();
  try {
    const res = await apiFetch<SyncNowResponse>(
      `/orgs/${active.orgId}/connections/${encodeURIComponent(id)}/sync`,
      { method: 'POST', orgId: active.orgId },
    );
    revalidatePath('/connections');
    return { started: res.started };
  } catch (e) {
    if (e instanceof ApiRequestError && (e.status === 409 || e.status === 503)) {
      // The connection's state changed under the page; refresh it so the page shows the truth.
      revalidatePath('/connections');
      return { error: e.message };
    }
    return { error: SYNC_FAILED };
  }
}
