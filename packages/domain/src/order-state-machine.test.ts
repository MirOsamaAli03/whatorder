import { OrderStatus, OrderType, PaymentMethod } from '@restaurant-os/types';
import { describe, expect, it } from 'vitest';
import { DomainError } from './errors';
import {
  ORDER_TRANSITIONS,
  TERMINAL_ORDER_STATUSES,
  assertTransition,
  canTransition,
  completionStatusFor,
  customerMayCancel,
  isTerminal,
  nextStatuses,
  statusAfterCheckout,
} from './order-state-machine';

const ALL_STATUSES = Object.keys(ORDER_TRANSITIONS) as OrderStatus[];

const delivery = { orderType: OrderType.DELIVERY };
const pickup = { orderType: OrderType.PICKUP };
const dineIn = { orderType: OrderType.DINE_IN };

describe('transition map', () => {
  it('covers every status', () => {
    // A status without an entry would throw at runtime rather than being
    // rejected cleanly.
    expect(ALL_STATUSES.sort()).toEqual(Object.values(OrderStatus).sort());
  });

  it('never lists a status as its own successor', () => {
    for (const status of ALL_STATUSES) {
      expect(ORDER_TRANSITIONS[status], status).not.toContain(status);
    }
  });

  it('identifies the terminal states', () => {
    expect([...TERMINAL_ORDER_STATUSES].sort()).toEqual(
      [
        OrderStatus.CANCELLED,
        OrderStatus.COMPLETED,
        OrderStatus.DELIVERED,
        OrderStatus.REJECTED,
        OrderStatus.RETURNED,
      ].sort(),
    );
  });

  it('leaves every non-terminal status with somewhere to go', () => {
    for (const status of ALL_STATUSES) {
      if (isTerminal(status)) continue;
      expect(ORDER_TRANSITIONS[status].length, status).toBeGreaterThan(0);
    }
  });

  it('makes every status reachable from DRAFT', () => {
    // Otherwise a state exists that no order can ever occupy.
    const reached = new Set<OrderStatus>([OrderStatus.DRAFT]);
    const queue: OrderStatus[] = [OrderStatus.DRAFT];

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of ORDER_TRANSITIONS[current]) {
        if (!reached.has(next)) {
          reached.add(next);
          queue.push(next);
        }
      }
    }

    expect([...reached].sort()).toEqual(ALL_STATUSES.sort());
  });
});

describe('the exhaustive legality matrix', () => {
  /**
   * Every from/to pair is checked, so an illegal transition is rejected because
   * it is absent from the data — not because someone remembered to write a
   * check for it.
   */
  it('rejects every pair the map does not allow, for all three order types', () => {
    for (const context of [delivery, pickup, dineIn]) {
      for (const from of ALL_STATUSES) {
        for (const to of ALL_STATUSES) {
          const listed = ORDER_TRANSITIONS[from].includes(to);
          const allowed = canTransition(from, to, context);

          if (!listed) {
            expect(allowed, `${context.orderType}: ${from} -> ${to}`).toBe(false);
          }
        }
      }
    }
  });

  it('rejects the spec\'s named example: DELIVERED -> PREPARING', () => {
    expect(canTransition(OrderStatus.DELIVERED, OrderStatus.PREPARING, delivery)).toBe(false);
    expect(() =>
      assertTransition(OrderStatus.DELIVERED, OrderStatus.PREPARING, delivery),
    ).toThrow(DomainError);
  });

  it('refuses to move any terminal order', () => {
    for (const from of TERMINAL_ORDER_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (from === to) continue;
        expect(canTransition(from, to, delivery), `${from} -> ${to}`).toBe(false);
      }
    }
  });

  it('refuses a no-op transition with a distinct error', () => {
    try {
      assertTransition(OrderStatus.PREPARING, OrderStatus.PREPARING, delivery);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).message).toContain('already');
      expect((error as DomainError).status).toBe(409);
    }
  });

  it('reports ORDER_INVALID_STATE with a readable message', () => {
    try {
      assertTransition(OrderStatus.CONFIRMED, OrderStatus.READY, delivery);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as DomainError).code).toBe('ORDER_INVALID_STATE');
      expect((error as DomainError).message).toBe(
        'Order cannot be moved from CONFIRMED to READY',
      );
    }
  });
});

