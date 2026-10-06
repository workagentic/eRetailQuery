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

/** Every external command gets a timeout so a hung tool can never hang a test run or an exit hook. */
const EXEC_TIMEOUT_MS = 20_000;

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

/** The part of the embedded-postgres instance we use (the package is ESM-only, so no type import here). */
interface EmbeddedHandle {
  stop(): Promise<void>;
}

interface LiveServer {
  /** Postmaster pid, undefined until the server has started. */
  pid?: number;
  /** The library instance, set once start() was called on it. */
  pg?: EmbeddedHandle;
  /** Epoch ms taken before initdb: every process of this server was created after it (pid-reuse guard). */
  startedAt: number;
}

/** Data directory -> embedded servers this process started and has not stopped yet. */
const live = new Map<string, LiveServer>();

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

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Lets the library forget its child so its own exit hook (which runs `instance.stop()` for every instance whose
 * child it still holds, i.e. a `taskkill /t` on Windows against a pid that may have been reused) has nothing to
 * do. Its exit listener is registered synchronously, so this must run in the same tick as our kill: Node learns
 * about the child's death only on a later event-loop turn.
 */
function detach(server: LiveServer): void {
  const pg = server.pg;
  server.pg = undefined;
  if (pg) void pg.stop().catch(() => {});
}

/**
 * Windows: kills the postmaster FIRST AND ALONE, waits for it to exit, then kills its children by parent pid.
 * Killing a child first (what `taskkill /T` does) makes a live postmaster enter crash recovery and respawn
 * auxiliary processes (io_worker) that are not in taskkill's snapshot and survive as orphans. A dead postmaster
 * cannot respawn anything, and Windows keeps ParentProcessId on orphans. Every match must be postgres.exe created
 * after startedAt, so a reused pid is never killed. The data-directory command-line sweep is a fallback only (it
 * catches the postmaster, not its children, whose command line is `--forkchild=... <handle>`). One PowerShell call.
 */
function killWindowsSync(pid: number | undefined, dir: string, startedAt: number): void {
  const quotedDir = `'${dir.replace(/'/g, "''")}'`;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$dir = ${quotedDir}.ToLowerInvariant()`,
    `$since = [DateTimeOffset]::FromUnixTimeMilliseconds(${startedAt - 2000}).LocalDateTime`,
    `$pm = ${pid ?? 0}`,
    'if ($pm -gt 0) {',
    '  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$pm"',
    "  if ($p -and $p.Name -eq 'postgres.exe' -and $p.CreationDate -ge $since) {",
    '    $h = Get-Process -Id $pm',
    '    if ($h) { $h.Kill(); [void]$h.WaitForExit(10000) }',
    '  }',
    '  Get-CimInstance Win32_Process -Filter "ParentProcessId=$pm" |',
    "    Where-Object { $_.Name -eq 'postgres.exe' -and $_.CreationDate -ge $since } |",
    '    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }',
    '}',
    `Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" |`,
    '  Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($dir) } |',
    '  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }',
  ].join('\n');
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: EXEC_TIMEOUT_MS,
    });
  } catch {
    // PowerShell missing or timed out: kill the postmaster alone (never /T, see above).
    if (pid !== undefined) {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: EXEC_TIMEOUT_MS,
        });
      } catch {
        // already gone
      }
    }
  }
}

/**
 * POSIX: SIGQUIT is an immediate shutdown in which the postmaster itself kills its children. When the pid came
 * from postmaster.pid rather than our own start (crash before we recorded it) it is not verified against reuse:
 * the window is the few milliseconds between start() and readPid, so this is accepted and documented.
 */
function signalPosix(pid: number): boolean {
  try {
    process.kill(pid, 'SIGQUIT');
    return true;
  } catch {
    return false; // already gone
  }
}

/** Kills the server for dir and removes dir, synchronously (exit hooks cannot wait). Never throws. */
function killServerSync(dir: string): void {
  const server = live.get(dir);
  if (!server) return;
  live.delete(dir);
  const pid = server.pid ?? readPid(dir);
  if (process.platform === 'win32') {
    killWindowsSync(pid, dir, server.startedAt);
    detach(server); // after the kill: its own `taskkill /t` must not race our ordered kill (see detach)
  } else {
    detach(server); // before the kill, so its exit listener sees the child die and clears its handle
    if (pid !== undefined && signalPosix(pid)) {
      for (let i = 0; i < 30 && pidAlive(pid); i++) sleepSync(100);
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    // best effort
  }
}

/** Same as killServerSync, but on POSIX it waits without blocking the event loop so Node can reap the child. */
async function killServer(dir: string): Promise<void> {
  const server = live.get(dir);
  if (!server) return;
  if (process.platform !== 'win32') {
    const pid = server.pid ?? readPid(dir);
    detach(server);
    if (pid !== undefined && signalPosix(pid)) {
      for (let i = 0; i < 30 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    }
  }
  killServerSync(dir); // Windows: the ordered kill; POSIX: the pid is gone by now, so this only removes dir
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
  const server: LiveServer = { startedAt: Date.now() };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'erq-pg-'));
  live.set(dir, server);
  try {
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
    await pg.initialise();
    server.pg = pg;
    await pg.start();
    server.pid = readPid(dir);
    await pg.createDatabase('erq');
    const ownerUrl = `postgres://erq_owner:owner@127.0.0.1:${port}/erq`;
    await runMigrations(ownerUrl, APP_USER_PASSWORD);
    return {
      ownerUrl,
      appUrl: toAppUrl(ownerUrl),
      dataDir: dir,
      stop: () => killServer(dir),
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
