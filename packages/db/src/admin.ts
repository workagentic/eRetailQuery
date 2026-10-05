import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

/**
 * Runs all migrations as the owner role, then sets the app_user password.
 * The owner must be a superuser or have BYPASSRLS because the SECURITY DEFINER
 * account functions rely on bypassing RLS (Supabase's `postgres` role qualifies).
 */
export async function runMigrations(ownerUrl: string, appUserPassword: string): Promise<void> {
  const pool = new Pool({ connectionString: ownerUrl, max: 1 });
  try {
    const { rows } = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'select rolsuper, rolbypassrls from pg_roles where rolname = current_user',
    );
    if (!rows[0]?.rolsuper && !rows[0]?.rolbypassrls) {
      throw new Error('Migration role must be a superuser or have BYPASSRLS.');
    }
    await migrate(drizzle(pool), { migrationsFolder: path.resolve(__dirname, '../migrations') });
    const { rows: stmt } = await pool.query<{ s: string }>(
      `select format('alter role app_user password %L', $1::text) as s`,
      [appUserPassword],
    );
    await pool.query(stmt[0]!.s);
  } finally {
    await pool.end();
  }
}

export { Pool };
export { seedDemoOrg, DEMO_ORG_ID, DEMO_USER_IDS } from './seed';
