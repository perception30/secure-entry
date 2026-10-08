import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      include: ['gateway/src/**/*.ts', 'backend/src/**/*.ts', 'shared/**/*.ts'],
      exclude: ['**/server.ts'],
      reporter: ['text', 'lcov'],
      thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
    },
  },
});
