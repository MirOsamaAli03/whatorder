/**
 * Permission catalogue (ENGINEERING_SPEC.md 9).
 *
 * Permissions are the unit of authorization; roles are only bundles of them.
 * Every mutating endpoint declares one via `@RequirePermission(...)`.
 */
export const Permission = {
  ORDERS_VIEW: 'orders.view',
  ORDERS_CREATE: 'orders.create',
  ORDERS_UPDATE: 'orders.update',
  ORDERS_CANCEL: 'orders.cancel',

  PAYMENTS_VIEW: 'payments.view',
  PAYMENTS_REFUND: 'payments.refund',

  MENU_VIEW: 'menu.view',
  MENU_CREATE: 'menu.create',
  MENU_UPDATE: 'menu.update',
  MENU_DELETE: 'menu.delete',

  CUSTOMERS_VIEW: 'customers.view',
  CUSTOMERS_UPDATE: 'customers.update',

  ANALYTICS_VIEW: 'analytics.view',

  BRANCHES_VIEW: 'branches.view',
  BRANCHES_MANAGE: 'branches.manage',

  STAFF_VIEW: 'staff.view',
  STAFF_MANAGE: 'staff.manage',

  RESERVATIONS_VIEW: 'reservations.view',
  RESERVATIONS_MANAGE: 'reservations.manage',

  ORGANIZATION_VIEW: 'organization.view',
  ORGANIZATION_MANAGE: 'organization.manage',

  AUDIT_VIEW: 'audit.view',

  /** Platform operator only — never granted to a tenant role. */
  PLATFORM_MANAGE: 'platform.manage',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS = Object.values(Permission);
