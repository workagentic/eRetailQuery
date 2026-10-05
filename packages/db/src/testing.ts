import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from './admin';

export interface TestDatabase {
  ownerUrl: string;
  appUrl: string;
  stop(): Promise<void>;
}

const APP_USER_PASSWORD = 'app_user_test';

/** True when a Docker daemon is reachable (`docker info` succeeds within 10s). */
export function dockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile('docker', ['info'], { timeout: 10_000, windowsHide: true }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}

function toAppUrl(ownerUrl: string): string {
  const app = new URL(ownerUrl);
  app.username = 'app_user';
  app.password = APP_USER_PASSWORD;
  return app.toString();
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function startDocker(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withUsername('erq_owner')
    .withPassword('owner')
    .withDatabase('erq')
    .start();
  const ownerUrl = container.getConnectionUri();
  await runMigrations(ownerUrl, APP_USER_PASSWORD);
  return { ownerUrl, appUrl: toAppUrl(ownerUrl), stop: async () => void (await container.stop()) };
}

/** Fallback for machines without Docker: real Postgres binaries from the embedded-postgres package. */
async function startEmbedded(): Promise<TestDatabase> {
  // embedded-postgres is ESM-only; a dynamic import keeps this CJS build working.
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'erq-pg-'));
  const port = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'erq_owner',
    password: 'owner',
    port,
    persistent: true, // we delete the dir ourselves (with retries) on stop; the library's own cleanup hits EBUSY on Windows
    onLog: () => {},
    onError: () => {},
  });
  try {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('erq');
    const ownerUrl = `postgres://erq_owner:owner@127.0.0.1:${port}/erq`;
    await runMigrations(ownerUrl, APP_USER_PASSWORD);
    return {
      ownerUrl,
      appUrl: toAppUrl(ownerUrl),
      stop: async () => {
        try {
          await pg.stop();
        } finally {
          await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
        }
      },
    };
  } catch (err) {
    await pg.stop().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Starts a throwaway Postgres, applies all migrations, returns owner and app_user URLs.
 * ERQ_TEST_DB=docker | embedded | auto (default: Docker if reachable, else embedded-postgres).
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const mode = process.env.ERQ_TEST_DB ?? 'auto';
  if (mode === 'docker') return startDocker();
  if (mode === 'embedded') return startEmbedded();
  if (mode !== 'auto') throw new Error('ERQ_TEST_DB must be docker, embedded or auto');
  return (await dockerAvailable()) ? startDocker() : startEmbedded();
}
