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

/** Data directory -> postmaster pid (undefined until the server has started) of embedded servers still running. */
const live = new Map<string, number | undefined>();

function readPid(dir: string): number | undefined {
  try {
    const pid = Number(readFileSync(path.join(dir, 'postmaster.pid'), 'utf8').split('\n')[0]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists but not ours; ESRCH means gone
  }
}

/** Directories whose Windows tree kill and sweep already ran, so the second pass is skipped. */
const swept = new Set<string>();

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Kills the postmaster tree for pid. Works even if the pid file is already gone. Never throws. */
function killTreeSync(pid: number, dir: string): void {
  if (process.platform === 'win32') {
    if (swept.has(dir)) return;
    swept.add(dir);
  } else if (!pidAlive(pid)) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      // /T kills the whole tree: pg.stop() only stops the postmaster and leaves backends behind on Windows.
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      process.kill(pid, 'SIGQUIT'); // immediate shutdown
      for (let i = 0; i < 30 && pidAlive(pid); i++) sleepSync(100);
    }
  } catch {
    // already gone
  }
  if (process.platform === 'win32') {
    // Children whose postmaster already exited are no longer in its tree; sweep by data directory.
    try {
      execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${dir.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
        ],
        { stdio: 'ignore', windowsHide: true },
      );
    } catch {
      // best effort
    }
  }
}

/**
 * Same as killTreeSync but never blocks the event loop on POSIX (Node must stay free to reap the child),
 * so it can wait for the postmaster to exit. Gives up after ~3s.
 */
async function killTree(pid: number, dir: string): Promise<void> {
  if (process.platform === 'win32') {
    killTreeSync(pid, dir);
    return;
  }
  try {
    process.kill(pid, 'SIGQUIT'); // immediate shutdown
  } catch {
    return; // already gone
  }
  for (let i = 0; i < 30 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
}

/** Kills the server for dir (remembered pid, else postmaster.pid), then removes dir. Never throws. */
function killServerSync(dir: string): void {
  const pid = live.get(dir) ?? readPid(dir);
  if (pid !== undefined) killTreeSync(pid, dir);
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    // best effort
  }
  live.delete(dir);
  swept.delete(dir);
}

/** Reaps every embedded database this process started and did not stop. Safe to call repeatedly. */
export function cleanupLeakedDatabases(): void {
  for (const dir of [...live.keys()]) killServerSync(dir);
}

const HOOKED = Symbol.for('erq.db.testing.hooked');
function installHooks(): void {
  const g = globalThis as Record<symbol, unknown>;
  if (g[HOOKED]) return;
  g[HOOKED] = true;
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
  live.set(dir, undefined);
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
    live.set(dir, readPid(dir));
    await pg.createDatabase('erq');
    const ownerUrl = `postgres://erq_owner:owner@127.0.0.1:${port}/erq`;
    await runMigrations(ownerUrl, APP_USER_PASSWORD);
    return {
      ownerUrl,
      appUrl: toAppUrl(ownerUrl),
      dataDir: dir,
      stop: async () => {
        try {
          // Kill the whole tree while the postmaster is still alive: once it has exited (even cleanly), its
          // children (e.g. PG 18 io_worker) are orphaned and can no longer be found through the tree.
          const pid = live.get(dir);
          if (pid !== undefined) await killTree(pid, dir);
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              pg.stop(),
              new Promise((resolve) => {
                timer = setTimeout(resolve, 5000);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
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
