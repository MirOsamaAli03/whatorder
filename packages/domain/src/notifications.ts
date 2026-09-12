import {
  ConsentStatus,
  NotificationChannel,
  OrderStatus,
  WhatsAppSendMode,
  WhatsAppTemplateCategory,
  WhatsAppTemplateStatus,
} from '@restaurant-os/types';

/**
 * Notification rules (ENGINEERING_SPEC.md 30, 31, 32; plan 2.2).
 *
 * Pure functions, so the decisions that actually matter — may we message this
 * person, in what mode, and when do we try again — are testable without a
 * provider, a queue or a database. The worker composes them; it does not
 * re-derive them.
 */

// ---------------------------------------------------------------------------
// The 24-hour customer service window
// ---------------------------------------------------------------------------

/**
 * WhatsApp's customer service window, in milliseconds.
 *
 * A business may send free-form messages only within 24 hours of the
 * customer's last inbound message. Outside it, only a pre-approved template
 * may be sent. This single rule is the thing ENGINEERING_SPEC.md §30 omits and
 * the reason every order notification needs two forms (plan 2.2).
 */
export const WHATSAPP_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isServiceWindowOpen(lastInboundAt: Date | null, now: Date): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() < WHATSAPP_SERVICE_WINDOW_MS;
}

/** Milliseconds until the window closes, or 0 when it is already shut. */
export function serviceWindowRemainingMs(lastInboundAt: Date | null, now: Date): number {
  if (!lastInboundAt) return 0;
  const remaining =
    lastInboundAt.getTime() + WHATSAPP_SERVICE_WINDOW_MS - now.getTime();
  return Math.max(0, remaining);
}

export type SendDecision =
  | { mode: WhatsAppSendMode; reason?: undefined }
  | { mode: null; reason: string };

export interface SendModeInput {
  now: Date;
  /** When this customer last messaged the business. */
  lastInboundAt: Date | null;
  category: WhatsAppTemplateCategory;
  /** The approval state of the template this message would use, if any. */
  templateStatus: WhatsAppTemplateStatus | null;
  /** Consent state for marketing. Transactional messages do not need it. */
  marketingConsent: ConsentStatus | null;
}

/**
 * Decides how — or whether — a WhatsApp message may be sent.
 *
 * The order of the checks matters and encodes the policy:
 *
 *   1. Marketing requires demonstrable opt-in. §51 says "respect opt-out"; Meta
 *      requires opt-IN, which is stricter and is what is enforced here.
 *   2. Inside the service window, a free-form session message is allowed and is
 *      preferred: it needs no approval and reads naturally.
 *   3. Outside it, only an APPROVED template will do. A template that is still
 *      pending, or was rejected, cannot be substituted — attempting it would
 *      fail at the provider and burn a retry.
 *
 * Returning `mode: null` with a reason lets the caller record *why* nothing was
 * sent, which is the difference between a suppressed notification and a silent
 * one.
 */
