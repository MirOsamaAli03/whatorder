import { describe, expect, it } from 'vitest';
import { Permission, SystemRole, type AuthContext } from '@restaurant-os/types';
import {
  ROLE_PERMISSIONS,
  belongsToTenant,
  canAccessBranch,
  hasAllPermissions,
  hasAnyPermission,
  hasPermission,
  isBranchScoped,
  resolvePermissions,
} from './authorization';

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'user-1',
    sessionId: 'session-1',
    tenantId: 'tenant-1',
    membershipId: 'membership-1',
    roles: [SystemRole.OWNER],
    permissions: resolvePermissions([SystemRole.OWNER]),
    branchIds: null,
    isPlatformAdmin: false,
    ...overrides,
  };
}

describe('resolvePermissions', () => {
  it('grants the union of all supplied roles', () => {
    const permissions = resolvePermissions([SystemRole.KITCHEN_STAFF, SystemRole.CASHIER]);
    expect(permissions).toContain(Permission.ORDERS_CREATE); // cashier only
    expect(permissions).toContain(Permission.ORDERS_UPDATE); // both
    expect(permissions).not.toContain(Permission.MENU_DELETE);
  });

  it('deduplicates overlapping grants', () => {
    const permissions = resolvePermissions([SystemRole.OWNER, SystemRole.OWNER]);
    expect(new Set(permissions).size).toBe(permissions.length);
  });

  it('ignores unknown role names instead of throwing', () => {
    expect(resolvePermissions(['NOT_A_REAL_ROLE'])).toEqual([]);
  });

  it('grants nothing for an empty role list', () => {
    expect(resolvePermissions([])).toEqual([]);
  });
});

describe('role grants', () => {
  it('withholds refund from everyone except owner and platform admin', () => {
    const canRefund = Object.entries(ROLE_PERMISSIONS)
      .filter(([, permissions]) => permissions.includes(Permission.PAYMENTS_REFUND))
      .map(([role]) => role);
    expect(canRefund.sort()).toEqual([SystemRole.OWNER, SystemRole.PLATFORM_ADMIN].sort());
  });

  it('withholds customer data from kitchen staff (spec 11)', () => {
    const kitchen = ROLE_PERMISSIONS[SystemRole.KITCHEN_STAFF];
    expect(kitchen).not.toContain(Permission.CUSTOMERS_VIEW);
    expect(kitchen).not.toContain(Permission.PAYMENTS_VIEW);
  });

  it('gives the viewer role no mutating permission', () => {
    const mutating = ROLE_PERMISSIONS[SystemRole.VIEWER].filter((permission) =>
      /\.(create|update|delete|cancel|manage|refund)$/.test(permission),
    );
    expect(mutating).toEqual([]);
  });

  it('never grants platform.manage to a tenant role', () => {
    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      if (role === SystemRole.PLATFORM_ADMIN) continue;
      expect(permissions, role).not.toContain(Permission.PLATFORM_MANAGE);
    }
  });
});

describe('hasPermission', () => {
  it('accepts a granted permission and rejects a withheld one', () => {
    const cashier = auth({
      roles: [SystemRole.CASHIER],
      permissions: resolvePermissions([SystemRole.CASHIER]),
    });
    expect(hasPermission(cashier, Permission.ORDERS_CREATE)).toBe(true);
    expect(hasPermission(cashier, Permission.PAYMENTS_REFUND)).toBe(false);
  });

  it('requires every permission for hasAllPermissions', () => {
    const cashier = auth({
      roles: [SystemRole.CASHIER],
      permissions: resolvePermissions([SystemRole.CASHIER]),
    });
    expect(hasAllPermissions(cashier, [Permission.ORDERS_VIEW, Permission.ORDERS_CREATE])).toBe(
      true,
    );
    expect(hasAllPermissions(cashier, [Permission.ORDERS_VIEW, Permission.MENU_DELETE])).toBe(false);
    expect(hasAnyPermission(cashier, [Permission.MENU_DELETE, Permission.ORDERS_VIEW])).toBe(true);
  });
});

describe('branch scoping (spec 7)', () => {
  it('allows any branch when access is organization-wide', () => {
    expect(canAccessBranch(auth({ branchIds: null }), 'branch-anything')).toBe(true);
  });

  it('confines a branch-scoped user to their assigned branches', () => {
    const cashier = auth({ branchIds: ['branch-dha'] });
    expect(canAccessBranch(cashier, 'branch-dha')).toBe(true);
    expect(canAccessBranch(cashier, 'branch-clifton')).toBe(false);
  });

  it('denies everything for a branch-scoped user with no branch assigned', () => {
    // The safe failure mode: a newly invited cashier sees nothing rather than
    // everything.
    expect(canAccessBranch(auth({ branchIds: [] }), 'branch-dha')).toBe(false);
  });

  it('classifies roles as branch-scoped only when every role is', () => {
    expect(isBranchScoped([SystemRole.CASHIER])).toBe(true);
    expect(isBranchScoped([SystemRole.KITCHEN_STAFF, SystemRole.CASHIER])).toBe(true);
    // Organization-wide access wins when combined.
    expect(isBranchScoped([SystemRole.CASHIER, SystemRole.OWNER])).toBe(false);
    expect(isBranchScoped([SystemRole.OWNER])).toBe(false);
    // No roles at all means no organization-wide grant.
    expect(isBranchScoped([])).toBe(true);
  });
});

describe('tenant isolation (invariant 10)', () => {
  it('rejects a resource from another tenant', () => {
    const user = auth({ tenantId: 'tenant-kababjees' });
    expect(belongsToTenant(user, 'tenant-kababjees')).toBe(true);
    expect(belongsToTenant(user, 'tenant-ali-home-kitchen')).toBe(false);
  });

  it('does not give platform admins an implicit cross-tenant pass', () => {
    // Cross-tenant reads must go through an audited platform endpoint, not
    // leak through ordinary tenant-scoped handlers.
    const platformAdmin = auth({ tenantId: 'tenant-a', isPlatformAdmin: true });
    expect(belongsToTenant(platformAdmin, 'tenant-b')).toBe(false);
  });
});
