'use server';

import type { InstallResponse } from '@erq/shared';
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
  const { active } = await loadAppContext();
  let authorizeUrl: string;
  try {
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
  if (typeof id !== 'string' || id === '') redirect('/connections?shopify_error=server_error');
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
  if (failed) redirect('/connections?shopify_error=server_error');
  revalidatePath('/connections');
}
