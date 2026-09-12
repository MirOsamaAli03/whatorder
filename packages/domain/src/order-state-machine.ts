import { ErrorCode, OrderStatus, OrderType, PaymentMethod } from '@restaurant-os/types';
import { DomainError } from './errors';

/**
 * Order state machine (ENGINEERING_SPEC.md 15, 16; invariant 6).
 *
 * The transition rules are DATA, not branching code. A map can be enumerated,
 * which is what lets the test suite assert every legal transition and — more
 * importantly — every illegal one, rather than the handful someone thought to
 * write down. `DELIVERED -> PREPARING` fails because it is absent from the map,
 * not because a specific check rejects it.
 *
 * This module knows nothing about databases, HTTP or payments. The single
 * `transitionOrder` entry point in the API composes it with loading, tenant and
 * permission checks, audit and event publication (spec 16).
 */

/** Which statuses may follow each status. Absent means terminal. */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  // A cart becomes a DRAFT order at checkout; it goes to payment or straight
  // to CONFIRMED when there is nothing to collect up front.
  [OrderStatus.DRAFT]: [
    OrderStatus.PENDING_PAYMENT,
    OrderStatus.CONFIRMED,
    OrderStatus.CANCELLED,
  ],

  // A failed payment does NOT move the order. It stays here with
  // payment_status = FAILED so the customer can retry, which is only possible
  // because the two axes are independent (plan 2.5).
  [OrderStatus.PENDING_PAYMENT]: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],

  // The acknowledgement clock (spec 33) runs from here.
  [OrderStatus.CONFIRMED]: [OrderStatus.ACCEPTED, OrderStatus.REJECTED, OrderStatus.CANCELLED],

  [OrderStatus.ACCEPTED]: [OrderStatus.PREPARING, OrderStatus.CANCELLED],
  [OrderStatus.PREPARING]: [OrderStatus.READY, OrderStatus.CANCELLED],

  // Delivery leaves; pickup and dine-in are handed over. The order type decides
  // which of these is legal — see assertTransition.
  [OrderStatus.READY]: [
    OrderStatus.OUT_FOR_DELIVERY,
    OrderStatus.COMPLETED,
    OrderStatus.CANCELLED,
  ],

  [OrderStatus.OUT_FOR_DELIVERY]: [OrderStatus.DELIVERED, OrderStatus.DELIVERY_FAILED],

  // A failed delivery is re-dispatched or comes back. Not cancellable: the food
  // was made and the loss is already real; cancelling would erase it from the
  // day's numbers.
  [OrderStatus.DELIVERY_FAILED]: [OrderStatus.OUT_FOR_DELIVERY, OrderStatus.RETURNED],

  [OrderStatus.DELIVERED]: [],
  [OrderStatus.COMPLETED]: [],
  [OrderStatus.RETURNED]: [],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.REJECTED]: [],
};

export const TERMINAL_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set(
  (Object.keys(ORDER_TRANSITIONS) as OrderStatus[]).filter(
    (status) => ORDER_TRANSITIONS[status].length === 0,
  ),
);

/** Statuses at which the kitchen has not yet been asked to cook. */
export const PRE_KITCHEN_STATUSES: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.DRAFT,
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.CONFIRMED,
]);

/** Statuses that count as live work on a kitchen or dispatch screen. */
export const ACTIVE_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.CONFIRMED,
  OrderStatus.ACCEPTED,
  OrderStatus.PREPARING,
  OrderStatus.READY,
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.DELIVERY_FAILED,
];

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.has(status);
}

/**
 * The status an order takes when it is placed.
 *
 * Cash orders skip PENDING_PAYMENT entirely and are CONFIRMED immediately —
 * spec v1 routes everything through payment, which would leave every cash order
 * in Pakistan stuck in a state it can never leave (plan 2.5). Dine-in behaves
 * the same way: the bill is settled after eating.
 */
export function statusAfterCheckout(paymentMethod: PaymentMethod): OrderStatus {
  return paymentMethod === PaymentMethod.ONLINE
    ? OrderStatus.PENDING_PAYMENT
    : OrderStatus.CONFIRMED;
}

/** The terminal success state for an order type. */
export function completionStatusFor(orderType: OrderType): OrderStatus {
  return orderType === OrderType.DELIVERY ? OrderStatus.DELIVERED : OrderStatus.COMPLETED;
}

export interface TransitionContext {
  orderType: OrderType;
}

export function canTransition(
  from: OrderStatus,
  to: OrderStatus,
  context: TransitionContext,
): boolean {
  if (!ORDER_TRANSITIONS[from].includes(to)) {
    return false;
  }

  // Type-specific rules that the map alone cannot express: READY leads to
  // dispatch for a delivery and to handover for anything else, and a pickup
  // order has no delivery leg at all.
  const isDelivery = context.orderType === OrderType.DELIVERY;

  if (to === OrderStatus.OUT_FOR_DELIVERY && !isDelivery) return false;
  if (to === OrderStatus.COMPLETED && isDelivery) return false;

  return true;
}

/** Throws unless the transition is legal. The only way status may change. */
export function assertTransition(
  from: OrderStatus,
  to: OrderStatus,
  context: TransitionContext,
): void {
  if (from === to) {
    throw new DomainError(
      ErrorCode.ORDER_INVALID_STATE,
      `Order is already ${from}`,
      409,
    );
  }

  if (isTerminal(from)) {
    throw new DomainError(
      ErrorCode.ORDER_INVALID_STATE,
      `Order is ${from} and cannot change state again`,
      409,
    );
  }

  if (!canTransition(from, to, context)) {
    throw new DomainError(
      ErrorCode.ORDER_INVALID_STATE,
      `Order cannot be moved from ${from} to ${to}`,
      409,
    );
  }
}

/** Legal next statuses, for rendering the buttons a screen should offer. */
export function nextStatuses(from: OrderStatus, context: TransitionContext): OrderStatus[] {
  return ORDER_TRANSITIONS[from].filter((to) => canTransition(from, to, context));
}

/**
 * Whether an order may still be cancelled by the customer.
 *
 * Once a kitchen has accepted it, cancellation is a staff decision: ingredients
 * are committed and someone has to agree to absorb the loss.
 */
export function customerMayCancel(status: OrderStatus): boolean {
  return PRE_KITCHEN_STATUSES.has(status);
}
