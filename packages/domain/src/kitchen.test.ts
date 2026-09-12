import { EscalationTarget, OrderStatus } from '@restaurant-os/types';
import { describe, expect, it } from 'vitest';
import { ValidationError } from './errors';
import {
  DEFAULT_ESCALATION_LADDER,
  KDS_COLUMNS,
  KDS_STATUSES,
  KdsColumn,
  UrgencyLevel,
  dueEscalations,
  elapsedInColumn,
  isUnacknowledged,
  kdsColumnFor,
  normalizeEscalationLadder,
  urgencyFor,
} from './kitchen';

describe('KDS columns (spec 34)', () => {
  it('has the four columns the spec names', () => {
    expect(KDS_COLUMNS).toEqual(['NEW', 'ACCEPTED', 'PREPARING', 'READY']);
  });

  it('maps each kitchen status to its column', () => {
    expect(kdsColumnFor(OrderStatus.CONFIRMED)).toBe(KdsColumn.NEW);
    expect(kdsColumnFor(OrderStatus.ACCEPTED)).toBe(KdsColumn.ACCEPTED);
    expect(kdsColumnFor(OrderStatus.PREPARING)).toBe(KdsColumn.PREPARING);
    expect(kdsColumnFor(OrderStatus.READY)).toBe(KdsColumn.READY);
  });

  it('keeps everything else off the kitchen screen', () => {
    // A draft, an order awaiting payment, one already out for delivery, and
    // anything terminal are not the kitchen's problem.
    for (const status of [
      OrderStatus.DRAFT,
      OrderStatus.PENDING_PAYMENT,
      OrderStatus.OUT_FOR_DELIVERY,
      OrderStatus.DELIVERED,
      OrderStatus.COMPLETED,
      OrderStatus.CANCELLED,
      OrderStatus.REJECTED,
      OrderStatus.DELIVERY_FAILED,
      OrderStatus.RETURNED,
    ]) {
      expect(kdsColumnFor(status), status).toBeNull();
    }
  });

  it('lists exactly the statuses that have a column', () => {
    expect([...KDS_STATUSES].sort()).toEqual(
      [
        OrderStatus.CONFIRMED,
        OrderStatus.ACCEPTED,
        OrderStatus.PREPARING,
        OrderStatus.READY,
      ].sort(),
    );
  });
});

describe('elapsedInColumn (spec 35)', () => {
  const now = new Date('2026-09-11T12:00:00Z');

  function order(overrides: Record<string, Date | null> = {}) {
    return {
      status: OrderStatus.PREPARING,
      createdAt: new Date('2026-09-11T11:00:00Z'),
      confirmedAt: new Date('2026-09-11T11:01:00Z'),
      acceptedAt: new Date('2026-09-11T11:02:00Z'),
      preparingAt: new Date('2026-09-11T11:55:00Z'),
      readyAt: null,
      ...overrides,
    } as Parameters<typeof elapsedInColumn>[1];
  }

  it('measures from the current stage, not from creation', () => {
    // The cook wants to know how long this dish has been on — five minutes —
    // not how long ago the customer ordered, which is an hour.
    expect(elapsedInColumn(now, order())).toBe(300);
  });

  it('measures a new order from when it was confirmed', () => {
    const confirmed = order({ status: OrderStatus.CONFIRMED } as never);
    expect(elapsedInColumn(now, confirmed)).toBe(59 * 60);
  });

  it('falls back to creation when a stage timestamp is missing', () => {
    const missing = order({ preparingAt: null });
    expect(elapsedInColumn(now, missing)).toBe(60 * 60);
  });

  it('never reports a negative age', () => {
    // Clock skew between the API and the database must not produce a card that
    // claims to have been cooked in the future.
    const future = order({ preparingAt: new Date('2026-09-11T12:05:00Z') });
    expect(elapsedInColumn(now, future)).toBe(0);
  });
});

describe('urgencyFor', () => {
  const thresholds = { warningSeconds: 300, criticalSeconds: 600 };

  it('bands the elapsed time', () => {
    expect(urgencyFor(0, thresholds)).toBe(UrgencyLevel.NORMAL);
    expect(urgencyFor(299, thresholds)).toBe(UrgencyLevel.NORMAL);
    expect(urgencyFor(300, thresholds)).toBe(UrgencyLevel.WARNING);
    expect(urgencyFor(599, thresholds)).toBe(UrgencyLevel.WARNING);
    expect(urgencyFor(600, thresholds)).toBe(UrgencyLevel.CRITICAL);
    expect(urgencyFor(9999, thresholds)).toBe(UrgencyLevel.CRITICAL);
  });
});

