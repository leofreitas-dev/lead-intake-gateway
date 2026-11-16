import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Starting Postgres takes a second or two on the first run.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
