import path from 'node:path';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  /**
   * Bundles a minimal server into .next/standalone for the container image.
   *
   * Without it the runtime image needs the whole node_modules tree; with it the
   * dashboard ships as a few megabytes and a single `node server.js`.
   */
  output: 'standalone',

  /**
   * Trace from the repository root, not from this app.
   *
   * In a workspace the shared packages live above the app directory, and
   * standalone output silently omits anything outside the traced root — which
   * surfaces as MODULE_NOT_FOUND for @restaurant-os/types at container start,
   * long after the build looked fine.
   */
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),

  /**
   * The shared packages ship as CommonJS from tsc. Next compiles them as part
   * of the app so the dashboard uses the same enums, permission names and pure
   * domain helpers as the API — rather than its own copy that can drift.
   */
  transpilePackages: ['@restaurant-os/types', '@restaurant-os/domain'],

  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:3001',
  },

  eslint: {
    // Linting runs through the repo's own flat config in `npm run lint`, not
    // twice with a second ruleset during the build.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
