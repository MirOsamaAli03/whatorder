import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * SWC rather than the default esbuild transform.
 *
 * esbuild does not implement `emitDecoratorMetadata`, and NestJS resolves
 * constructor dependencies from the `design:paramtypes` metadata that flag
 * emits. Under esbuild every injected dependency arrives as undefined, which
 * surfaces as a baffling "Nest can't resolve dependencies" error rather than a
 * compile failure. SWC emits the metadata correctly.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: {
      // The suite signs in dozens of times from one address. Raising the
      // budget keeps functional tests from tripping the limiter, while the
      // guard itself stays active on every request; rate-limit.test.ts
      // overrides the configuration downward to test the limiter directly.
      RATE_LIMIT_AUTH_PER_MINUTE: '100000',
      RATE_LIMIT_DEFAULT_PER_MINUTE: '100000',
      // Request logs would bury the assertion output.
      LOG_LEVEL: 'silent',
      // So the WhatsApp subscription handshake can be exercised. The signing
      // secret is deliberately left unset: the suite asserts the behaviour with
      // verification disabled, and the signed path is covered against a running
      // server, where `rawBody` is populated the way production populates it.
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'test-verify-token',
    },
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    setupFiles: ['./test/setup-env.ts'],
    // Integration tests share one database; running files in parallel would
    // let them truncate each other's rows mid-assertion.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
