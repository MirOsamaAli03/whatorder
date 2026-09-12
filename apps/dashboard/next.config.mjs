/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

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
