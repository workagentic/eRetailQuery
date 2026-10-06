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
/** Pids of all descendants of root (recursive), or undefined if no process listing tool works. */
function descendantsOf(root: number): number[] | undefined {
  try {
    const out: number[] = [];
    if (process.platform === 'win32') {
      const text = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      const kids = new Map<number, number[]>();
      for (const line of text.split('\n')) {
        const [pid, ppid] = line.trim().split(' ').map(Number);
        if (!pid || !ppid) continue;
        kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
      }
      const walk = (p: number): void => {
        for (const k of kids.get(p) ?? []) {
          out.push(k);
          walk(k);
        }
      };
      walk(root);
      return out;
    }
    const walk = (p: number): void => {
      let text = '';
      try {
        text = execFileSync('pgrep', ['-P', String(p)], { encoding: 'utf8' });
      } catch (e) {
        if ((e as { status?: number }).status !== 1) throw e; // 1 = no children
      }
      for (const k of text.split('\n').filter(Boolean).map(Number)) {
        out.push(k);
        walk(k);
      }
    };
    walk(root);
    return out;
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
    const kids = descendantsOf(pid);
    if (kids === undefined) console.warn('process listing unavailable: skipping orphan check');
    else expect(kids.length).toBeGreaterThan(0); // not vacuous: the postmaster has children
    await db.stop();
    expect(await waitDead(pid)).toBe(true);
    for (const kid of kids ?? [])
      expect(await waitDead(kid), `child ${kid} still running`).toBe(true);
    expect(existsSync(dir)).toBe(false);
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
