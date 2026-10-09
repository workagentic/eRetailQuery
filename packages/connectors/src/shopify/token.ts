// https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
// https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens
//   (expiring=1 on the code exchange; refresh with grant_type=refresh_token; every refresh rotates both tokens)
// Unverified against a real shop (checked in the docs on 2026-10-08): see docs/shopify-connection.md.
import { z } from 'zod';
import { AuthError, PermanentError, RateLimitedError, TransientError } from '../errors';
import { isValidShopDomain } from './domain';
import type { HttpClient } from './http';

/** Shown to the owner when Shopify refuses to refresh the token (final: reconnecting is the only fix). */
export const SHOPIFY_RECONNECT_MESSAGE =
  'Shopify no longer accepts this connection. Reconnect the store.';

const UNREADABLE = 'Shopify returned an unreadable token response';

const tokenBody = z.object({
  access_token: z.string().min(1),
  scope: z.string().default(''),
  expires_in: z.number().int().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  refresh_token_expires_in: z.number().int().positive().optional(),
});

export interface ShopifyTokenGrant {
  accessToken: string;
  scopes: string[];
  /** Seconds the access token lives; null for a non-expiring token. */
  accessTokenExpiresInSec: number | null;
  refreshToken: string | null;
  refreshTokenExpiresInSec: number | null;
}
/** A refresh always returns a complete, rotated pair. */
export interface ShopifyRefreshGrant extends ShopifyTokenGrant {
  accessTokenExpiresInSec: number;
  refreshToken: string;
  refreshTokenExpiresInSec: number;
}

interface TokenRequest {
  shop: string;
  form: Record<string, string>;
  /** Message for a 401 or 403. */
  authMessage: string;
  /** Message for any other non-200 answer. */
  rejectedMessage: string;
  /** A refresh must return all three expiry fields. */
  requireExpiring: boolean;
}

async function requestToken(http: HttpClient, p: TokenRequest): Promise<ShopifyTokenGrant> {
  if (!isValidShopDomain(p.shop)) throw new PermanentError('Invalid shop domain');
  const res = await http.request({
    method: 'POST',
    url: `https://${p.shop}/admin/oauth/access_token`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(p.form).toString(),
  });
  if (res.status === 401 || res.status === 403) throw new AuthError(p.authMessage);
  if (res.status === 429) {
    // Blank, non-numeric or negative values count as missing (Number('') would be 0).
    const raw = res.headers['retry-after']?.trim() ?? '';
    const seconds = raw === '' ? NaN : Number(raw);
    throw new RateLimitedError(Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 2000);
  }
  if (res.status >= 500) throw new TransientError('Shopify is temporarily unavailable');
  if (res.status !== 200) throw new PermanentError(p.rejectedMessage);
  let parsed: z.infer<typeof tokenBody>;
  try {
    parsed = tokenBody.parse(JSON.parse(res.body));
  } catch {
    throw new PermanentError(UNREADABLE);
  }
  // All three expiry fields or none: a half-described token cannot be refreshed safely.
  const present = [parsed.expires_in, parsed.refresh_token, parsed.refresh_token_expires_in].filter(
    (v) => v !== undefined,
  ).length;
  if (present !== 0 && present !== 3) throw new PermanentError(UNREADABLE);
  if (p.requireExpiring && present !== 3) throw new PermanentError(UNREADABLE);
  return {
    accessToken: parsed.access_token,
    scopes: parsed.scope
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    accessTokenExpiresInSec: parsed.expires_in ?? null,
    refreshToken: parsed.refresh_token ?? null,
    refreshTokenExpiresInSec: parsed.refresh_token_expires_in ?? null,
  };
}

export function exchangeCodeForToken(
  http: HttpClient,
  p: { shop: string; apiKey: string; apiSecret: string; code: string },
): Promise<ShopifyTokenGrant> {
  return requestToken(http, {
    shop: p.shop,
    form: { client_id: p.apiKey, client_secret: p.apiSecret, code: p.code, expiring: '1' },
    authMessage: 'Shopify rejected the app credentials',
    rejectedMessage: 'Shopify rejected the authorization code',
    requireExpiring: false,
  });
}

/**
 * Exchanges a refresh token for a NEW access token AND a NEW refresh token (rotation): the presented
 * refresh token is dead afterwards, so the caller must persist the returned pair atomically and must
 * never call this twice with the same token (packages/sync/src/tokens.ts does it under a row lock).
 * A 401 is final (unknown, replaced, expired, revoked or uninstalled all look the same); network
 * errors, timeouts, 5xx and 429 are retryable with the SAME refresh token because Shopify never
 * consumed it.
 */
export async function refreshAccessToken(
  http: HttpClient,
  p: { shop: string; apiKey: string; apiSecret: string; refreshToken: string },
): Promise<ShopifyRefreshGrant> {
  const grant = await requestToken(http, {
    shop: p.shop,
    form: {
      client_id: p.apiKey,
      client_secret: p.apiSecret,
      grant_type: 'refresh_token',
      refresh_token: p.refreshToken,
    },
    authMessage: SHOPIFY_RECONNECT_MESSAGE,
    rejectedMessage: 'Shopify rejected the refresh request',
    requireExpiring: true,
  });
  // requireExpiring guarantees the three fields; checking narrows the type without a cast.
  if (
    grant.accessTokenExpiresInSec === null ||
    grant.refreshToken === null ||
    grant.refreshTokenExpiresInSec === null
  ) {
    throw new PermanentError(UNREADABLE);
  }
  return {
    ...grant,
    accessTokenExpiresInSec: grant.accessTokenExpiresInSec,
    refreshToken: grant.refreshToken,
    refreshTokenExpiresInSec: grant.refreshTokenExpiresInSec,
  };
}
