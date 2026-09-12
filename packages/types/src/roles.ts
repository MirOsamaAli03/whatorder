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

  /**
   * The WhatsApp conversation engine, acting on a customer's behalf.
   *
   * A channel adapter needs to read a menu and place an order, and
   * ENGINEERING_SPEC.md 21 is explicit that it must do so through the same
   * services every other channel uses. Rather than inventing a parallel
   * "system" path around authorization, the adapter is an ordinary principal
   * with an ordinary membership — which means canAccessBranch, RLS and the
   * audit trail all apply to it unchanged, the audit log names it truthfully,
   * and a restaurant can see in their staff list exactly what it may do.
   *
   * Its grants are deliberately the narrowest of any role. It can read a menu
   * and create an order; it cannot advance one through the kitchen, cancel
   * one, take a payment, or read anything it does not need.
   */
  CHANNEL_BOT: 'CHANNEL_BOT',
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
  // A WhatsApp number belongs to one branch (or serves a tenant with one), and
  // the branch is resolved from whatsapp_accounts server-side. Confining the
  // bot to it means a routing mistake cannot place an order at the wrong
  // outlet — the database refuses it rather than the adapter being trusted.
  SystemRole.CHANNEL_BOT,
]);
