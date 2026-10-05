// Supabase JWT docs: https://supabase.com/docs/guides/auth/jwts (verify key type for your project before launch)
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type KeyLike } from 'jose';
import { uuidSchema } from '@erq/shared';
import { ApiError } from '../common/api-error';
import type { Env } from '../config/env';

export const JWT_VERIFIER = Symbol('JWT_VERIFIER');

export interface VerifiedUser {
  userId: string;
  email: string;
}
export interface JwtVerifier {
  verify(token: string): Promise<VerifiedUser>;
}

export function createJoseVerifier(opts: {
  key: JWTVerifyGetKey | Uint8Array | KeyLike;
  issuer: string;
  algorithms: string[];
}): JwtVerifier {
  const options = {
    issuer: opts.issuer,
    audience: 'authenticated',
    algorithms: opts.algorithms,
    requiredClaims: ['exp', 'sub'],
  };
  return {
    async verify(token) {
      try {
        const { payload } =
          typeof opts.key === 'function'
            ? await jwtVerify(token, opts.key, options)
            : await jwtVerify(token, opts.key, options);
        if (
          !uuidSchema.safeParse(payload.sub).success ||
          typeof payload.email !== 'string' ||
          payload.email.trim() === '' ||
          payload.is_anonymous === true
        ) {
          throw new Error('missing or invalid claims');
        }
        return { userId: payload.sub as string, email: payload.email.toLowerCase() };
      } catch {
        throw new ApiError(401, 'unauthenticated', 'Invalid or expired token');
      }
    },
  };
}

export function buildVerifierFromEnv(env: Env): JwtVerifier {
  if (env.SUPABASE_JWKS_URL) {
    return createJoseVerifier({
      key: createRemoteJWKSet(new URL(env.SUPABASE_JWKS_URL)),
      issuer: env.SUPABASE_JWT_ISSUER,
      algorithms: ['ES256', 'RS256'],
    });
  }
  if (!env.SUPABASE_JWT_SECRET)
    throw new Error('SUPABASE_JWKS_URL or SUPABASE_JWT_SECRET is required');
  return createJoseVerifier({
    key: new TextEncoder().encode(env.SUPABASE_JWT_SECRET),
    issuer: env.SUPABASE_JWT_ISSUER,
    algorithms: ['HS256'],
  });
}
