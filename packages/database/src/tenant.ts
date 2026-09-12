import type { PrismaClient, TransactionClient } from './client';

/**
 * Tenant context propagation for Row-Level Security.
 *
 * ENGINEERING_SPEC.md 7 asks for reusable tenant-scoping utilities and warns
 * against relying on developers remembering to add a filter. Plan 2.7 takes
 * that one step further: the database itself refuses to return another
 * tenant's rows.
 *
 * Mechanism: every tenant-scoped unit of work runs inside a transaction that
 * first sets `app.tenant_id`. RLS policies compare each row against
 * `app_current_tenant_id()`. When the setting is absent the function returns
 * NULL, every policy comparison evaluates to NULL, and no rows are visible —
 * the failure mode is "see nothing", never "see everything".
 *
 * `SET LOCAL` semantics (via set_config's third argument) scope the setting to
 * the transaction, so it cannot leak to the next borrower of a pooled
 * connection, and it remains correct under PgBouncer transaction pooling.
 *
 * Cost: one transaction per tenant-scoped unit of work. That is a real but
 * small price, and it is the only way to make the guarantee hold without a
 * dedicated connection per request.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

export interface TenantContextOptions {
  /** Max ms the callback may hold the transaction open. */
  timeout?: number;
  /** Max ms to wait for a connection from the pool. */
  maxWait?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_WAIT_MS = 5_000;

/**
 * Runs `fn` with the tenant context applied, inside a single transaction.
 *
 * Everything the callback touches is filtered by RLS to `tenantId`. Writes are
 * atomic with each other, which is also what the outbox pattern will rely on
 * in Phase 4.
 */
export async function withTenantContext<T>(
  prisma: PrismaClient,
  tenantId: string,
  fn: (tx: TransactionClient) => Promise<T>,
  options: TenantContextOptions = {},
): Promise<T> {
  if (!UUID_PATTERN.test(tenantId)) {
    // Parameterised below, so this is not an injection guard — it fails fast
    // with a clear message instead of a confusing Postgres cast error.
    throw new TenantContextError(`Invalid tenant id: "${tenantId}"`);
  }

  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx as TransactionClient);
    },
    {
      timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
      maxWait: options.maxWait ?? DEFAULT_MAX_WAIT_MS,
    },
  );
}

/**
 * Runs `fn` as a known user but with no organization selected.
 *
 * Login has a genuine ordering problem: to list the organizations a user may
 * sign in to, their memberships must be readable before any tenant is chosen.
 * Rather than punching a hole in RLS, the policies on `memberships` and
 * `organizations` also admit rows reachable from `app.user_id`, so a
 * successfully authenticated user can see exactly their own memberships and
 * nothing else.
 *
 * Only ever called AFTER the password has been verified.
 */
export async function withUserContext<T>(
  prisma: PrismaClient,
  userId: string,
  fn: (tx: TransactionClient) => Promise<T>,
  options: TenantContextOptions = {},
): Promise<T> {
  if (!UUID_PATTERN.test(userId)) {
    throw new TenantContextError(`Invalid user id: "${userId}"`);
  }

  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.user_id', ${userId}, true)`;
      return fn(tx as TransactionClient);
    },
    {
      timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
      maxWait: options.maxWait ?? DEFAULT_MAX_WAIT_MS,
    },
  );
}

/**
 * Runs `fn` with no tenant context.
 *
 * Only for genuinely tenant-free work: authentication before an organization
 * is chosen, the permission catalogue, platform back-office queries. RLS is
 * still active, so any tenant-owned table read here returns zero rows.
 */
export async function withoutTenantContext<T>(
  prisma: PrismaClient,
  fn: (tx: TransactionClient) => Promise<T>,
  options: TenantContextOptions = {},
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.tenant_id', '', true)`;
      return fn(tx as TransactionClient);
    },
    {
      timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
      maxWait: options.maxWait ?? DEFAULT_MAX_WAIT_MS,
    },
  );
}

export interface ConnectionPrivileges {
  role: string;
  isSuperuser: boolean;
  canBypassRls: boolean;
  ownsTables: boolean;
}

export async function describeConnection(prisma: PrismaClient): Promise<ConnectionPrivileges> {
  const rows = await prisma.$queryRaw<
    Array<{ role: string; is_superuser: boolean; can_bypass_rls: boolean; owns_tables: boolean }>
  >`
    SELECT
      current_user AS role,
      COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS is_superuser,
      COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false) AS can_bypass_rls,
      EXISTS (
        SELECT 1 FROM pg_tables
        WHERE schemaname = 'public' AND tableowner = current_user
      ) AS owns_tables
  `;

  const row = rows[0];
  if (!row) {
    throw new TenantContextError('Could not determine the privileges of the database connection');
  }

  return {
    role: row.role,
    isSuperuser: row.is_superuser,
    canBypassRls: row.can_bypass_rls,
    ownsTables: row.owns_tables,
  };
}

/**
 * Boot-time guard: refuses to start if the runtime connection can bypass RLS.
 *
 * Superusers, roles with BYPASSRLS, and table owners are all exempt from RLS
 * policies. If DATABASE_URL is pointed at the owner role by mistake, every
 * policy silently stops applying and the second line of defence disappears
 * without a single error. Failing to boot is far better than that.
 */
export async function assertLeastPrivilegeConnection(prisma: PrismaClient): Promise<void> {
  const privileges = await describeConnection(prisma);
  const problems: string[] = [];

  if (privileges.isSuperuser) problems.push('it is a SUPERUSER');
  if (privileges.canBypassRls) problems.push('it has BYPASSRLS');
  if (privileges.ownsTables) problems.push('it owns tables in the public schema');

  if (problems.length > 0) {
    throw new TenantContextError(
      `Refusing to start: the application database role "${privileges.role}" bypasses ` +
        `Row-Level Security because ${problems.join(' and ')}. ` +
        'Point DATABASE_URL at the least-privilege application role and keep ' +
        'DATABASE_URL_ADMIN for migrations only (see infrastructure/docker/init/01-app-role.sql).',
    );
  }
}
