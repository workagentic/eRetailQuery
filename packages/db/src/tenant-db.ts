import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface TenantDb {
  /** Runs fn in a transaction with app.org_id set locally, so RLS scopes every query to orgId. */
  withTenant<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  pool: Pool;
  close(): Promise<void>;
}

export function createTenantDb(connectionString: string, opts: { max?: number } = {}): TenantDb {
  const pool = new Pool({ connectionString, max: opts.max ?? 10 });
  // Idle-client errors would otherwise crash the process; they surface on the next query.
  pool.on('error', () => undefined);
  const db = drizzle(pool, { schema });
  return {
    pool,
    withTenant(orgId, fn) {
      if (!UUID_RE.test(orgId)) throw new TypeError('withTenant requires a uuid orgId');
      return db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
        return fn(tx);
      });
    },
    close: () => pool.end(),
  };
}