describe('escalation ladder (spec 33)', () => {
  it('defaults to kitchen, then manager, then owner', () => {
    expect(DEFAULT_ESCALATION_LADDER.map((rung) => rung.target)).toEqual([
      EscalationTarget.KITCHEN,
      EscalationTarget.BRANCH_MANAGER,
      EscalationTarget.OWNER,
    ]);
    // Spec 33's worked example is 60 seconds.
    expect(DEFAULT_ESCALATION_LADDER[0]!.afterSeconds).toBe(60);
  });

  it('sorts rungs by delay', () => {
    const ladder = normalizeEscalationLadder([
      { level: 3, afterSeconds: 300, target: EscalationTarget.OWNER },
      { level: 1, afterSeconds: 60, target: EscalationTarget.KITCHEN },
      { level: 2, afterSeconds: 180, target: EscalationTarget.BRANCH_MANAGER },
    ]);

    expect(ladder.map((rung) => rung.level)).toEqual([1, 2, 3]);
  });

  it('rejects a ladder that would alert the owner first', () => {
    // Two rungs at the same instant have no defined order, so the ladder stops
    // being a ladder.
    expect(() =>
      normalizeEscalationLadder([
        { level: 1, afterSeconds: 60, target: EscalationTarget.KITCHEN },
        { level: 2, afterSeconds: 60, target: EscalationTarget.OWNER },
      ]),
    ).toThrow(ValidationError);
  });

  it('rejects a duplicate level', () => {
    expect(() =>
      normalizeEscalationLadder([
        { level: 1, afterSeconds: 60, target: EscalationTarget.KITCHEN },
        { level: 1, afterSeconds: 120, target: EscalationTarget.OWNER },
      ]),
    ).toThrow(/more than once/);
  });

  it('rejects an empty ladder and nonsense delays', () => {
    expect(() => normalizeEscalationLadder([])).toThrow(ValidationError);
    expect(() =>
      normalizeEscalationLadder([
        { level: 1, afterSeconds: 0, target: EscalationTarget.KITCHEN },
      ]),
    ).toThrow(ValidationError);
  });
});

describe('dueEscalations', () => {
  const ladder = DEFAULT_ESCALATION_LADDER;

  it('fires nothing before the first threshold', () => {
    expect(
      dueEscalations({ elapsedSeconds: 30, ladder, alreadyFiredLevels: [] }),
    ).toEqual([]);
  });

  it('fires the first rung at its threshold', () => {
    const due = dueEscalations({ elapsedSeconds: 60, ladder, alreadyFiredLevels: [] });
    expect(due.map((rung) => rung.level)).toEqual([1]);
  });

  it('does not fire a rung twice', () => {
    const due = dueEscalations({ elapsedSeconds: 200, ladder, alreadyFiredLevels: [1] });
    expect(due.map((rung) => rung.level)).toEqual([2]);
  });

  it('catches up on every missed rung after an outage', () => {
    // The worker was down for ten minutes. All three rungs are overdue, and all
    // three must be raised — resuming quietly at level 1 would mean the owner
    // never hears about an order that has been ignored for ten minutes.
    const due = dueEscalations({ elapsedSeconds: 600, ladder, alreadyFiredLevels: [] });
    expect(due.map((rung) => rung.level)).toEqual([1, 2, 3]);
  });

  it('returns nothing once every rung has fired', () => {
    expect(
      dueEscalations({ elapsedSeconds: 9999, ladder, alreadyFiredLevels: [1, 2, 3] }),
    ).toEqual([]);
  });
});

describe('isUnacknowledged', () => {
  it('flags a confirmed order past its threshold', () => {
    expect(
      isUnacknowledged({
        status: OrderStatus.CONFIRMED,
        elapsedSeconds: 90,
        thresholdSeconds: 60,
      }),
    ).toBe(true);
  });

  it('does not flag one still inside its threshold', () => {
    expect(
      isUnacknowledged({
        status: OrderStatus.CONFIRMED,
        elapsedSeconds: 30,
        thresholdSeconds: 60,
      }),
    ).toBe(false);
  });

  it('stops once a human has accepted it', () => {
    // Acceptance is the acknowledgement. A slow kitchen is a different problem
    // from an unnoticed order, and spec 33 is about the second.
    for (const status of [
      OrderStatus.ACCEPTED,
      OrderStatus.PREPARING,
      OrderStatus.READY,
      OrderStatus.CANCELLED,
    ]) {
      expect(
        isUnacknowledged({ status, elapsedSeconds: 9999, thresholdSeconds: 60 }),
        status,
      ).toBe(false);
    }
  });
});
