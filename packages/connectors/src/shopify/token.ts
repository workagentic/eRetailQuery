// https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
import { z } from 'zod';
import { AuthError, PermanentError, RateLimitedError, TransientError } from '../errors';
import { isValidShopDomain } from './domain';
import type { HttpClient } from './http';

const tokenBody = z.object({ access_token: z.string().min(1), scope: z.string().default('') });

export async function exchangeCodeForToken(
  http: HttpClient,
  p: { shop: string; apiKey: string; apiSecret: string; code: string },
): Promise<{ accessToken: string; scopes: string[] }> {
  if (!isValidShopDomain(p.shop)) throw new PermanentError('Invalid shop domain');
  const res = await http.request({
    method: 'POST',
    url: `https://${p.shop}/admin/oauth/access_token`,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: p.apiKey, client_secret: p.apiSecret, code: p.code }),
  });
  if (res.status === 401 || res.status === 403)
    throw new AuthError('Shopify rejected the app credentials');
  if (res.status === 429) {
    const seconds = Number(res.headers['retry-after']);
    throw new RateLimitedError(Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 2000);
  }
  if (res.status >= 500) throw new TransientError('Shopify is temporarily unavailable');
  if (res.status !== 200) throw new PermanentError('Shopify rejected the authorization code');
  let parsed: z.infer<typeof tokenBody>;
  try {
    parsed = tokenBody.parse(JSON.parse(res.body));
  } catch {
    throw new PermanentError('Shopify returned an unreadable token response');
  }
  return {
    accessToken: parsed.access_token,
    scopes: parsed.scope
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
