import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from './admin';

export interface TestDatabase {
  ownerUrl: string;
  appUrl: string;
  /** Embedded mode only: the server's data directory. */
  dataDir?: string;
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

const live = new Set<string>(); // data directories of embedded servers that are still running

/** Kills the postmaster (and its backends) found in dir/postmaster.pid, then removes dir. Never throws. */
function killServerSync(dir: string): void {
  try {
    const pid = Number(readFileSync(path.join(dir, 'postmaster.pid'), 'utf8').split('\n')[0]);
    if (Number.isSafeInteger(pid) && pid > 0) {
      if (process.platform === 'win32') {
        // /T kills the whole tree: pg.stop() only stops the postmaster and leaves backends behind on Windows.
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        process.kill(pid, 'SIGQUIT'); // immediate shutdown; the directory is deleted next
      }
    }
  } catch {
    // already gone
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    // best effort
  }
  live.delete(dir);
}

/** Reaps every embedded database this process started and did not stop. Safe to call repeatedly. */
export function cleanupLeakedDatabases(): void {
  for (const dir of [...live]) killServerSync(dir);
}

let hooked = false;
function installHooks(): void {
  if (hooked) return;
  hooked = true;
  process.on('exit', cleanupLeakedDatabases);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      cleanupLeakedDatabases();
      process.exit(1);
    });
  }
}

/** Fallback for machines without Docker: real Postgres binaries from the embedded-postgres package. */
async function startEmbedded(): Promise<TestDatabase> {
  // embedded-postgres is ESM-only; a dynamic import keeps this CJS build working.
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  installHooks();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'erq-pg-'));
  live.add(dir);
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
      dataDir: dir,
      stop: async () => {
        try {
          await pg.stop();
        } catch {
          // fall through to the forced cleanup
        } finally {
          killServerSync(dir); // also reaps backends that pg.stop() leaves on Windows, then removes the dir
        }
      },
    };
  } catch (err) {
    killServerSync(dir);
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
