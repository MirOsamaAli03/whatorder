import { defineConfig } from 'vitest/config';

/**
 * The dashboard has no unit tests of its own by design: it holds no business
 * logic to test. Pricing, state transitions and availability are decided by the
 * API and by @restaurant-os/domain, both of which are covered already. What is
 * worth testing here — that the pages render and that a real browser can drive
 * them — is verified end to end against a running stack instead.
 */
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'], passWithNoTests: true },
});
