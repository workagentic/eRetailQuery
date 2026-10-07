import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupLeakedDatabases, sameProcessCreation, startTestDatabase } from '../src/testing';

// These tests start their databases inside `it`, so they need the long timeout the other files give `beforeAll`.
const LONG = { timeout: 180_000 };

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

/** Direct children of each pid in the process table, or undefined if no process listing tool works. */
function childrenMap(): Map<number, number[]> | undefined {
  try {
    const kids = new Map<number, number[]>();
    const text =
      process.platform === 'win32'
        ? execFileSync(
            'powershell',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
            ],
            { encoding: 'utf8', windowsHide: true, timeout: 20_000 },
          )
        : execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 20_000 });
    for (const line of text.split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (!pid || !ppid) continue;
      kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
    }
    return kids;
  } catch {
    return undefined;
  }
}

/**
 * Pids of all descendants of root (recursive), or undefined if listing is unavailable. Works for a DEAD root too:
 * orphans keep their parent pid on Windows (on POSIX they are re-parented, which the pre-stop snapshot covers).
 */
function descendantsOf(root: number): number[] | undefined {
  const kids = childrenMap();
  if (!kids) return undefined;
  const out: number[] = [];
  const walk = (p: number): void => {
    for (const k of kids.get(p) ?? []) {
      out.push(k);
      walk(k);
    }
  };
  walk(root);
  return out;
}

/** Polls until root has no descendants left; returns the survivors (empty when clean). */
async function waitNoDescendants(root: number, ms = 5000): Promise<number[]> {
  const end = Date.now() + ms;
  for (;;) {
    const left = (descendantsOf(root) ?? []).filter(alive);
    if (left.length === 0 || Date.now() >= end) return left;
    await new Promise((r) => setTimeout(r, 250));
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
  // Reaps anything a failed or timed-out test left running.
  afterAll(cleanupLeakedDatabases);
  afterAll(() => {
    if (prev === undefined) delete process.env.ERQ_TEST_DB;
    else process.env.ERQ_TEST_DB = prev;
  });

  it('stop() removes the data directory and kills the server and every child', LONG, async () => {
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
    // Re-query AFTER the stop: catches children respawned during the kill (crash recovery), which the
    // pre-stop snapshot cannot contain.
    if (kids !== undefined)
      expect(await waitNoDescendants(pid), 'orphans left after stop').toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  it('cleanupLeakedDatabases() reaps a database that was never stopped', LONG, async () => {
    process.env.ERQ_TEST_DB = 'embedded';
    const db = await startTestDatabase();
    const dir = db.dataDir!;
    const pid = pidOf(dir)!;
    const kids = descendantsOf(pid);
    cleanupLeakedDatabases();
    expect(existsSync(dir)).toBe(false);
    expect(await waitDead(pid)).toBe(true);
    for (const kid of kids ?? [])
      expect(await waitDead(kid), `child ${kid} still running`).toBe(true);
    if (kids !== undefined)
      expect(await waitNoDescendants(pid), 'orphans left after cleanup').toEqual([]);
    cleanupLeakedDatabases(); // idempotent
  });
});

describe('sameProcessCreation', () => {
  // Creation times are UTC tick counts as digit-only text, which is what processCreation returns.
  const T1 = '639000000000000000';
  const T2 = '639000000010000000';
  it('is true only for equal, defined, non-empty creation times', () => {
    expect(sameProcessCreation(T1, T1)).toBe(true);
    expect(sameProcessCreation(` ${T1} `, T1)).toBe(true);
    expect(sameProcessCreation(T1, T2)).toBe(false);
    expect(sameProcessCreation(undefined, T1)).toBe(false);
    expect(sameProcessCreation(T1, undefined)).toBe(false);
    expect(sameProcessCreation(undefined, undefined)).toBe(false);
    expect(sameProcessCreation('', '')).toBe(false);
    expect(sameProcessCreation('   ', '   ')).toBe(false);
    expect(sameProcessCreation('', T1)).toBe(false);
  });
});
