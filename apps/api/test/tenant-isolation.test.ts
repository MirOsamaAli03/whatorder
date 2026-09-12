import { PrismaClient } from '@prisma/client';
import { SystemRole } from '@restaurant-os/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authHeaders,
  cleanupTenants,
  createTenant,
  createTestContext,
  ensureReferenceData,
  login,
  type TestContext,
  type TestTenant,
} from './helpers/test-context';

/**
 * Invariant 10: a user cannot access another tenant's resources.
 * Invariant 1: an order — and every other record — belongs to exactly one tenant.
 *
 * The suite proves isolation twice over, and the second half is the point:
 *
 *   1. Through the API, where application-level scoping and RLS both apply.
 *   2. Directly against the database as the application role, with no
 *      application code in the path at all. If someone later writes a query
 *      that forgets its tenant filter, the first set of tests would still pass
 *      for existing endpoints while the new one leaked. The second set proves
 *      the database itself refuses, so a forgotten filter cannot leak data.
 */
describe('tenant isolation', () => {
  let context: TestContext;
  let kababjees: TestTenant;
  let homeKitchen: TestTenant;
  const created: TestTenant[] = [];

  beforeAll(async () => {
    context = await createTestContext();
    await ensureReferenceData(context.admin);

    kababjees = await createTenant(context.admin, {
      slug: 'kababjees',
      branchSlugs: ['dha', 'clifton'],
      users: [
        { key: 'owner', role: SystemRole.OWNER },
        { key: 'cashier', role: SystemRole.CASHIER, branches: [0] },
        { key: 'kitchen', role: SystemRole.KITCHEN_STAFF, branches: [0] },
      ],
    });

    homeKitchen = await createTenant(context.admin, {
      slug: 'ali-home-kitchen',
      branchSlugs: ['main'],
      users: [{ key: 'owner', role: SystemRole.OWNER }],
    });

    created.push(kababjees, homeKitchen);
  });

  afterAll(async () => {
    await cleanupTenants(context.admin, created);
    await context.close();
  });

  describe('through the API', () => {
    it('returns only the caller\'s own organization', async () => {
      const token = await login(context.app, kababjees.users.owner!.email);

      const response = await context.app.inject({
        method: 'GET',
        url: '/api/v1/organizations/current',
        headers: authHeaders(token),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.id).toBe(kababjees.organizationId);
      expect(response.json().data.id).not.toBe(homeKitchen.organizationId);
    });

    it('lists only the caller\'s own branches', async () => {
      const token = await login(context.app, kababjees.users.owner!.email);

      const response = await context.app.inject({
        method: 'GET',
        url: '/api/v1/branches',
        headers: authHeaders(token),
      });

      expect(response.statusCode).toBe(200);
      const ids = response.json().data.map((branch: { id: string }) => branch.id);
      expect(ids.sort()).toEqual([...kababjees.branchIds].sort());
    });

    it('hides another tenant\'s branch behind a 404, even with a valid id', async () => {
      const token = await login(context.app, kababjees.users.owner!.email);
      const foreignBranchId = homeKitchen.branchIds[0]!;

      const response = await context.app.inject({
        method: 'GET',
        url: `/api/v1/branches/${foreignBranchId}`,
        headers: authHeaders(token),
      });

      // 404 rather than 403: distinguishing "exists elsewhere" from "does not
      // exist" would let an attacker enumerate ids across tenants.
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');
    });

    it('refuses to modify another tenant\'s branch', async () => {
      const token = await login(context.app, kababjees.users.owner!.email);
      const foreignBranchId = homeKitchen.branchIds[0]!;

      const response = await context.app.inject({
        method: 'PATCH',
        url: `/api/v1/branches/${foreignBranchId}`,
        headers: authHeaders(token),
        payload: { name: 'Hijacked' },
      });

      expect(response.statusCode).toBe(404);

      const untouched = await context.admin.branch.findUniqueOrThrow({
        where: { id: foreignBranchId },
      });
      expect(untouched.name).toBe('main');
    });

    it('does not expose another tenant\'s staff', async () => {
      const token = await login(context.app, kababjees.users.owner!.email);

      const response = await context.app.inject({
        method: 'GET',
        url: '/api/v1/staff',
        headers: authHeaders(token),
      });

      expect(response.statusCode).toBe(200);
      const emails = response
        .json()
        .data.map((member: { user: { email: string } }) => member.user.email);

      expect(emails).toContain(kababjees.users.owner!.email);
      expect(emails).not.toContain(homeKitchen.users.owner!.email);
    });

    it('rejects an unauthenticated request', async () => {
      const response = await context.app.inject({ method: 'GET', url: '/api/v1/branches' });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    });

    it('rejects a token that has been tampered with', async () => {
      const token = await login(context.app, kababjees.users.owner!.email);
      const tampered = `${token.slice(0, -3)}abc`;

      const response = await context.app.inject({
        method: 'GET',
        url: '/api/v1/branches',
        headers: authHeaders(tampered),
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('branch scoping (spec 7)', () => {
    it('confines a branch-scoped cashier to their assigned branch', async () => {
      const token = await login(context.app, kababjees.users.cashier!.email);

      const response = await context.app.inject({
        method: 'GET',
        url: '/api/v1/branches',
        headers: authHeaders(token),
      });

      expect(response.statusCode).toBe(200);
      const ids = response.json().data.map((branch: { id: string }) => branch.id);
      expect(ids).toEqual([kababjees.branchIds[0]]);
      expect(ids).not.toContain(kababjees.branchIds[1]);
    });

    it('denies a cashier access to a sibling branch in the same tenant', async () => {
      const token = await login(context.app, kababjees.users.cashier!.email);

      const response = await context.app.inject({
        method: 'GET',
        url: `/api/v1/branches/${kababjees.branchIds[1]}`,
        headers: authHeaders(token),
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('BRANCH_ACCESS_DENIED');
    });

    it('gives an owner access to every branch in their organization', async () => {
      const token = await login(context.app, kababjees.users.owner!.email);

      for (const branchId of kababjees.branchIds) {
        const response = await context.app.inject({
          method: 'GET',
          url: `/api/v1/branches/${branchId}`,
          headers: authHeaders(token),
        });
        expect(response.statusCode).toBe(200);
      }
    });
  });

  describe('permissions (spec 61.4)', () => {
    it('refuses branch creation to a cashier', async () => {
      const token = await login(context.app, kababjees.users.cashier!.email);

      const response = await context.app.inject({
        method: 'POST',
        url: '/api/v1/branches',
        headers: authHeaders(token),
        payload: { name: 'Unauthorised', slug: 'unauthorised' },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('PERMISSION_DENIED');
    });

    it('refuses staff listing to kitchen staff', async () => {
      const token = await login(context.app, kababjees.users.kitchen!.email);

      const response = await context.app.inject({
        method: 'GET',
        url: '/api/v1/staff',
        headers: authHeaders(token),
      });

      expect(response.statusCode).toBe(403);
    });

    it('allows an owner to create a branch', async () => {
      const token = await login(context.app, kababjees.users.owner!.email);

      const response = await context.app.inject({
        method: 'POST',
        url: '/api/v1/branches',
        headers: authHeaders(token),
        payload: { name: 'Gulshan', slug: 'gulshan' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().data.tenantId).toBe(kababjees.organizationId);
    });

    it('ignores a tenantId supplied in the request body (spec 6)', async () => {
      const token = await login(context.app, kababjees.users.owner!.email);

      const response = await context.app.inject({
        method: 'POST',
        url: '/api/v1/branches',
        headers: authHeaders(token),
        payload: {
          name: 'Injected',
          slug: 'injected',
          // A client attempting to plant the branch in another tenant.
          tenantId: homeKitchen.organizationId,
        },
      });

      expect(response.statusCode).toBe(201);
      // Zod strips the unknown key and the service takes tenantId from the
      // session, so the branch lands in the caller's own organization.
      expect(response.json().data.tenantId).toBe(kababjees.organizationId);
    });
  });

  /**
   * The independent proof. No application code is involved: these queries run
   * as the application role with the tenant context set by hand and no WHERE
   * clause, which is exactly what a forgotten filter looks like.
   */
  describe('database-level enforcement, with no application filter', () => {
    let appConnection: PrismaClient;

    beforeAll(() => {
      appConnection = new PrismaClient({
        datasources: { db: { url: process.env.DATABASE_URL } },
      });
    });

    afterAll(async () => {
      await appConnection.$disconnect();
    });

    it('connects as a role that cannot bypass RLS', async () => {
      const [privileges] = await appConnection.$queryRaw<
        Array<{ is_superuser: boolean; can_bypass_rls: boolean; owns_tables: boolean }>
      >`
        SELECT
          COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS is_superuser,
          COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false) AS can_bypass_rls,
          EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user) AS owns_tables
      `;

      // If any of these were true, every assertion below would pass
      // vacuously — RLS would simply not be applying.
      expect(privileges?.is_superuser).toBe(false);
      expect(privileges?.can_bypass_rls).toBe(false);
      expect(privileges?.owns_tables).toBe(false);
    });

    it('returns nothing at all when no tenant context is set', async () => {
      const rows = await appConnection.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.tenant_id', '', true)`;
        return tx.branch.findMany();
      });

      // Fail closed: absent context means no rows, never all rows.
      expect(rows).toEqual([]);
    });

    it('returns only the current tenant\'s rows for an unfiltered query', async () => {
      const rows = await appConnection.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.tenant_id', ${kababjees.organizationId}, true)`;
        // Deliberately no WHERE clause — the mistake this layer exists to catch.
        return tx.branch.findMany();
      });

      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((branch) => branch.tenantId === kababjees.organizationId)).toBe(true);
      expect(rows.some((branch) => branch.tenantId === homeKitchen.organizationId)).toBe(false);
    });

    it('cannot read another tenant\'s row even when asked for it by id', async () => {
      const foreignBranchId = homeKitchen.branchIds[0]!;

      const row = await appConnection.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.tenant_id', ${kababjees.organizationId}, true)`;
        return tx.branch.findUnique({ where: { id: foreignBranchId } });
      });

      expect(row).toBeNull();
    });

    it('cannot update another tenant\'s row', async () => {
      const foreignBranchId = homeKitchen.branchIds[0]!;

      const result = await appConnection.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.tenant_id', ${kababjees.organizationId}, true)`;
        return tx.branch.updateMany({
          where: { id: foreignBranchId },
          data: { name: 'Hijacked' },
        });
      });

      expect(result.count).toBe(0);

      const untouched = await context.admin.branch.findUniqueOrThrow({
        where: { id: foreignBranchId },
      });
      expect(untouched.name).toBe('main');
    });

    it('cannot delete another tenant\'s row', async () => {
      const foreignBranchId = homeKitchen.branchIds[0]!;

      const result = await appConnection.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.tenant_id', ${kababjees.organizationId}, true)`;
        return tx.branch.deleteMany({ where: { id: foreignBranchId } });
      });

      expect(result.count).toBe(0);
      await expect(
        context.admin.branch.findUniqueOrThrow({ where: { id: foreignBranchId } }),
      ).resolves.toBeTruthy();
    });

    it('refuses to insert a row belonging to another tenant', async () => {
      // The WITH CHECK clause rejects the write rather than silently
      // relabelling it.
      await expect(
        appConnection.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.tenant_id', ${kababjees.organizationId}, true)`;
          return tx.branch.create({
            data: {
              tenantId: homeKitchen.organizationId,
              name: 'Planted',
              slug: `planted-${Date.now()}`,
            },
          });
        }),
      ).rejects.toThrow();
    });

    it('keeps audit_logs append-only', async () => {
      const auditRow = await context.admin.auditLog.create({
        data: {
          tenantId: kababjees.organizationId,
          action: 'UPDATE',
          entityType: 'Branch',
          entityId: kababjees.branchIds[0]!,
        },
      });

      const updated = await appConnection.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.tenant_id', ${kababjees.organizationId}, true)`;
        return tx.auditLog.updateMany({
          where: { id: auditRow.id },
          data: { entityType: 'Rewritten' },
        });
      });

      // No UPDATE policy exists, so the rewrite matches nothing.
      expect(updated.count).toBe(0);

      const stillOriginal = await context.admin.auditLog.findUniqueOrThrow({
        where: { id: auditRow.id },
      });
      expect(stillOriginal.entityType).toBe('Branch');
    });
  });
});
