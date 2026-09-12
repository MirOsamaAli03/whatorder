import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests for the dashboard and kitchen display.
 *
 * These exist because the rest of the suite cannot see them. The API tests
 * prove the server behaves; only a real browser proves that a manager can
 * actually mark a dish sold out, or that a kitchen screen advances an order and
 * updates itself. Phase 4 shipped a bug — status events routed to the wrong
 * channel — that every integration test passed straight through, and that only
 * a real client attached to the real stream revealed.
 *
 * The stack is expected to be already running (API on 3001, dashboard on 3000).
 * Bringing it up here would mean owning Postgres, Redis and two Node processes
 * from inside a test runner, which is a worse trade than one documented
 * prerequisite.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',

  // The suite drives one shared database, so parallel workers would fight over
  // the same orders.
  fullyParallel: false,
  workers: 1,

  timeout: 45_000,
  expect: { timeout: 10_000 },

  reporter: process.env.CI ? 'github' : 'list',

  use: {
    baseURL: process.env.DASHBOARD_URL ?? 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // A kitchen display is a large screen, and the four columns need the room.
    viewport: { width: 1440, height: 900 },
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
