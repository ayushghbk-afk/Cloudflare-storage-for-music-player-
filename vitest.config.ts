import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // The D1 shim uses node:sqlite, which is synchronous per-file; keep files
    // isolated but allow per-file parallelism.
    isolate: true,
    pool: 'forks',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      include: ['worker/src/**/*.ts'],
      exclude: ['worker/src/index.ts'],
      reporter: ['text', 'lcov'],
    },
  },
});
