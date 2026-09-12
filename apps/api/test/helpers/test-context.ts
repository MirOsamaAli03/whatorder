import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { ROLE_PERMISSIONS } from '@restaurant-os/domain';
import {
  ALL_PERMISSIONS,
  MembershipStatus,
  OrganizationStatus,
  OrganizationType,
  SystemRole,
  UserStatus,
} from '@restaurant-os/types';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../src/app.module';

/**
 * Integration test harness.
 *
 * Two database connections on purpose, mirroring production:
 *   * `admin` — the schema owner, exempt from RLS. Used only to build fixtures
 *     across several tenants, which is impossible through the app connection.
 *   * the application under test connects as the least-privilege role, so the
 *     isolation these tests assert is the real thing rather than a mock.
 */

export const TEST_PASSWORD = 'TestPassword123!';

export interface TestTenant {
  organizationId: string;
  slug: string;
  branchIds: string[];
  /** email -> { userId, membershipId } */
  users: Record<string, { userId: string; membershipId: string; email: string }>;
}

export interface TestContext {
  app: NestFastifyApplication;
  admin: PrismaClient;
  close: () => Promise<void>;
}

export async function createTestContext(): Promise<TestContext> {
  const adminUrl = process.env.DATABASE_URL_ADMIN;
  if (!adminUrl) {
    throw new Error('DATABASE_URL_ADMIN must be set to run integration tests');
  }

  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());

  await app.register(import('@fastify/cookie'));

  app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });

  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return {
    app,
    admin,
    close: async () => {
      await app.close();
      await admin.$disconnect();
    },
  };
}

/** Ensures the permission catalogue and system roles exist. Idempotent. */
export async function ensureReferenceData(admin: PrismaClient): Promise<void> {
  for (const key of ALL_PERMISSIONS) {
    await admin.permission.upsert({
      where: { key },
      update: {},
      create: { key, category: key.split('.')[0] ?? 'general' },
    });
  }

  const permissions = await admin.permission.findMany();
  const permissionIdByKey = new Map(permissions.map((p) => [p.key, p.id]));

  for (const [roleName, grants] of Object.entries(ROLE_PERMISSIONS)) {
    const existing = await admin.role.findFirst({ where: { tenantId: null, name: roleName } });
    const role =
      existing ??
      (await admin.role.create({ data: { tenantId: null, name: roleName, isSystem: true } }));

    await admin.rolePermission.deleteMany({ where: { roleId: role.id } });
    await admin.rolePermission.createMany({
      data: grants
        .map((key) => permissionIdByKey.get(key))
        .filter((id): id is string => Boolean(id))
        .map((permissionId) => ({ tenantId: null, roleId: role.id, permissionId })),
    });
  }
}

export interface CreateTenantInput {
  /** Slug prefix; a random suffix keeps parallel runs from colliding. */
  slug: string;
  branchSlugs: string[];
  users: Array<{
    key: string;
    role: SystemRole;
    /** Indexes into branchSlugs. Omit for organization-wide roles. */
    branches?: number[];
  }>;
}

/**
 * Builds a complete tenant through the admin connection.
 *
 * Written directly rather than through the API because the API deliberately
 * offers no way to create an organization from a tenant session — that is what
 * onboarding and the platform back office are for.
 */
export async function createTenant(
  admin: PrismaClient,
  input: CreateTenantInput,
): Promise<TestTenant> {
  const suffix = randomUUID().slice(0, 8);
  const slug = `${input.slug}-${suffix}`;

  const organization = await admin.organization.create({
    data: {
      name: input.slug,
      slug,
      type: OrganizationType.RESTAURANT,
      status: OrganizationStatus.ACTIVE,
    },
  });

  const branchIds: string[] = [];
  for (const branchSlug of input.branchSlugs) {
    const branch = await admin.branch.create({
      data: { tenantId: organization.id, name: branchSlug, slug: branchSlug },
    });
    branchIds.push(branch.id);
  }

  const passwordHash = await argon2.hash(TEST_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  const users: TestTenant['users'] = {};

  for (const userInput of input.users) {
    const email = `${userInput.key}-${suffix}@test.local`;
    const user = await admin.user.create({
      data: { email, name: userInput.key, passwordHash, status: UserStatus.ACTIVE },
    });

    const membership = await admin.membership.create({
      data: {
        tenantId: organization.id,
        userId: user.id,
        status: MembershipStatus.ACTIVE,
      },
    });

    const role = await admin.role.findFirstOrThrow({
      where: { tenantId: null, name: userInput.role },
    });

    await admin.membershipRole.create({
      data: { tenantId: organization.id, membershipId: membership.id, roleId: role.id },
    });

    for (const branchIndex of userInput.branches ?? []) {
      const branchId = branchIds[branchIndex];
      if (!branchId) continue;
      await admin.membershipBranch.create({
        data: { tenantId: organization.id, membershipId: membership.id, branchId },
      });
    }

    users[userInput.key] = { userId: user.id, membershipId: membership.id, email };
  }

  return { organizationId: organization.id, slug, branchIds, users };
}

/** Signs in and returns the access token. */
export async function login(
  app: NestFastifyApplication,
  email: string,
  password = TEST_PASSWORD,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });

  const body = response.json();
  if (response.statusCode !== 200 || !body?.data?.accessToken) {
    throw new Error(`Login failed for ${email}: ${response.statusCode} ${response.body}`);
  }
  return body.data.accessToken as string;
}

export function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** Removes tenants created by a test run. Reference data is left in place. */
export async function cleanupTenants(
  admin: PrismaClient,
  tenants: TestTenant[],
): Promise<void> {
  for (const tenant of tenants) {
    const userIds = Object.values(tenant.users).map((user) => user.userId);

    // Orders hold their branch with ON DELETE RESTRICT, deliberately: deleting
    // a branch that has taken orders would destroy financial history. Test
    // fixtures are the one place that genuinely wants them gone, so they are
    // removed explicitly before the organization.
    await admin.notification.deleteMany({ where: { tenantId: tenant.organizationId } });
    await admin.whatsAppMessage.deleteMany({ where: { tenantId: tenant.organizationId } });
    await admin.whatsAppTemplate.deleteMany({ where: { tenantId: tenant.organizationId } });
    await admin.whatsAppAccount.deleteMany({ where: { tenantId: tenant.organizationId } });
    await admin.inboundWebhookEvent.deleteMany({ where: { tenantId: tenant.organizationId } });
    await admin.order.deleteMany({ where: { tenantId: tenant.organizationId } });
    await admin.cart.deleteMany({ where: { tenantId: tenant.organizationId } });
    await admin.outboxEvent.deleteMany({ where: { tenantId: tenant.organizationId } });
    await admin.idempotencyKey.deleteMany({ where: { tenantId: tenant.organizationId } });

    // Cascades clear memberships, roles, branches, menu and audit rows.
    await admin.organization.deleteMany({ where: { id: tenant.organizationId } });
    await admin.user.deleteMany({ where: { id: { in: userIds } } });
  }
}