export function resolveWhatsAppSendMode(input: SendModeInput): SendDecision {
  if (
    input.category === WhatsAppTemplateCategory.MARKETING &&
    input.marketingConsent !== ConsentStatus.GRANTED
  ) {
    return { mode: null, reason: 'No marketing opt-in on record for this customer' };
  }

  if (isServiceWindowOpen(input.lastInboundAt, input.now)) {
    return { mode: WhatsAppSendMode.SESSION };
  }

  if (input.templateStatus === WhatsAppTemplateStatus.APPROVED) {
    return { mode: WhatsAppSendMode.TEMPLATE };
  }

  if (input.templateStatus === null) {
    return {
      mode: null,
      reason:
        'The 24-hour service window is closed and no template is configured for this message',
    };
  }

  return {
    mode: null,
    reason: `The 24-hour service window is closed and the template is ${input.templateStatus}, not APPROVED`,
  };
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

/** Give up after this many attempts. */
export const MAX_NOTIFICATION_ATTEMPTS = 6;

/** First retry after 30s, then doubling, capped at an hour. */
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

/**
 * When to try again after a failed attempt (ENGINEERING_SPEC.md 32).
 *
 * Exponential with jitter. The jitter matters more than it looks: a provider
 * outage fails every queued notification at once, and without it they would all
 * retry in the same instant and do it again on the next round, turning a
 * recovery into a second outage.
 */
export function nextRetryAt(attempts: number, now: Date, random = Math.random): Date | null {
  if (attempts >= MAX_NOTIFICATION_ATTEMPTS) return null;

  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
  // Full jitter over the window, so retries spread rather than thunder.
  const delay = Math.floor(exponential * (0.5 + random() * 0.5));

  return new Date(now.getTime() + delay);
}

export function hasAttemptsLeft(attempts: number): boolean {
  return attempts < MAX_NOTIFICATION_ATTEMPTS;
}

// ---------------------------------------------------------------------------
// Which events notify whom
// ---------------------------------------------------------------------------

/**
 * How many of a spec's channels to actually use.
 *
 * The distinction is not a tuning knob, it is the difference between an update
 * and an alarm. An order update should arrive once, by the best available
 * means: telling a customer their food is ready over WhatsApp *and* SMS is
 * noise they did not ask for and a bill the restaurant did not need.
 *
 * An escalation is the opposite case. Plan 2.8: "an alert on the screen nobody
 * is looking at is not an alert." If the dashboard alarm is being ignored —
 * which is precisely the situation that raised it — then WhatsApp and SMS are
 * not redundant, they are the entire point.
 */
export type DeliveryMode = 'first-available' | 'all-channels';

export interface NotificationSpec {
  /** Stable key, used to look up the WhatsApp template and the copy. */
  templateKey: string;
  category: WhatsAppTemplateCategory;
  /** Ordered by preference; how many are used depends on deliveryMode. */
  channels: NotificationChannel[];
  deliveryMode: DeliveryMode;
  notifyCustomer: boolean;
  notifyStaff: boolean;
}

/**
 * What each order state change should tell people (ENGINEERING_SPEC.md 30).
 *
 * Deliberately not every status. A customer does not want to know their order
 * moved from ACCEPTED to PREPARING — that is kitchen detail — and over-messaging
 * is how a business gets its WhatsApp number blocked. The states below are the
 * ones a customer actually acts on.
 */
const ORDER_NOTIFICATIONS: Partial<Record<OrderStatus, NotificationSpec>> = {
  [OrderStatus.CONFIRMED]: {
    templateKey: 'order_confirmed',
    category: WhatsAppTemplateCategory.UTILITY,
    channels: [NotificationChannel.WHATSAPP, NotificationChannel.SMS],
    deliveryMode: 'first-available',
    notifyCustomer: true,
    // The restaurant hears about it too — this is the moment the
    // acknowledgement clock starts (spec 33).
    notifyStaff: true,
  },
  [OrderStatus.ACCEPTED]: {
    templateKey: 'order_accepted',
    category: WhatsAppTemplateCategory.UTILITY,
    channels: [NotificationChannel.WHATSAPP],
    deliveryMode: 'first-available',
    notifyCustomer: true,
    notifyStaff: false,
  },
  [OrderStatus.READY]: {
    templateKey: 'order_ready',
    category: WhatsAppTemplateCategory.UTILITY,
    channels: [NotificationChannel.WHATSAPP],
    deliveryMode: 'first-available',
    notifyCustomer: true,
    notifyStaff: false,
  },
  [OrderStatus.OUT_FOR_DELIVERY]: {
    templateKey: 'order_out_for_delivery',
    category: WhatsAppTemplateCategory.UTILITY,
    channels: [NotificationChannel.WHATSAPP],
    deliveryMode: 'first-available',
    notifyCustomer: true,
    notifyStaff: false,
  },
  [OrderStatus.DELIVERED]: {
    templateKey: 'order_delivered',
    category: WhatsAppTemplateCategory.UTILITY,
    channels: [NotificationChannel.WHATSAPP],
    deliveryMode: 'first-available',
    notifyCustomer: true,
    notifyStaff: false,
  },
  [OrderStatus.COMPLETED]: {
    templateKey: 'order_completed',
    category: WhatsAppTemplateCategory.UTILITY,
    channels: [NotificationChannel.WHATSAPP],
    deliveryMode: 'first-available',
    notifyCustomer: true,
    notifyStaff: false,
  },
  [OrderStatus.CANCELLED]: {
    templateKey: 'order_cancelled',
    category: WhatsAppTemplateCategory.UTILITY,
    channels: [NotificationChannel.WHATSAPP, NotificationChannel.SMS],
    deliveryMode: 'first-available',
    notifyCustomer: true,
    notifyStaff: true,
  },
  [OrderStatus.REJECTED]: {
    templateKey: 'order_rejected',
    category: WhatsAppTemplateCategory.UTILITY,
    channels: [NotificationChannel.WHATSAPP, NotificationChannel.SMS],
    deliveryMode: 'first-available',
    notifyCustomer: true,
    notifyStaff: true,
  },
};

export function notificationForOrderStatus(status: OrderStatus): NotificationSpec | null {
  return ORDER_NOTIFICATIONS[status] ?? null;
}

/**
 * Looks a spec up by its message key.
 *
 * The sender needs this: a notification row records the key it was created
 * from, and if a channel turns out to be unusable at send time — no WhatsApp
 * number connected, or a closed window with no approved template — the sender
 * has to know what the *next* channel was meant to be. Reconstructing that from
 * the event would mean re-reading the order; the key is already on the row.
 */
export function notificationSpecByTemplateKey(templateKey: string): NotificationSpec | null {
  if (templateKey === ESCALATION_NOTIFICATION.templateKey) return ESCALATION_NOTIFICATION;
  return (
    Object.values(ORDER_NOTIFICATIONS).find((spec) => spec.templateKey === templateKey) ?? null
  );
}

/** Statuses that notify somebody, for tests and documentation. */
export const NOTIFYING_ORDER_STATUSES = Object.keys(ORDER_NOTIFICATIONS) as OrderStatus[];

/**
 * The escalation alarm (ENGINEERING_SPEC.md 33).
 *
 * Staff only, and never WhatsApp-to-customer: this exists because the
 * restaurant has not noticed an order, and telling the customer that would be
 * worse than useless.
 */
export const ESCALATION_NOTIFICATION: NotificationSpec = {
  templateKey: 'order_unacknowledged',
  category: WhatsAppTemplateCategory.UTILITY,
  channels: [NotificationChannel.DASHBOARD, NotificationChannel.WHATSAPP, NotificationChannel.SMS],
  // Every channel at once, on purpose. See DeliveryMode above.
  deliveryMode: 'all-channels',
  notifyCustomer: false,
  notifyStaff: true,
};

// ---------------------------------------------------------------------------
// Message copy
// ---------------------------------------------------------------------------

export interface MessageVariables {
  customerName?: string | null;
  orderNumber: string;
  restaurantName: string;
  branchName?: string | null;
  total?: string | null;
  currency?: string | null;
  reason?: string | null;
}

/**
 * The plain-text body for a session message.
 *
 * Templates are registered with the provider separately and referenced by key;
 * this is the free-form wording used inside the service window, where no
 * approval is required. Both are kept here so the two cannot drift into saying
 * different things about the same event.
 */
export function renderMessageBody(templateKey: string, variables: MessageVariables): string {
  const name = variables.customerName ? `${variables.customerName}, ` : '';
  const order = variables.orderNumber;
  const restaurant = variables.restaurantName;

  switch (templateKey) {
    case 'order_confirmed':
      return `${name}thank you for your order ${order} from ${restaurant}. We have received it and will confirm shortly.`;
    case 'order_accepted':
      return `${name}your order ${order} has been accepted and is being prepared.`;
    case 'order_ready':
      return `${name}your order ${order} is ready for collection.`;
    case 'order_out_for_delivery':
      return `${name}your order ${order} is on its way.`;
    case 'order_delivered':
      return `${name}your order ${order} has been delivered. Thank you for ordering from ${restaurant}.`;
    case 'order_completed':
      return `${name}your order ${order} is complete. Thank you for ordering from ${restaurant}.`;
    case 'order_cancelled':
      return `${name}your order ${order} has been cancelled.${
        variables.reason ? ` Reason: ${variables.reason}` : ''
      }`;
    case 'order_rejected':
      return `${name}we are sorry — ${restaurant} could not accept order ${order}.${
        variables.reason ? ` Reason: ${variables.reason}` : ''
      }`;
    case 'order_unacknowledged':
      return `Order ${order} at ${variables.branchName ?? restaurant} has not been acknowledged. Please check the kitchen screen.`;
    default:
      return `Update on order ${order} from ${restaurant}.`;
  }
}

/**
 * Positional variables for a provider template.
 *
 * WhatsApp templates use `{{1}}`, `{{2}}` placeholders rather than names, so
 * the ORDER of this array is part of the template's contract. Changing it
 * silently rewrites every message that uses it.
 */
export function templateVariables(
  templateKey: string,
  variables: MessageVariables,
): string[] {
  switch (templateKey) {
    case 'order_unacknowledged':
      return [variables.orderNumber, variables.branchName ?? variables.restaurantName];
    case 'order_cancelled':
    case 'order_rejected':
      return [
        variables.customerName ?? 'there',
        variables.orderNumber,
        variables.reason ?? 'not specified',
      ];
    default:
      return [
        variables.customerName ?? 'there',
        variables.orderNumber,
        variables.restaurantName,
      ];
  }
}
