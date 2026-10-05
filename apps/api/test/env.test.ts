import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  WEB_PUBLIC_URL: 'http://localhost:3000',
  SUPABASE_JWT_ISSUER: 'http://localhost:54321/auth/v1',
};

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv({ ...base, SUPABASE_JWT_SECRET: 's' });
    expect(env.API_PORT).toBe(4000);
    expect(env.LOG_LEVEL).toBe('info');
  });
  it('treats empty strings (from .env) as unset', () => {
    expect(() => loadEnv({ ...base, SUPABASE_JWT_SECRET: '', SUPABASE_JWKS_URL: '' })).toThrow(
      /SUPABASE_JWKS_URL or SUPABASE_JWT_SECRET/,
    );
  });
  it('accepts a JWKS url instead of a secret', () => {
    expect(
      loadEnv({ ...base, SUPABASE_JWKS_URL: 'http://localhost:54321/jwks' }).SUPABASE_JWKS_URL,
    ).toBeDefined();
  });
  it('rejects a missing database url', () => {
    expect(() => loadEnv({ ...base, DATABASE_URL: undefined, SUPABASE_JWT_SECRET: 's' })).toThrow();
  });
});
