import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 180_000,
    pool: 'forks',
    // Every file starts its own Postgres (initdb plus all migrations); unbounded parallelism starves the tests.
    maxWorkers: 4,
  },
});
