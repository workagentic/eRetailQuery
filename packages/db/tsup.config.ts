import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts', 'src/admin.ts', 'src/testing.ts'],
  format: ['cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  // Resolved at runtime from the package's own node_modules, never bundled.
  external: ['testcontainers', '@testcontainers/postgresql', 'embedded-postgres'],
});
