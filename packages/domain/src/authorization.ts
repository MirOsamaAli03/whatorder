import {
  ALL_PERMISSIONS,
  BRANCH_SCOPED_ROLES,
  Permission,
  SystemRole,
  type AuthContext,
} from '@restaurant-os/types';

/**
 * Authorization rules (ENGINEERING_SPEC.md 7, 9, 61; invariants 9 and 10).
 *
 * Pure functions with no framework or database dependency, so the rules can be
 * exhaustively unit-tested and reused identically by HTTP guards, WebSocket
 * subscription checks, queue workers and AI tool handlers. The AI layer calls
 * exactly these functions, which is what makes invariant 9 ("AI cannot bypass
 * authorization") structural rather than a matter of prompt discipline.
 */

/** Which permissions each system role grants. */
export const ROLE_PERMISSIONS: Readonly<Record<SystemRole, readonly Permission[]>> = {
  // Platform operator. Scoped by isPlatformAdmin, not by tenant membership.
  [SystemRole.PLATFORM_ADMIN]: ALL_PERMISSIONS,

  [SystemRole.OWNER]: [
    Permission.ORDERS_VIEW,
    Permission.ORDERS_CREATE,
    Permission.ORDERS_UPDATE,
    Permission.ORDERS_CANCEL,
    Permission.PAYMENTS_VIEW,
    Permission.PAYMENTS_REFUND,
    Permission.MENU_VIEW,
    Permission.MENU_CREATE,
    Permission.MENU_UPDATE,
    Permission.MENU_DELETE,
    Permission.CUSTOMERS_VIEW,
    Permission.CUSTOMERS_UPDATE,
    Permission.ANALYTICS_VIEW,
    Permission.BRANCHES_VIEW,
    Permission.BRANCHES_MANAGE,
    Permission.STAFF_VIEW,
    Permission.STAFF_MANAGE,
    Permission.RESERVATIONS_VIEW,
    Permission.RESERVATIONS_MANAGE,
    Permission.ORGANIZATION_VIEW,
    Permission.ORGANIZATION_MANAGE,
    Permission.AUDIT_VIEW,
  ],

  [SystemRole.REGIONAL_MANAGER]: [
    Permission.ORDERS_VIEW,
    Permission.ORDERS_CREATE,
    Permission.ORDERS_UPDATE,
    Permission.ORDERS_CANCEL,
    Permission.PAYMENTS_VIEW,
    Permission.MENU_VIEW,
    Permission.MENU_UPDATE,
    Permission.CUSTOMERS_VIEW,
    Permission.ANALYTICS_VIEW,
    Permission.BRANCHES_VIEW,
    Permission.STAFF_VIEW,
    Permission.RESERVATIONS_VIEW,
    Permission.RESERVATIONS_MANAGE,
    Permission.ORGANIZATION_VIEW,
  ],

  [SystemRole.BRANCH_MANAGER]: [
    Permission.ORDERS_VIEW,
    Permission.ORDERS_CREATE,
    Permission.ORDERS_UPDATE,
    Permission.ORDERS_CANCEL,
    Permission.PAYMENTS_VIEW,
    Permission.MENU_VIEW,
    Permission.MENU_UPDATE,
    Permission.CUSTOMERS_VIEW,
    Permission.ANALYTICS_VIEW,
    Permission.BRANCHES_VIEW,
    Permission.STAFF_VIEW,
    Permission.RESERVATIONS_VIEW,
    Permission.RESERVATIONS_MANAGE,
  ],

  [SystemRole.CASHIER]: [
    Permission.ORDERS_VIEW,
    Permission.ORDERS_CREATE,
    Permission.ORDERS_UPDATE,
    Permission.PAYMENTS_VIEW,
    Permission.MENU_VIEW,
    Permission.CUSTOMERS_VIEW,
    Permission.RESERVATIONS_VIEW,
    // A POS needs the branch it is operating in — its name, opening hours and
    // settings. Branch scoping already confines this to the branches the
    // cashier is assigned to, so the grant reads exactly one branch.
    Permission.BRANCHES_VIEW,
  ],

  // Deliberately cannot read customer records: a kitchen screen has no need
  // for phone numbers or addresses (ENGINEERING_SPEC.md 11).
  [SystemRole.KITCHEN_STAFF]: [
    Permission.ORDERS_VIEW,
    Permission.ORDERS_UPDATE,
    Permission.MENU_VIEW,
    // Same reasoning as the cashier: the kitchen display identifies its own
    // branch, and sees no other.
    Permission.BRANCHES_VIEW,
  ],

  [SystemRole.DELIVERY_RIDER]: [Permission.ORDERS_VIEW, Permission.ORDERS_UPDATE],

  [SystemRole.VIEWER]: [
    Permission.ORDERS_VIEW,
    Permission.MENU_VIEW,
    Permission.ANALYTICS_VIEW,
    Permission.BRANCHES_VIEW,
  ],
};

/** Union of the permissions granted by a set of role names. */
export function resolvePermissions(roleNames: readonly string[]): Permission[] {
  const granted = new Set<Permission>();
  for (const roleName of roleNames) {
    const permissions = ROLE_PERMISSIONS[roleName as SystemRole];
    if (permissions) {
      for (const permission of permissions) {
        granted.add(permission);
      }
    }
  }
  return [...granted];
}

/** True when any of the supplied roles is confined to specific branches. */
export function isBranchScoped(roleNames: readonly string[]): boolean {
  if (roleNames.length === 0) {
    return true;
  }
  // Organization-wide access wins: a branch manager who is also an owner
  // sees everything.
  return roleNames.every((role) => BRANCH_SCOPED_ROLES.has(role as SystemRole));
}

export function hasPermission(auth: AuthContext, permission: Permission): boolean {
  return auth.permissions.includes(permission);
}

export function hasAllPermissions(
  auth: AuthContext,
  permissions: readonly Permission[],
): boolean {
  return permissions.every((permission) => hasPermission(auth, permission));
}

export function hasAnyPermission(
  auth: AuthContext,
  permissions: readonly Permission[],
): boolean {
  return permissions.some((permission) => hasPermission(auth, permission));
}

/**
 * Whether the caller may act on a given branch.
 *
 * `branchIds === null` means organization-wide access. Otherwise access is
 * confined to exactly the listed branches (ENGINEERING_SPEC.md 7). An empty
 * array therefore denies everything, which is the correct failure mode for a
 * branch-scoped user who has not yet been assigned a branch.
 */
export function canAccessBranch(auth: AuthContext, branchId: string): boolean {
  if (auth.branchIds === null) {
    return true;
  }
  return auth.branchIds.includes(branchId);
}

/**
 * Whether the caller may act on a resource belonging to `tenantId`.
 *
 * Invariant 10. Note that platform admins are NOT given a blanket pass here:
 * cross-tenant reads must go through an explicitly audited platform endpoint
 * rather than leaking through ordinary tenant-scoped handlers.
 */
export function belongsToTenant(auth: AuthContext, tenantId: string): boolean {
  return auth.tenantId === tenantId;
}
