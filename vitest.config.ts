import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['shared/**/*.test.ts', 'server/**/*.test.ts', 'client/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', 'e2e/**'],
    environment: 'node',
  },
});
