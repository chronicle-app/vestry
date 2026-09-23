import { defineConfig } from 'vitest/config';

// Tests exercise real fsync, staging, and SIGKILL recovery on disk, so they are
// slow under full parallel load. Give them room and cap concurrency.
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 60_000,
    maxWorkers: 4,
  },
});
