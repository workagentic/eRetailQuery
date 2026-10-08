// The shape of the encrypted Shopify credentials blob (AAD `connection:<id>`). Old connections store only
// { accessToken }; those never expire and are never refreshed.
import { z } from 'zod';
import { AuthError } from '../errors';
import type { ShopifyTokenGrant } from './token';

export interface StoredShopifyCredentials {
  accessToken: string;
  accessTokenExpiresAt?: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
}

export interface ExpiringCredentials {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

const atSeconds = (now: Date, seconds: number): string =>
  new Date(now.getTime() + seconds * 1000).toISOString();

/** What to encrypt after an exchange or a refresh. Without all three expiry fields the token is stored as non-expiring. */
export function credentialsFromGrant(
  grant: ShopifyTokenGrant,
  now: Date,
): StoredShopifyCredentials {
  if (
    grant.accessTokenExpiresInSec === null ||
    grant.refreshToken === null ||
    grant.refreshTokenExpiresInSec === null
  ) {
    return { accessToken: grant.accessToken };
  }
  return {
    accessToken: grant.accessToken,
    accessTokenExpiresAt: atSeconds(now, grant.accessTokenExpiresInSec),
    refreshToken: grant.refreshToken,
    refreshTokenExpiresAt: atSeconds(now, grant.refreshTokenExpiresInSec),
  };
}

/** The two non-secret times that are mirrored into plain columns so SQL can find aging tokens. */
export function credentialExpiry(c: StoredShopifyCredentials): {
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
} {
  return {
    accessTokenExpiresAt: c.accessTokenExpiresAt ? new Date(c.accessTokenExpiresAt) : null,
    refreshTokenExpiresAt: c.refreshTokenExpiresAt ? new Date(c.refreshTokenExpiresAt) : null,
  };
}

const expiringSchema = z.object({
  accessToken: z.string().min(1),
  accessTokenExpiresAt: z.string().datetime(),
  refreshToken: z.string().min(1),
  refreshTokenExpiresAt: z.string().datetime(),
});
const MARKERS = ['accessTokenExpiresAt', 'refreshToken', 'refreshTokenExpiresAt'] as const;

/**
 * An expiring token set, or null when the value is not one (the old `{ accessToken }` shape, another
 * platform's blob, null). A set that is only partly there is corrupt: AuthError with a FIXED message
 * (never the values).
 */
export function readExpiringCredentials(raw: unknown): ExpiringCredentials | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!MARKERS.some((k) => k in record)) return null;
  const parsed = expiringSchema.safeParse(record);
  if (!parsed.success) throw new AuthError('Stored credentials are unusable. Reconnect the store.');
  return {
    accessToken: parsed.data.accessToken,
    accessTokenExpiresAt: new Date(parsed.data.accessTokenExpiresAt),
    refreshToken: parsed.data.refreshToken,
    refreshTokenExpiresAt: new Date(parsed.data.refreshTokenExpiresAt),
  };
}
