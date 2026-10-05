import { afterEach, expect, it } from 'vitest';
import { startTestDatabase } from '../src/testing';

const original = process.env.ERQ_TEST_DB;
afterEach(() => {
  if (original === undefined) delete process.env.ERQ_TEST_DB;
  else process.env.ERQ_TEST_DB = original;
});

it('rejects an unknown ERQ_TEST_DB value instead of silently falling back', async () => {
  process.env.ERQ_TEST_DB = 'dockr';
  await expect(startTestDatabase()).rejects.toThrow('ERQ_TEST_DB must be docker, embedded or auto');
});
