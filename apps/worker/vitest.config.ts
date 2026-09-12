import { defineConfig } from 'vitest/config';

/**
 * The worker has no unit tests of its own.
 *
 * `OutboxPublisher` and `EscalationMonitor` are integration-shaped: they act on
 * orders, which need the full API harness to create. They are therefore driven
 * end to end from `apps/api/test/kds.test.ts`, against the real
 * `restaurant_worker` database role, which also verifies the privilege boundary
 * that a mock would hide. Rebuilding that harness here would test less, not
 * more.
 */
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'], passWithNoTests: true },
});
