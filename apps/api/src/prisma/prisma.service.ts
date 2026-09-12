import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  assertLeastPrivilegeConnection,
  createPrismaClient,
  describeConnection,
  withTenantContext,
  withUserContext,
  withoutTenantContext,
  type PrismaClient,
  type TransactionClient,
} from '@restaurant-os/database';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';

/**
 * Owns the Prisma connection and the tenant-scoping entry points.
 *
 * Services never touch `client` directly. They call `forTenant()` (or
 * `withoutTenant()` for the few genuinely tenant-free operations), which opens
 * a transaction with `app.tenant_id` set so RLS applies. Making the scoped
 * helper the only ergonomic path is how spec 7's "do not rely on developers
 * remembering to add tenant filters" is satisfied in practice.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  readonly client: PrismaClient;

  constructor(@Inject(ENV) env: Env) {
    this.client = createPrismaClient({
      databaseUrl: env.DATABASE_URL,
      logQueries: env.NODE_ENV === 'development' && env.LOG_LEVEL === 'trace',
    });
  }

  async onModuleInit(): Promise<void> {
    await this.client.$connect();

    // Fail fast if the runtime role can bypass RLS — otherwise the second
    // line of defence would be silently absent (plan 2.7).
    await assertLeastPrivilegeConnection(this.client);

    const privileges = await describeConnection(this.client);
    this.logger.log(
      `Database connected as "${privileges.role}" with Row-Level Security enforced`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }

  /**
   * Runs a unit of work scoped to one tenant. Every query inside is filtered
   * by RLS, and all writes commit or roll back together.
   */
  forTenant<T>(tenantId: string, fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return withTenantContext(this.client, tenantId, fn);
  }

  /**
   * Runs a unit of work as a known user with no organization selected.
   *
   * Only for the login step that lists which organizations a user may sign in
   * to. RLS still applies: the policies admit only rows reachable from this
   * user's own memberships.
   */
  forUser<T>(userId: string, fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return withUserContext(this.client, userId, fn);
  }

  /**
   * Runs a unit of work with no tenant context: login, the permission
   * catalogue, platform back-office queries. Tenant-owned tables return zero
   * rows here, which is the intended protection rather than an inconvenience.
   */
  withoutTenant<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return withoutTenantContext(this.client, fn);
  }

  /** Liveness probe for /ready (ENGINEERING_SPEC.md 69). */
  async ping(): Promise<boolean> {
    try {
      await this.client.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.error({ err: error }, 'Database readiness check failed');
      return false;
    }
  }
}
