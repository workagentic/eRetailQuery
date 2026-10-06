import { defineConfig } from 'tsup';
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    testing: 'src/testing/index.ts',
    contract: 'src/testing/contract-entry.ts',
  },
  format: ['cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['vitest'],
});
