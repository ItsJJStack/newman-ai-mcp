import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: true,
    testTimeout: 120000,
    hookTimeout: 60000,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true }
    }
  }
});