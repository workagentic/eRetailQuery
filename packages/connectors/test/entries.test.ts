import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dist = (file: string): string => resolve(__dirname, '../dist', file);

describe('built entries', () => {
  it('the testing entry does not require vitest; the contract entry may', () => {
    const testing = readFileSync(dist('testing.js'), 'utf8');
    expect(testing).not.toMatch(/require\(["']vitest["']\)/);
    const contract = readFileSync(dist('contract.js'), 'utf8');
    expect(contract).toMatch(/vitest/);
  });
});
