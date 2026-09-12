/**
 * Enumerations shared between the API, the workers and the front ends.
 *
 * These mirror the Prisma enums in packages/database/prisma/schema.prisma.
 * `packages/database/src/__tests__/enum-parity.test.ts` asserts the two stay
 * in step, so drift fails CI rather than surfacing as a runtime cast error.
 */

/** ENGINEERING_SPEC.md 9 — organizations.type */
export const OrganizationType = {
  RESTAURANT: 'RESTAURANT',
  CHAIN: 'CHAIN',
  HOME_KITCHEN: 'HOME_KITCHEN',
  FOOD_VENDOR: 'FOOD_VENDOR',
} as const;
export type OrganizationType = (typeof OrganizationType)[keyof typeof OrganizationType];

export const OrganizationStatus = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  CANCELLED: 'CANCELLED',
} as const;
export type OrganizationStatus = (typeof OrganizationStatus)[keyof typeof OrganizationStatus];

export const BranchStatus = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  TEMPORARILY_CLOSED: 'TEMPORARILY_CLOSED',
} as const;
export type BranchStatus = (typeof BranchStatus)[keyof typeof BranchStatus];

export const UserStatus = {
  ACTIVE: 'ACTIVE',
  INVITED: 'INVITED',
  SUSPENDED: 'SUSPENDED',
  DISABLED: 'DISABLED',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const MembershipStatus = {
  ACTIVE: 'ACTIVE',
  INVITED: 'INVITED',
  SUSPENDED: 'SUSPENDED',
  REMOVED: 'REMOVED',
} as const;
export type MembershipStatus = (typeof MembershipStatus)[keyof typeof MembershipStatus];

/**
 * Language (plan 2.3). Absent from spec v1 but required for this market:
 * customers write Roman Urdu, and WhatsApp templates are approved per language.
 */
export const Language = {
  EN: 'EN',
  UR: 'UR',
  /** Urdu written in Latin script — "2 chicken burger aur ek coke". */
  UR_ROMAN: 'UR_ROMAN',
} as const;
export type Language = (typeof Language)[keyof typeof Language];

/**
 * Customer-facing state of a menu item (ENGINEERING_SPEC.md 10).
 *
 * Three states rather than the spec's single `is_available` boolean, because
 * the spec's own prose requires all three and they mean different things to a
 * customer:
 *   AVAILABLE    — listed and orderable
 *   OUT_OF_STOCK — listed, visibly unavailable, not orderable ("sold out")
 *   HIDDEN       — not listed at all
 *
 * Distinct from `is_active`, which archives an item for administrators. An
 * archived item disappears from management screens; a HIDDEN one is still
 * managed, just not offered today.
 */
export const MenuItemAvailability = {
  AVAILABLE: 'AVAILABLE',
  OUT_OF_STOCK: 'OUT_OF_STOCK',
  HIDDEN: 'HIDDEN',
} as const;
export type MenuItemAvailability =
  (typeof MenuItemAvailability)[keyof typeof MenuItemAvailability];

/** How many options a customer may pick from a modifier group. */
export const ModifierSelectionType = {
  SINGLE: 'SINGLE',
  MULTIPLE: 'MULTIPLE',
} as const;
export type ModifierSelectionType =
  (typeof ModifierSelectionType)[keyof typeof ModifierSelectionType];

/** Delivery state of an outbox row (ENGINEERING_SPEC.md 58). */
export const OutboxStatus = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  PROCESSED: 'PROCESSED',
  FAILED: 'FAILED',
} as const;
export type OutboxStatus = (typeof OutboxStatus)[keyof typeof OutboxStatus];

