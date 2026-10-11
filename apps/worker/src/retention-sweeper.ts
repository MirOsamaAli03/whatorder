import { Prisma, type PrismaClient } from '@restaurant-os/database';
import type { Logger } from 'pino';

/** How long each kind of row is kept. Hours, so the arithmetic stays readable. */
export interface RetentionPolicy {
  /** Grace past a cart's own expiry before it is deleted. */
  cartGraceHours: number;
  /** Grace past an idempotency key's expiry. */
  idempotencyGraceHours: number;
  /** How long a finished notification is kept, for support and for replay. */
  notificationHours: number;
  /** How long a consumed outbox event is kept as an event log. */
  outboxHours: number;
}

/**
 * The defaults.
 *
 * Carts and idempotency keys get a short grace because both already carry an
 * expiry the application honours; this only removes the row afterwards. The two
 * logs are kept far longer, because their value is answering "what did we send
 * that customer last Tuesday" — a question that arrives days late or not at
 * all.
 */
export const DEFAULT_RETENTION: RetentionPolicy = {
  cartGraceHours: 24,
  idempotencyGraceHours: 24,
  notificationHours: 30 * 24,
  outboxHours: 14 * 24,
};

export interface PrunedCounts {
  carts: number;
  idempotencyKeys: number;
  notifications: number;
  outboxEvents: number;
}

/**
 * Deletes what has served its purpose (ENGINEERING_SPEC.md 58; backlog B-13, B-18).
 *
 * Four tables grew without bound: abandoned carts, expired idempotency keys,
 * finished notifications, and processed outbox events. Nothing was wrong with
 * any of them — an expired idempotency key is already treated as absent on read
 * — but a pilot runs on one small VPS, and a table nobody prunes is a disk that
 * fills up during service.
 *
 * The decision of WHAT is safe to delete lives in the database, in
 * `app_prune_retention` (migration 20260901001200), not here. Two reasons:
 *
 *   * Privilege. The worker can call that function and still has no read access
 *     to carts or notifications, which a column grant wide enough to DELETE
 *     would have had to give it.
 *   * Atomicity. The outbox prune has to compare against the slowest
 *     consumer's cursor, and reading the cursor in one statement and deleting
 *     in another leaves a window in which the dispatcher advances and an event
 *     it has not handled is deleted underneath it.
 *
 * So this class is a clock and a log, deliberately. It runs hourly rather than
 * every few seconds: nothing here is urgent, and a prune that runs often enough
 * to matter is a prune competing with order traffic for the same tables.
 */
export class RetentionSweeper {
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: Logger,
    private readonly options: { pollMs: number; policy?: RetentionPolicy },
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    // Not at zero. The first thing a restarted worker should do is drain the
    // outbox, not spend its first second deleting things.
    this.scheduleNext(Math.min(60_000, this.options.pollMs));
    this.logger.info({ pollMs: this.options.pollMs }, 'Retention sweeper started');
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      const pruned = await this.sweepOnce();
      const total =
        pruned.carts + pruned.idempotencyKeys + pruned.notifications + pruned.outboxEvents;

      // Logged only when it did something. An hourly "deleted nothing" line is
      // noise in the one place somebody looks when service is going wrong.
      if (total > 0) this.logger.info(pruned, 'Pruned expired rows');
    } catch (error) {
      // Housekeeping failing is not an outage. It is worth knowing about, and
      // worth retrying next hour, and worth not crashing the worker over.
      this.logger.error({ err: error }, 'Retention sweep failed; will retry');
    }
    this.scheduleNext(this.options.pollMs);
  }

  /** One pass. Returns how many rows of each kind were deleted. */
  async sweepOnce(policy: RetentionPolicy = this.options.policy ?? DEFAULT_RETENTION): Promise<
    PrunedCounts
  > {
    const [row] = await this.prisma.$queryRaw<
      Array<{
        pruned_carts: bigint;
        pruned_idempotency_keys: bigint;
        pruned_notifications: bigint;
        pruned_outbox_events: bigint;
      }>
    >(Prisma.sql`
      SELECT * FROM app_prune_retention(
        ${`${policy.cartGraceHours} hours`}::interval,
        ${`${policy.idempotencyGraceHours} hours`}::interval,
        ${`${policy.notificationHours} hours`}::interval,
        ${`${policy.outboxHours} hours`}::interval
      )
    `);

    return {
      carts: Number(row?.pruned_carts ?? 0),
      idempotencyKeys: Number(row?.pruned_idempotency_keys ?? 0),
      notifications: Number(row?.pruned_notifications ?? 0),
      outboxEvents: Number(row?.pruned_outbox_events ?? 0),
    };
  }
}
