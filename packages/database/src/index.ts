export {
  createPrismaClient,
  Prisma,
  PrismaClient,
  type PrismaClientOptions,
  type TransactionClient,
} from './client';

export { assertWorkerConnection, createWorkerPrismaClient } from './worker';

export {
  assertLeastPrivilegeConnection,
  describeConnection,
  TenantContextError,
  withTenantContext,
  withUserContext,
  withoutTenantContext,
  type ConnectionPrivileges,
  type TenantContextOptions,
} from './tenant';

/**
 * Tables that are deliberately NOT tenant-owned and therefore carry no RLS
 * policy. Anything else must have one; rls-coverage.test.ts fails the build
 * if a new table appears that is in neither category.
 *
 *   users       — global identity; a person may belong to several tenants
 *   sessions    — authentication runs before any tenant is chosen
 *   permissions — global reference data, seeded from @restaurant-os/types
 *   _prisma_migrations — Prisma's own bookkeeping
 *
 * `outbox_cursors` is deliberately NOT here. It has no tenant_id — it is one
 * watermark per background consumer over a platform-wide queue — but it still
 * has RLS enabled, with a policy admitting only the worker role. Grants alone
 * would have left it writable by the application.
 */
export const NON_TENANT_TABLES: readonly string[] = [
  '_prisma_migrations',
  'permissions',
  'sessions',
  'users',
];
