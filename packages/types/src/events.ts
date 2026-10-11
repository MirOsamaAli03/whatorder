/**
 * Domain event names (ENGINEERING_SPEC.md 57).
 *
 * Events are written to `outbox_events` inside the same transaction as the
 * change they describe, so a committed change can never lose its event
 * (spec 58). A worker publishes them from Phase 4 onward; until then the rows
 * accumulate as a durable, ordered record of what happened.
 */
export const DomainEventType = {
  ORDER_CREATED: 'OrderCreated',
  ORDER_CONFIRMED: 'OrderConfirmed',
  ORDER_ACCEPTED: 'OrderAccepted',
  ORDER_REJECTED: 'OrderRejected',
  ORDER_PREPARING: 'OrderPreparing',
  ORDER_READY: 'OrderReady',
  ORDER_DISPATCHED: 'OrderDispatched',
  ORDER_DELIVERED: 'OrderDelivered',
  ORDER_CANCELLED: 'OrderCancelled',

  PAYMENT_INITIATED: 'PaymentInitiated',
  PAYMENT_SUCCEEDED: 'PaymentSucceeded',
  PAYMENT_FAILED: 'PaymentFailed',
  PAYMENT_REFUNDED: 'PaymentRefunded',

  RESERVATION_CREATED: 'ReservationCreated',
  RESERVATION_CONFIRMED: 'ReservationConfirmed',
  RESERVATION_CANCELLED: 'ReservationCancelled',
  RESERVATION_COMPLETED: 'ReservationCompleted',

  MENU_ITEM_AVAILABILITY_CHANGED: 'MenuItemAvailabilityChanged',

  /** Every order status change publishes one of these, keyed by the new state. */
  ORDER_STATUS_CHANGED: 'OrderStatusChanged',

  /**
   * An order sat unacknowledged past its threshold (ENGINEERING_SPEC.md 33).
   * The payload carries the escalation level, so each rung of the ladder is a
   * distinguishable event rather than a repeated one.
   */
  ORDER_ACKNOWLEDGEMENT_TIMEOUT: 'OrderAcknowledgementTimeout',

  /**
   * A customer asked for a person and nobody replied (backlog B-28).
   *
   * The conversational sibling of ORDER_ACKNOWLEDGEMENT_TIMEOUT. An
   * unacknowledged order escalates; an unanswered customer did not, which made
   * "somebody will reply here shortly" depend on a member of staff happening to
   * have the inbox open.
   */
  CONVERSATION_HANDOFF_UNANSWERED: 'ConversationHandoffUnanswered',

  /**
   * A branch has orders in the kitchen and no live kitchen screen (spec 70;
   * backlog B-17).
   *
   * The third sibling of the two above, and the one with the quietest failure:
   * an unacknowledged order and an unanswered customer are at least visible to
   * anybody looking at the dashboard, whereas a kitchen whose screen dropped
   * off shows nothing at all — to the kitchen, there are simply no orders.
   */
  KITCHEN_SCREEN_OFFLINE: 'KitchenScreenOffline',
} as const;

export type DomainEventType = (typeof DomainEventType)[keyof typeof DomainEventType];

/** Aggregate the event belongs to, used for ordering and replay. */
export const AggregateType = {
  ORDER: 'Order',
  PAYMENT: 'Payment',
  RESERVATION: 'Reservation',
  MENU_ITEM: 'MenuItem',
  CART: 'Cart',
  CUSTOMER: 'Customer',
  CONVERSATION: 'Conversation',
  BRANCH: 'Branch',
} as const;

export type AggregateType = (typeof AggregateType)[keyof typeof AggregateType];

/** The envelope every event payload carries (ENGINEERING_SPEC.md 57). */
export interface DomainEventEnvelope<TPayload = Record<string, unknown>> {
  eventId: string;
  eventType: DomainEventType;
  tenantId: string;
  aggregateType: AggregateType;
  aggregateId: string;
  timestamp: string;
  /** Who caused it: a user id, or a channel name such as WHATSAPP. */
  actor: string | null;
  payload: TPayload;
}
