import { defineConfig, devices } from '@playwright/test';

// e2e ports per docs/CONTRACT.md: server 3101, client 5199.
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  use: { baseURL: 'http://localhost:5199', ...devices['Desktop Chrome'] },
  webServer: [
    {
      command: 'cd server && PORT=3101 CAMERA_MODE=simulation npx tsx src/index.ts',
      url: 'http://localhost:3101/api/health',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'cd client && API_PORT=3101 npx vite --port 5199 --strictPort',
      url: 'http://localhost:5199',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
