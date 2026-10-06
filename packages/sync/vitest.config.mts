import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: {
    alias: {
      // The built testing entry is CJS and requires vitest, which vitest cannot load; use the TS source.
      '@erq/connectors/testing': fileURLToPath(
        new URL('../connectors/src/testing/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 180_000,
    pool: 'forks',
  },
});
