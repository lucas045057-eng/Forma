import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // These integration suites spawn real Git processes; bound disk/CPU contention.
    minWorkers: 1,
    maxWorkers: 2,
  },
});
