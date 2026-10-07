import { SHOPIFY_ERROR_CODES } from '@erq/shared';

const MAX_QUERY = 4096;
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The query exactly as received (Shopify's signature is verified over it, so never decode or re-encode). */
export function rawQueryFromSearch(search: string): string | null {
  const q = search.startsWith('?') ? search.slice(1) : search;
  if (q === '' || q.length > MAX_QUERY || CONTROL.test(q)) return null;
  return q;
}

/** Maps the API's redirectTo to a same-site `/connections?...` path built only from whitelisted pairs. */
export function connectionsPathFromApiRedirect(redirectTo: string): string | null {
  let url: URL;
  try {
    url = new URL(redirectTo);
  } catch {
    return null;
  }
  if (url.pathname !== '/connections') return null;
  const kept = new URLSearchParams();
  let error: string | null = null;
  for (const [key, value] of url.searchParams) {
    if (key === 'shopify' && value === 'connected') kept.set('shopify', value);
    else if (key === 'warning' && value === 'webhooks') kept.set('warning', value);
    else if (key === 'shopify_error' && (SHOPIFY_ERROR_CODES as readonly string[]).includes(value))
      error = value;
  }
  if (error !== null) return `/connections?${new URLSearchParams({ shopify_error: error })}`;
  const out = kept.toString();
  return out === '' ? null : `/connections?${out}`;
}

export function loginPathForCallback(search: string): string {
  return `/login?next=${encodeURIComponent(`/connections/shopify/callback${search}`)}`;
}
