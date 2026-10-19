import 'server-only';
import { createTenantDb, type TenantDb } from '@erq/db';

declare global {
  // eslint-disable-next-line no-var -- a global is the only way to share one pool across hot reloads and warm lambdas
  var __erqTenantDb: TenantDb | undefined;
}

/**
 * One pool per server instance. max is 1 because each serverless instance handles one request at a time
 * and Supabase's pooler has a small connection budget (DATABASE_URL should be its transaction-mode URL).
 */
export function getTenantDb(): TenantDb {
  if (!globalThis.__erqTenantDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL must be set');
    globalThis.__erqTenantDb = createTenantDb(url, { max: 1 });
  }
  return globalThis.__erqTenantDb;
}
