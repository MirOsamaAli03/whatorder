import { createPrismaClient, type PrismaClient } from './client';
import { TenantContextError, describeConnection } from './tenant';

/**
 * The background worker's database connection.
 *
 * Two jobs genuinely need to look across tenants: draining `outbox_events`,
 * which is one queue for the whole platform, and finding orders that have gone
 * unacknowledged (ENGINEERING_SPEC.md 33). Neither can run as the application
 * role, because RLS correctly hides other tenants' rows from it.
 *
 * The answer is not BYPASSRLS — that is role-wide and would hand a background
 * process unrestricted read of every table. Instead `restaurant_worker` has
 * policies on exactly four tables (see migration 20260901000400), and is denied
 * menus, customers, payments and audit logs at the database. It also cannot
 * write an order's status: escalation raises an alarm, it does not touch the
 * order.
 */
export function createWorkerPrismaClient(databaseUrl?: string): PrismaClient {
  const url = databaseUrl ?? process.env.DATABASE_URL_WORKER;
  if (!url) {
    throw new TenantContextError(
      'DATABASE_URL_WORKER is not set. The worker must connect as restaurant_worker, ' +
        'not as the application or owner role (see infrastructure/docker/init/02-worker-role.sql).',
    );
  }
  return createPrismaClient({ databaseUrl: url });
}

/**
 * Boot-time guard, the worker's equivalent of assertLeastPrivilegeConnection.
 *
 * Pointing DATABASE_URL_WORKER at the owner by mistake would give the worker
 * silent read and write access to everything, with no error anywhere — exactly
 * the failure this whole arrangement exists to prevent. Refusing to start is
 * far better.
 */
export async function assertWorkerConnection(prisma: PrismaClient): Promise<void> {
  const privileges = await describeConnection(prisma);
  const problems: string[] = [];

  if (privileges.isSuperuser) problems.push('it is a SUPERUSER');
  if (privileges.canBypassRls) problems.push('it has BYPASSRLS');
  if (privileges.ownsTables) problems.push('it owns tables in the public schema');

  if (problems.length > 0) {
    throw new TenantContextError(
      `Refusing to start: the worker database role "${privileges.role}" has more access ` +
        `than it should because ${problems.join(' and ')}. Point DATABASE_URL_WORKER at ` +
        'the restaurant_worker role.',
    );
  }

  // Positive confirmation that the narrow grants are actually in place: the
  // worker must be able to read the outbox and must NOT be able to read a menu.
  await prisma.$queryRaw`SELECT 1 FROM outbox_events LIMIT 1`;

  let deniedMenu = false;
  try {
    await prisma.$queryRaw`SELECT 1 FROM menu_items LIMIT 1`;
  } catch {
    deniedMenu = true;
  }

  if (!deniedMenu) {
    throw new TenantContextError(
      `Refusing to start: the worker role "${privileges.role}" can read menu_items, ` +
        'which means its grants are wider than the design intends.',
    );
  }
}
