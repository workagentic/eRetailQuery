import { NextResponse, type NextRequest } from 'next/server';
import type { ShopifyCallbackResponse } from '@erq/shared';
import { ApiRequestError, apiFetch } from '@/lib/api';
import {
  connectionsPathFromApiRedirect,
  loginPathForCallback,
  rawQueryFromSearch,
} from '@/lib/shopify-callback';

// The query carries Shopify's code, state and signature: never log it, and keep it out of Referer headers.
function redirectTo(request: NextRequest, path: string): NextResponse {
  const res = NextResponse.redirect(`${request.nextUrl.origin}${path}`);
  res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
}

export async function GET(request: NextRequest) {
  const search = request.nextUrl.search;
  const query = rawQueryFromSearch(search);
  if (query === null) return redirectTo(request, '/connections?shopify_error=invalid_request');
  try {
    const res = await apiFetch<ShopifyCallbackResponse>('/connections/shopify/callback', {
      method: 'POST',
      body: JSON.stringify({ query }),
    });
    const path =
      connectionsPathFromApiRedirect(res.redirectTo) ?? '/connections?shopify_error=server_error';
    return redirectTo(request, path);
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 401) {
      return redirectTo(request, loginPathForCallback(search));
    }
    return redirectTo(request, '/connections?shopify_error=server_error');
  }
}
