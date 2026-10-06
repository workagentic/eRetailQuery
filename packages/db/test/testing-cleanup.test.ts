import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupLeakedDatabases, startTestDatabase } from '../src/testing';

function pidOf(dir: string): number | undefined {
  try {
    return Number(readFileSync(path.join(dir, 'postmaster.pid'), 'utf8').split('\n')[0]);
  } catch {
    return undefined;
  }
}
async function waitDead(pid: number, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !alive(pid);
}
/** Command lines of processes mentioning dir, or undefined if no process listing tool works. */
function processesMentioning(dir: string): string[] | undefined {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${dir}*' } | ForEach-Object { $_.CommandLine }`,
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      return out.split('\n').filter((l) => l.trim());
    }
    try {
      return execFileSync('pgrep', ['-f', dir], { encoding: 'utf8' }).split('\n').filter(Boolean);
    } catch (e) {
      if ((e as { status?: number }).status === 1) return []; // pgrep: no match
      throw e;
    }
  } catch {
    return undefined;
  }
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('embedded test database cleanup', () => {
  const prev = process.env.ERQ_TEST_DB;
  afterAll(() => {
    if (prev === undefined) delete process.env.ERQ_TEST_DB;
    else process.env.ERQ_TEST_DB = prev;
  });

  it('stop() removes the data directory and kills the server', async () => {
    process.env.ERQ_TEST_DB = 'embedded';
    const db = await startTestDatabase();
    const dir = db.dataDir!;
    const pid = pidOf(dir)!;
    expect(existsSync(dir)).toBe(true);
    expect(alive(pid)).toBe(true);
    await db.stop();
    expect(existsSync(dir)).toBe(false);
    expect(await waitDead(pid)).toBe(true);
    const left = processesMentioning(dir);
    if (left === undefined) console.warn('process listing unavailable: skipping orphan check');
    else expect(left).toEqual([]);
  });

  it('cleanupLeakedDatabases() reaps a database that was never stopped', async () => {
    process.env.ERQ_TEST_DB = 'embedded';
    const db = await startTestDatabase();
    const dir = db.dataDir!;
    const pid = pidOf(dir)!;
    cleanupLeakedDatabases();
    expect(existsSync(dir)).toBe(false);
    expect(await waitDead(pid)).toBe(true);
    cleanupLeakedDatabases(); // idempotent
  });
});
