import { EscalationTarget, OrderStatus } from '@restaurant-os/types';
import { ValidationError } from './errors';

/**
 * Kitchen Display System and unacknowledged-order protection
 * (ENGINEERING_SPEC.md 33, 34, 35).
 *
 * Pure functions with no database or transport dependency, so the column
 * layout, the elapsed-time bands and the escalation ladder can be tested
 * exhaustively and reused by the API, the worker and eventually the KDS screen
 * itself without any of them re-deriving the rules.
 */

/** The four columns of a kitchen screen (ENGINEERING_SPEC.md 34). */
export const KdsColumn = {
  /** Confirmed and owed to the kitchen. Nobody has picked it up yet. */
  NEW: 'NEW',
  ACCEPTED: 'ACCEPTED',
  PREPARING: 'PREPARING',
  READY: 'READY',
} as const;
export type KdsColumn = (typeof KdsColumn)[keyof typeof KdsColumn];

export const KDS_COLUMNS: readonly KdsColumn[] = [
  KdsColumn.NEW,
  KdsColumn.ACCEPTED,
  KdsColumn.PREPARING,
  KdsColumn.READY,
];

/** Which order statuses appear in which column. */
const COLUMN_BY_STATUS: Partial<Record<OrderStatus, KdsColumn>> = {
  [OrderStatus.CONFIRMED]: KdsColumn.NEW,
  [OrderStatus.ACCEPTED]: KdsColumn.ACCEPTED,
  [OrderStatus.PREPARING]: KdsColumn.PREPARING,
  [OrderStatus.READY]: KdsColumn.READY,
};

/** The statuses a kitchen screen shows at all. */
export const KDS_STATUSES: readonly OrderStatus[] = Object.keys(
  COLUMN_BY_STATUS,
) as OrderStatus[];

/**
 * The column an order belongs in, or null when it does not belong on a kitchen
 * screen — a draft, an order out for delivery, anything terminal.
 */
export function kdsColumnFor(status: OrderStatus): KdsColumn | null {
  return COLUMN_BY_STATUS[status] ?? null;
}

/**
 * How alarming an order's age is, for colouring a card.
 *
 * Bands rather than a raw number because a kitchen screen is read from across a
 * room: the colour has to carry the meaning before anyone reads the timer.
 */
export const UrgencyLevel = {
  NORMAL: 'NORMAL',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL',
} as const;
export type UrgencyLevel = (typeof UrgencyLevel)[keyof typeof UrgencyLevel];

export interface UrgencyThresholds {
  /** Seconds after which a card turns amber. */
  warningSeconds: number;
  /** Seconds after which it turns red. */
  criticalSeconds: number;
}

export function urgencyFor(
  elapsedSeconds: number,
  thresholds: UrgencyThresholds,
): UrgencyLevel {
  if (elapsedSeconds >= thresholds.criticalSeconds) return UrgencyLevel.CRITICAL;
  if (elapsedSeconds >= thresholds.warningSeconds) return UrgencyLevel.WARNING;
  return UrgencyLevel.NORMAL;
}

/**
 * Seconds an order has spent in its current column.
 *
 * Measured from the timestamp of the stage it is in, not from creation: a cook
 * looking at the PREPARING column wants to know how long *this* dish has been
 * on, not how long ago the customer ordered.
 */
export function elapsedInColumn(
  now: Date,
  order: {
    status: OrderStatus;
    confirmedAt: Date | null;
    acceptedAt: Date | null;
    preparingAt: Date | null;
    readyAt: Date | null;
    createdAt: Date;
  },
): number {
  const since =
    order.status === OrderStatus.CONFIRMED
      ? (order.confirmedAt ?? order.createdAt)
      : order.status === OrderStatus.ACCEPTED
        ? (order.acceptedAt ?? order.createdAt)
        : order.status === OrderStatus.PREPARING
          ? (order.preparingAt ?? order.createdAt)
          : order.status === OrderStatus.READY
            ? (order.readyAt ?? order.createdAt)
            : order.createdAt;

  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / 1000));
}

// ---------------------------------------------------------------------------
// Escalation ladder (ENGINEERING_SPEC.md 33)
// ---------------------------------------------------------------------------

export interface EscalationRung {
  level: number;
  /** Seconds after CONFIRMED at which this rung fires. */
  afterSeconds: number;
  target: EscalationTarget;
}

/**
 * The default ladder: kitchen, then branch manager, then owner.
 *
 * Spec 33 gives 60 seconds as its example and requires the thresholds to be
 * configurable per restaurant, so this is a starting point rather than a rule.
 * A busy Friday kitchen and a home kitchen want very different numbers.
 */
export const DEFAULT_ESCALATION_LADDER: readonly EscalationRung[] = [
  { level: 1, afterSeconds: 60, target: EscalationTarget.KITCHEN },
  { level: 2, afterSeconds: 180, target: EscalationTarget.BRANCH_MANAGER },
  { level: 3, afterSeconds: 300, target: EscalationTarget.OWNER },
];

/**
 * Validates and normalises a tenant's ladder.
 *
 * Sorted by delay and checked for sanity, because a misconfigured ladder is
 * worse than none: rungs out of order would alert the owner before the kitchen,
 * and a duplicate level would make the "fire once per level" guarantee
 * meaningless.
 */
export function normalizeEscalationLadder(
  rungs: readonly EscalationRung[],
): EscalationRung[] {
  if (rungs.length === 0) {
    throw new ValidationError('An escalation ladder needs at least one rung');
  }

  const sorted = [...rungs].sort((a, b) => a.afterSeconds - b.afterSeconds);

  const levels = new Set<number>();
  let previousDelay = -1;

  for (const rung of sorted) {
    if (!Number.isInteger(rung.level) || rung.level < 1) {
      throw new ValidationError(`Escalation level must be a positive integer, got ${rung.level}`);
    }
    if (levels.has(rung.level)) {
      throw new ValidationError(`Escalation level ${rung.level} appears more than once`);
    }
    levels.add(rung.level);

    if (!Number.isInteger(rung.afterSeconds) || rung.afterSeconds < 1) {
      throw new ValidationError(
        `Escalation delay must be a positive number of seconds, got ${rung.afterSeconds}`,
      );
    }
    if (rung.afterSeconds === previousDelay) {
      throw new ValidationError(`Two escalation rungs both fire at ${rung.afterSeconds}s`);
    }
    previousDelay = rung.afterSeconds;
  }

  return sorted;
}

/**
 * Which rungs are due for an order that has gone unacknowledged.
 *
 * Returns every rung whose delay has passed and which has not already fired.
 * Returning all of them rather than just the next one matters after an outage:
 * a worker that was down for ten minutes must raise the levels it missed, not
 * quietly resume at the first one.
 */
export function dueEscalations(input: {
  elapsedSeconds: number;
  ladder: readonly EscalationRung[];
  alreadyFiredLevels: readonly number[];
}): EscalationRung[] {
  const fired = new Set(input.alreadyFiredLevels);

  return input.ladder.filter(
    (rung) => input.elapsedSeconds >= rung.afterSeconds && !fired.has(rung.level),
  );
}

/**
 * Whether an order is overdue at all — the cheap check a dashboard banner uses
 * before asking for detail.
 */
export function isUnacknowledged(input: {
  status: OrderStatus;
  elapsedSeconds: number;
  thresholdSeconds: number;
}): boolean {
  // Only CONFIRMED counts. Once a human has accepted it, the order has been
  // noticed, which is the whole thing spec 33 is protecting.
  return input.status === OrderStatus.CONFIRMED && input.elapsedSeconds >= input.thresholdSeconds;
}
