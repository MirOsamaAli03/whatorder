import { SystemRole } from '@restaurant-os/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authHeaders,
  cleanupTenants,
  createTenant,
  createTestContext,
  ensureReferenceData,
  login,
  TEST_PASSWORD,
  type TestContext,
  type TestTenant,
} from './helpers/test-context';

/**
 * Authentication and session handling (ENGINEERING_SPEC.md 5, 60, 66).
 *
 * The refresh-rotation tests are the ones that matter most: token theft is
 * only detectable if a rotated token is never silently accepted a second time.
 */
describe('authentication', () => {
  let context: TestContext;
  let tenant: TestTenant;
  const created: TestTenant[] = [];

  beforeAll(async () => {
    context = await createTestContext();
    await ensureReferenceData(context.admin);

    tenant = await createTenant(context.admin, {
      slug: 'auth-tests',
      branchSlugs: ['main'],
      users: [
        { key: 'owner', role: SystemRole.OWNER },
        { key: 'cashier', role: SystemRole.CASHIER, branches: [0] },
      ],
    });
    created.push(tenant);
  });

  afterAll(async () => {
    await cleanupTenants(context.admin, created);
    await context.close();
  });

  describe('login', () => {
    it('issues an access token and sets an httpOnly refresh cookie', async () => {
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: tenant.users.owner!.email, password: TEST_PASSWORD },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(body.data.accessToken).toBeTruthy();
      expect(body.data.organization.id).toBe(tenant.organizationId);
      expect(body.data.permissions).toContain('orders.view');

      const setCookie = String(response.headers['set-cookie']);
      expect(setCookie).toContain('ros_refresh=');
      // Not readable by script, and not sent on cross-site requests.
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Lax');
    });

    it('never returns the password hash or the refresh token in the body', async () => {
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: tenant.users.owner!.email, password: TEST_PASSWORD },
      });

      const raw = response.body;
      expect(raw).not.toContain('passwordHash');
      expect(raw).not.toContain('$argon2');
      expect(response.json().data.refreshToken).toBeUndefined();
    });

    it('rejects a wrong password', async () => {
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: tenant.users.owner!.email, password: 'WrongPassword123!' },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('INVALID_CREDENTIALS');
    });

    it('gives an unknown email the same answer as a wrong password', async () => {
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'nobody@nowhere.test', password: TEST_PASSWORD },
      });

      // Identical code and message: the response must not reveal whether an
      // address is registered.
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('INVALID_CREDENTIALS');
      expect(response.json().error.message).toBe('Invalid email or password');
    });

    it('records a failed attempt in the audit trail', async () => {
      await context.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: tenant.users.cashier!.email, password: 'WrongPassword123!' },
      });

      const entries = await context.admin.auditLog.findMany({
        where: { action: 'LOGIN_FAILED', actorId: tenant.users.cashier!.userId },
      });

      expect(entries.length).toBeGreaterThan(0);
      // The attempted password must never be written down.
      expect(JSON.stringify(entries)).not.toContain('WrongPassword123!');
    });

    it('rejects a malformed payload with a field-level error', async () => {
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'not-an-email', password: '' },
      });

      expect(response.statusCode).toBe(422);
      const error = response.json().error;
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.details.map((detail: { path: string }) => detail.path).sort()).toEqual([
        'email',
        'password',
      ]);
    });
  });

  describe('refresh rotation', () => {
    async function loginRaw(email: string) {
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: TEST_PASSWORD },
      });
      const cookie = String(response.headers['set-cookie']).split(';')[0]!;
      return { accessToken: response.json().data.accessToken as string, cookie };
    }

    it('exchanges a refresh cookie for a new access token', async () => {
      const { cookie } = await loginRaw(tenant.users.owner!.email);

      const response = await context.app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { cookie },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.accessToken).toBeTruthy();
      // Rotation: a new refresh token replaces the old one.
      expect(String(response.headers['set-cookie'])).toContain('ros_refresh=');
    });

    it('revokes the whole chain when a rotated token is replayed', async () => {
      const { cookie } = await loginRaw(tenant.users.owner!.email);

      const first = await context.app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { cookie },
        payload: {},
      });
      expect(first.statusCode).toBe(200);

      // Replaying the original token is the signature of a stolen credential.
      const replay = await context.app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { cookie },
        payload: {},
      });

      expect(replay.statusCode).toBe(401);
      expect(replay.json().error.code).toBe('SESSION_REVOKED');

      // And the token the attacker's victim received is dead too, so the
      // legitimate user is forced to sign in again rather than sharing a
      // session with whoever stole it.
      const rotatedCookie = String(first.headers['set-cookie']).split(';')[0]!;
      const afterBreach = await context.app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { cookie: rotatedCookie },
        payload: {},
      });
      expect(afterBreach.statusCode).toBe(401);
    });

    it('rejects an access token presented at the refresh endpoint', async () => {
      const { accessToken } = await loginRaw(tenant.users.owner!.email);

      const response = await context.app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken: accessToken },
      });

      // Separate signing secrets make this structurally impossible, not merely
      // checked.
      expect(response.statusCode).toBe(401);
    });
  });

  describe('session lifecycle', () => {
    it('returns the caller\'s grants from /auth/me', async () => {
      const token = await login(context.app, tenant.users.cashier!.email);

      const response = await context.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: authHeaders(token),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json().data;
      expect(body.tenantId).toBe(tenant.organizationId);
      expect(body.roles).toEqual([SystemRole.CASHIER]);
      expect(body.branchIds).toEqual([tenant.branchIds[0]]);
      expect(body.isPlatformAdmin).toBe(false);
    });

    it('invalidates the access token immediately after logout', async () => {
      const token = await login(context.app, tenant.users.owner!.email);

      const before = await context.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: authHeaders(token),
      });
      expect(before.statusCode).toBe(200);

      await context.app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: authHeaders(token),
      });

      // The session is checked on every request, so revocation takes effect at
      // once rather than when the token would have expired.
      const after = await context.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: authHeaders(token),
      });
      expect(after.statusCode).toBe(401);
      expect(after.json().error.code).toBe('SESSION_REVOKED');
    });

    it('revokes live sessions when a membership is suspended', async () => {
      const cashierToken = await login(context.app, tenant.users.cashier!.email);
      const ownerToken = await login(context.app, tenant.users.owner!.email);

      const suspend = await context.app.inject({
        method: 'PATCH',
        url: `/api/v1/staff/${tenant.users.cashier!.membershipId}`,
        headers: authHeaders(ownerToken),
        payload: { status: 'SUSPENDED' },
      });
      expect(suspend.statusCode).toBe(200);

      const after = await context.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: authHeaders(cashierToken),
      });
      expect(after.statusCode).toBe(401);

      // Restore for any later test in this file.
      await context.admin.membership.update({
        where: { id: tenant.users.cashier!.membershipId },
        data: { status: 'ACTIVE' },
      });
    });
  });

  describe('privilege escalation', () => {
    it('stops a non-owner from granting a role they do not hold', async () => {
      // A branch manager has staff.manage but not organization.manage, so they
      // must not be able to mint an OWNER.
      const manager = await createTenant(context.admin, {
        slug: 'escalation',
        branchSlugs: ['main'],
        users: [
          { key: 'manager', role: SystemRole.BRANCH_MANAGER, branches: [0] },
          { key: 'target', role: SystemRole.CASHIER, branches: [0] },
        ],
      });
      created.push(manager);

      const managerToken = await login(context.app, manager.users.manager!.email);

      const response = await context.app.inject({
        method: 'PATCH',
        url: `/api/v1/staff/${manager.users.target!.membershipId}`,
        headers: authHeaders(managerToken),
        payload: { roleNames: [SystemRole.OWNER] },
      });

      // A branch manager lacks staff.manage entirely, so this is refused
      // before the escalation check is even reached.
      expect(response.statusCode).toBe(403);

      const unchanged = await context.admin.membershipRole.findMany({
        where: { membershipId: manager.users.target!.membershipId },
        include: { role: true },
      });
      expect(unchanged.map((entry) => entry.role.name)).toEqual([SystemRole.CASHIER]);
    });

    it('stops a member from editing their own roles', async () => {
      const token = await login(context.app, tenant.users.owner!.email);
      const ownerMembershipId = tenant.users.owner!.membershipId;

      const response = await context.app.inject({
        method: 'PATCH',
        url: `/api/v1/staff/${ownerMembershipId}`,
        headers: authHeaders(token),
        payload: { roleNames: [SystemRole.VIEWER] },
      });

      // Otherwise an owner can demote themselves and lock the organization out
      // of its own account.
      expect(response.statusCode).toBe(403);
    });
  });
});
