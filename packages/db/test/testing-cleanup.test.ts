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
    expect(alive(pid)).toBe(false);
  });

  it('cleanupLeakedDatabases() reaps a database that was never stopped', async () => {
    process.env.ERQ_TEST_DB = 'embedded';
    const db = await startTestDatabase();
    const dir = db.dataDir!;
    const pid = pidOf(dir)!;
    cleanupLeakedDatabases();
    expect(existsSync(dir)).toBe(false);
    expect(alive(pid)).toBe(false);
    cleanupLeakedDatabases(); // idempotent
  });
});
