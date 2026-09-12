/**
 * System roles (ENGINEERING_SPEC.md 9).
 *
 * These are seeded platform-wide with `tenant_id = NULL`. Tenants may later
 * define custom roles scoped to themselves, which is why `roles.tenant_id`
 * is nullable.
 */
export const SystemRole = {
  PLATFORM_ADMIN: 'PLATFORM_ADMIN',
  OWNER: 'OWNER',
  REGIONAL_MANAGER: 'REGIONAL_MANAGER',
  BRANCH_MANAGER: 'BRANCH_MANAGER',
  CASHIER: 'CASHIER',
  KITCHEN_STAFF: 'KITCHEN_STAFF',
  DELIVERY_RIDER: 'DELIVERY_RIDER',
  VIEWER: 'VIEWER',
} as const;

export type SystemRole = (typeof SystemRole)[keyof typeof SystemRole];

export const ALL_SYSTEM_ROLES = Object.values(SystemRole);

/**
 * Roles whose access is confined to explicitly assigned branches.
 *
 * A user holding only these roles must have their queries additionally
 * constrained by `membership_branches` (ENGINEERING_SPEC.md 7:
 * `order.branch_id IN authorizedBranches`). Roles absent from this set see
 * every branch in their organization.
 */
export const BRANCH_SCOPED_ROLES: ReadonlySet<SystemRole> = new Set([
  SystemRole.BRANCH_MANAGER,
  SystemRole.CASHIER,
  SystemRole.KITCHEN_STAFF,
  SystemRole.DELIVERY_RIDER,
]);