describe('the happy paths', () => {
  it('walks a delivery order end to end', () => {
    const path = [
      OrderStatus.DRAFT,
      OrderStatus.CONFIRMED,
      OrderStatus.ACCEPTED,
      OrderStatus.PREPARING,
      OrderStatus.READY,
      OrderStatus.OUT_FOR_DELIVERY,
      OrderStatus.DELIVERED,
    ];

    for (let index = 0; index < path.length - 1; index += 1) {
      expect(canTransition(path[index]!, path[index + 1]!, delivery)).toBe(true);
    }
    expect(isTerminal(path.at(-1)!)).toBe(true);
  });

  it('walks a pickup order end to end', () => {
    const path = [
      OrderStatus.DRAFT,
      OrderStatus.PENDING_PAYMENT,
      OrderStatus.CONFIRMED,
      OrderStatus.ACCEPTED,
      OrderStatus.PREPARING,
      OrderStatus.READY,
      OrderStatus.COMPLETED,
    ];

    for (let index = 0; index < path.length - 1; index += 1) {
      expect(canTransition(path[index]!, path[index + 1]!, pickup)).toBe(true);
    }
  });

  it('re-dispatches after a failed delivery', () => {
    expect(
      canTransition(OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERY_FAILED, delivery),
    ).toBe(true);
    expect(
      canTransition(OrderStatus.DELIVERY_FAILED, OrderStatus.OUT_FOR_DELIVERY, delivery),
    ).toBe(true);
    expect(canTransition(OrderStatus.DELIVERY_FAILED, OrderStatus.RETURNED, delivery)).toBe(true);
  });

  it('will not cancel a failed delivery', () => {
    // The food was made; erasing it from the day's numbers would hide the loss.
    expect(canTransition(OrderStatus.DELIVERY_FAILED, OrderStatus.CANCELLED, delivery)).toBe(
      false,
    );
  });
});

describe('order type constrains the route', () => {
  it('sends only delivery orders out for delivery', () => {
    expect(canTransition(OrderStatus.READY, OrderStatus.OUT_FOR_DELIVERY, delivery)).toBe(true);
    expect(canTransition(OrderStatus.READY, OrderStatus.OUT_FOR_DELIVERY, pickup)).toBe(false);
    expect(canTransition(OrderStatus.READY, OrderStatus.OUT_FOR_DELIVERY, dineIn)).toBe(false);
  });

  it('completes only non-delivery orders at the counter', () => {
    expect(canTransition(OrderStatus.READY, OrderStatus.COMPLETED, pickup)).toBe(true);
    expect(canTransition(OrderStatus.READY, OrderStatus.COMPLETED, dineIn)).toBe(true);
    // A delivery order is DELIVERED, never COMPLETED, so the two never blur in
    // reporting.
    expect(canTransition(OrderStatus.READY, OrderStatus.COMPLETED, delivery)).toBe(false);
  });

  it('names the right terminal state per type', () => {
    expect(completionStatusFor(OrderType.DELIVERY)).toBe(OrderStatus.DELIVERED);
    expect(completionStatusFor(OrderType.PICKUP)).toBe(OrderStatus.COMPLETED);
    expect(completionStatusFor(OrderType.DINE_IN)).toBe(OrderStatus.COMPLETED);
  });

  it('offers a screen only the buttons that apply', () => {
    expect(nextStatuses(OrderStatus.READY, delivery).sort()).toEqual(
      [OrderStatus.OUT_FOR_DELIVERY, OrderStatus.CANCELLED].sort(),
    );
    expect(nextStatuses(OrderStatus.READY, pickup).sort()).toEqual(
      [OrderStatus.COMPLETED, OrderStatus.CANCELLED].sort(),
    );
    expect(nextStatuses(OrderStatus.DELIVERED, delivery)).toEqual([]);
  });
});

describe('checkout entry point', () => {
  it('sends cash orders straight to CONFIRMED', () => {
    // The case spec v1 has no path for: a cash order never owes an online
    // payment, so PENDING_PAYMENT would be a state it could never leave.
    expect(statusAfterCheckout(PaymentMethod.CASH)).toBe(OrderStatus.CONFIRMED);
    expect(statusAfterCheckout(PaymentMethod.CARD_ON_DELIVERY)).toBe(OrderStatus.CONFIRMED);
  });

  it('sends online orders to PENDING_PAYMENT', () => {
    expect(statusAfterCheckout(PaymentMethod.ONLINE)).toBe(OrderStatus.PENDING_PAYMENT);
  });

  it('does not move an order when payment fails', () => {
    // Payment failure lives on the payment axis: the order waits in
    // PENDING_PAYMENT so the customer can retry.
    expect(ORDER_TRANSITIONS[OrderStatus.PENDING_PAYMENT]).toEqual([
      OrderStatus.CONFIRMED,
      OrderStatus.CANCELLED,
    ]);
  });
});

describe('customerMayCancel', () => {
  it('allows cancellation before the kitchen commits', () => {
    expect(customerMayCancel(OrderStatus.DRAFT)).toBe(true);
    expect(customerMayCancel(OrderStatus.PENDING_PAYMENT)).toBe(true);
    expect(customerMayCancel(OrderStatus.CONFIRMED)).toBe(true);
  });

  it('requires staff once cooking has started', () => {
    for (const status of [
      OrderStatus.ACCEPTED,
      OrderStatus.PREPARING,
      OrderStatus.READY,
      OrderStatus.OUT_FOR_DELIVERY,
    ]) {
      expect(customerMayCancel(status), status).toBe(false);
    }
  });
});
