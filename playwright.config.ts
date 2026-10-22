import { defineConfig, devices } from '@playwright/test';
import { E2E_GRACE_MS } from './e2e/helpers/data';

// e2e ports per docs/CONTRACT.md: main stack server 3101 / client 5199. The camera-outage stack (a second server whose
// camera probes are pointed at a refused port) uses 3102 / 5198. Both are started fresh and torn down by Playwright.
//
// FNAB_TEST_HOOKS=1 turns on the test-only `test:fastForward` socket event (server/src/net/testHooks.ts) so a full
// match can be played in seconds. The server refuses to start with it when NODE_ENV=production.
// FNAB_RATE_LIMIT_MULTIPLIER only takes effect together with FNAB_TEST_HOOKS=1 (server/src/net/limits.ts): every e2e socket
// comes from 127.0.0.1, so the per-IP budgets would otherwise throttle parallel tests.
// FNAB_TEST_RECONNECT_GRACE_MS shortens the reconnection grace (testHooks.ts) so forfeit-after-grace is observable.
const HOOKS = `FNAB_TEST_HOOKS=1 FNAB_RATE_LIMIT_MULTIPLIER=1000 FNAB_TEST_RECONNECT_GRACE_MS=${E2E_GRACE_MS}`;
const OUTAGE_SERVER_PORT = 3102;
const OUTAGE_CLIENT_PORT = 5198;
// GitHub's 2-vCPU runners render in software. The suite no longer depends on speed: matches are frozen between
// fast-forwards (test:hold) and the client skips FX canvas loops under ?e2e (render-lite), so two workers are safe.
// Rehearse a slow runner locally with: CI=1 E2E_THROTTLE=4 npx playwright test (CPU throttling via CDP, see e2e/helpers/game.ts).
const CI = !!process.env.CI;

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  timeout: CI ? 180_000 : 90_000,
  expect: { timeout: CI ? 20_000 : 10_000 },
  fullyParallel: true,
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : CI ? 2 : 4,
  retries: CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5199',
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
    ...devices['Desktop Chrome'],
    // E2E_NO_GPU=1: force software compositing locally, like a CI runner without a GPU (use with E2E_THROTTLE).
    ...(process.env.E2E_NO_GPU ? { launchOptions: { args: ['--disable-gpu', '--disable-gpu-compositing'] } } : {}),
  },
  projects: [
    { name: 'main', testIgnore: /outage\.spec\.ts/ },
    { name: 'outage', testMatch: /outage\.spec\.ts/, use: { baseURL: `http://localhost:${OUTAGE_CLIENT_PORT}` } },
  ],
  webServer: [
    {
      command: `cd server && PORT=3101 CAMERA_MODE=simulation ${HOOKS} npx tsx src/index.ts`,
      url: 'http://localhost:3101/api/health',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'cd client && API_PORT=3101 E2E_VITE_CACHE=main npx vite --config ../e2e/vite.e2e.config.ts --port 5199 --strictPort',
      url: 'http://localhost:5199',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // Real-camera mode with every probe sent to a closed local port: an instant, network-free "Caltrans is down".
      command: `cd server && PORT=${OUTAGE_SERVER_PORT} CAMERA_MODE=auto CAMERA_PROBE_ORIGIN=http://127.0.0.1:9 CAMERA_TIMEOUT_MS=1500 ${HOOKS} npx tsx src/index.ts`,
      url: `http://localhost:${OUTAGE_SERVER_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `cd client && API_PORT=${OUTAGE_SERVER_PORT} E2E_VITE_CACHE=outage npx vite --config ../e2e/vite.e2e.config.ts --port ${OUTAGE_CLIENT_PORT} --strictPort`,
      url: `http://localhost:${OUTAGE_CLIENT_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
