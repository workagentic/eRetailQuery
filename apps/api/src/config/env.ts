import { z } from 'zod';
import { DEFAULT_SHOPIFY_SCOPES } from '@erq/connectors';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().url(),
    WEB_PUBLIC_URL: z.string().url(),
    SUPABASE_JWT_ISSUER: z.string().url(),
    SUPABASE_JWKS_URL: z.string().url().optional(),
    SUPABASE_JWT_SECRET: z.string().min(1).optional(),
    LOG_LEVEL: z.string().default('info'),
    API_PUBLIC_URL: z.string().url().optional(),
    REDIS_URL: z.string().min(1).optional(),
    ENCRYPTION_KEY_ID: z.string().min(1).optional(),
    ENCRYPTION_KEY: z.string().min(1).optional(),
    ENCRYPTION_OLD_KEYS: z.string().min(1).optional(),
    SHOPIFY_API_KEY: z.string().min(1).optional(),
    SHOPIFY_API_SECRET: z.string().min(1).optional(),
    SHOPIFY_SCOPES: z.string().default(DEFAULT_SHOPIFY_SCOPES.join(',')),
  })
  .refine((v) => v.SUPABASE_JWKS_URL || v.SUPABASE_JWT_SECRET, {
    message: 'Set SUPABASE_JWKS_URL or SUPABASE_JWT_SECRET',
  });

export type Env = z.infer<typeof schema>;

/** Empty strings (e.g. `FOO=` in .env) are treated as unset. */
export function loadEnv(raw: Record<string, string | undefined>): Env {
  const cleaned = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v !== undefined && v !== ''),
  );
  return schema.parse(cleaned);
}
