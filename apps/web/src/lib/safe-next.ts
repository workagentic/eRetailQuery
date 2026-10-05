const BASE = 'http://local.invalid';

/** Returns a same-site path for post-login redirects, or the fallback. Never returns an off-site URL. */
export function safeNextPath(next: string | null | undefined, fallback = '/dashboard'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\'))
    return fallback;
  try {
    // The URL parser strips tabs/newlines, so "/\t/evil.com" would become "//evil.com"; the origin check catches that.
    const url = new URL(next, BASE);
    if (url.origin !== BASE) return fallback;
    return url.pathname + url.search;
  } catch {
    return fallback;
  }
}