/** Audit trail actions (ENGINEERING_SPEC.md 59). */
export const AuditAction = {
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
  LOGIN: 'LOGIN',
  LOGIN_FAILED: 'LOGIN_FAILED',
  LOGOUT: 'LOGOUT',
  PERMISSION_CHANGE: 'PERMISSION_CHANGE',
  PRICE_CHANGE: 'PRICE_CHANGE',
  AVAILABILITY_CHANGE: 'AVAILABILITY_CHANGE',
  ORDER_TRANSITION: 'ORDER_TRANSITION',
  REFUND: 'REFUND',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

/** Where an order came from (ENGINEERING_SPEC.md 12). */
export const OrderSource = {
  WHATSAPP: 'WHATSAPP',
  WEBSITE: 'WEBSITE',
  QR: 'QR',
  POS: 'POS',
  PHONE: 'PHONE',
  ADMIN: 'ADMIN',
} as const;
export type OrderSource = (typeof OrderSource)[keyof typeof OrderSource];

/** How the customer receives it (ENGINEERING_SPEC.md 12). */
export const OrderType = {
  DELIVERY: 'DELIVERY',
  PICKUP: 'PICKUP',
  DINE_IN: 'DINE_IN',
} as const;
export type OrderType = (typeof OrderType)[keyof typeof OrderType];

/**
 * Fulfilment state (ENGINEERING_SPEC.md 15).
 *
 * Deliberately orthogonal to PaymentStatus (plan 2.5). Spec v1 mixes the two by
 * listing REFUNDED and PAYMENT_FAILED alongside PREPARING and READY, which
 * forces impossible questions — a refunded order that is still being cooked has
 * no single status. Money state lives in PaymentStatus; this enum only ever
 * describes where the food is.
 *
 * Two states beyond spec v1:
 *   DELIVERY_FAILED — real deliveries fail (wrong address, nobody home), and
 *                     spec v1 offers only DELIVERED or CANCELLED as exits.
 *   RETURNED        — where a failed delivery ends when it is not re-dispatched.
 */
export const OrderStatus = {
  /** Being assembled. A cart becomes this only at checkout. */
  DRAFT: 'DRAFT',
  /** Awaiting an online payment. COD orders never enter this state. */
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  /** Placed and owed to the restaurant. The acknowledgement clock starts here. */
  CONFIRMED: 'CONFIRMED',
  ACCEPTED: 'ACCEPTED',
  PREPARING: 'PREPARING',
  READY: 'READY',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  /** Terminal for pickup and dine-in. */
  COMPLETED: 'COMPLETED',
  DELIVERY_FAILED: 'DELIVERY_FAILED',
  RETURNED: 'RETURNED',
  /** Cancelled by the customer or by staff. */
  CANCELLED: 'CANCELLED',
  /** Refused by the restaurant. */
  REJECTED: 'REJECTED',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

/**
 * Money state of an order, independent of fulfilment.
 *
 * UNPAID is the normal resting state of a cash order all the way to the door;
 * it is not an error condition.
 */
export const PaymentStatus = {
  UNPAID: 'UNPAID',
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

/** How the customer intends to pay (ENGINEERING_SPEC.md 18). */
export const PaymentMethod = {
  /** Cash on delivery or on collection. First-class, not a fallback. */
  CASH: 'CASH',
  CARD_ON_DELIVERY: 'CARD_ON_DELIVERY',
  ONLINE: 'ONLINE',
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

/** Lifecycle of a cart (ENGINEERING_SPEC.md 27). */
export const CartStatus = {
  ACTIVE: 'ACTIVE',
  /** Converted into an order. Kept for a while for support and analytics. */
  CHECKED_OUT: 'CHECKED_OUT',
  ABANDONED: 'ABANDONED',
} as const;
export type CartStatus = (typeof CartStatus)[keyof typeof CartStatus];

/** How a delivery zone describes its area (ENGINEERING_SPEC.md 29). */
export const DeliveryZoneType = {
  /** Circle around a point. The only shape supported today. */
  RADIUS: 'RADIUS',
} as const;
export type DeliveryZoneType = (typeof DeliveryZoneType)[keyof typeof DeliveryZoneType];

/** Lifecycle of an idempotency key (ENGINEERING_SPEC.md 17). */
export const IdempotencyStatus = {
  /** Claimed by a request that has not finished yet. */
  IN_PROGRESS: 'IN_PROGRESS',
  /** Finished; the recorded response is replayed to any retry. */
  COMPLETED: 'COMPLETED',
} as const;
export type IdempotencyStatus = (typeof IdempotencyStatus)[keyof typeof IdempotencyStatus];

/**
 * Who an escalation reaches when an order goes unacknowledged
 * (ENGINEERING_SPEC.md 33). Each rung is louder than the last.
 */
export const EscalationTarget = {
  KITCHEN: 'KITCHEN',
  BRANCH_MANAGER: 'BRANCH_MANAGER',
  OWNER: 'OWNER',
} as const;
export type EscalationTarget = (typeof EscalationTarget)[keyof typeof EscalationTarget];

// ---------------------------------------------------------------------------
// Notifications (ENGINEERING_SPEC.md 30, 31, 32)
// ---------------------------------------------------------------------------

/** Where a notification is delivered (ENGINEERING_SPEC.md 30). */
export const NotificationChannel = {
  WHATSAPP: 'WHATSAPP',
  SMS: 'SMS',
  EMAIL: 'EMAIL',
  PUSH: 'PUSH',
  /** In-app, shown on the dashboard. Always available and never fails. */
  DASHBOARD: 'DASHBOARD',
} as const;
export type NotificationChannel = (typeof NotificationChannel)[keyof typeof NotificationChannel];

export const NotificationStatus = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  SENT: 'SENT',
  /** The provider confirmed delivery to the handset. */
  DELIVERED: 'DELIVERED',
  FAILED: 'FAILED',
  /**
   * Never attempted, and never will be: no consent, no open messaging window
   * and no approved template, or the recipient opted out. Distinct from FAILED
   * so that a retry loop does not keep trying something that cannot work.
   */
  SUPPRESSED: 'SUPPRESSED',
} as const;
export type NotificationStatus = (typeof NotificationStatus)[keyof typeof NotificationStatus];

/** Who a notification is for. */
export const RecipientType = {
  CUSTOMER: 'CUSTOMER',
  /** A member of staff, resolved from a role at send time. */
  STAFF: 'STAFF',
} as const;
export type RecipientType = (typeof RecipientType)[keyof typeof RecipientType];

// ---------------------------------------------------------------------------
// WhatsApp (plan 2.2)
// ---------------------------------------------------------------------------

/**
 * Meta's template categories, which price and gate differently.
 *
 * UTILITY covers order updates — the bulk of what this platform sends.
 * MARKETING requires demonstrable opt-in, which is why consent is tracked
 * separately rather than assumed.
 */
export const WhatsAppTemplateCategory = {
  UTILITY: 'UTILITY',
  MARKETING: 'MARKETING',
  AUTHENTICATION: 'AUTHENTICATION',
} as const;
export type WhatsAppTemplateCategory =
  (typeof WhatsAppTemplateCategory)[keyof typeof WhatsAppTemplateCategory];

/**
 * Approval state of a template at the provider.
 *
 * Approval is asynchronous and can be REJECTED, which is an onboarding blocker
 * a restaurant has to see rather than discover when a message silently fails.
 */
export const WhatsAppTemplateStatus = {
  DRAFT: 'DRAFT',
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  /** Approved once, then paused by Meta for quality reasons. */
  PAUSED: 'PAUSED',
  DISABLED: 'DISABLED',
} as const;
export type WhatsAppTemplateStatus =
  (typeof WhatsAppTemplateStatus)[keyof typeof WhatsAppTemplateStatus];

export const MessageDirection = {
  INBOUND: 'INBOUND',
  OUTBOUND: 'OUTBOUND',
} as const;
export type MessageDirection = (typeof MessageDirection)[keyof typeof MessageDirection];

/**
 * How a WhatsApp message was sent.
 *
 * SESSION is a free-form reply inside the 24-hour customer service window;
 * TEMPLATE is a pre-approved message, the only thing permitted outside it
 * (plan 2.2).
 */
export const WhatsAppSendMode = {
  SESSION: 'SESSION',
  TEMPLATE: 'TEMPLATE',
} as const;
export type WhatsAppSendMode = (typeof WhatsAppSendMode)[keyof typeof WhatsAppSendMode];

/** Consent to be contacted on a channel, per ENGINEERING_SPEC.md 51 and Meta policy. */
export const ConsentStatus = {
  GRANTED: 'GRANTED',
  REVOKED: 'REVOKED',
} as const;
export type ConsentStatus = (typeof ConsentStatus)[keyof typeof ConsentStatus];
