import { Prisma, type PrismaClient } from '@restaurant-os/database';
import {
  DEFAULT_ESCALATION_LADDER,
  DEFAULT_HANDOFF_RESPONSE_SECONDS,
  KDS_OFFLINE_SECONDS,
  normalizeEscalationLadder,
  dueEscalations,
  type EscalationRung,
} from '@restaurant-os/domain';
import {
  AggregateType,
  DomainEventType,
  EscalationTarget,
  OrderStatus,
} from '@restaurant-os/types';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';

/** How far back to look. Older than this is a support problem, not an alert. */
const LOOKBACK_HOURS = 12;

/**
 * Orders a kitchen screen is responsible for.
 *
 * READY is included: a ready order nobody collects is exactly what a dark
 * screen causes, and the kitchen is still the place that notices.
 */
const KITCHEN_STATUSES = [OrderStatus.CONFIRMED, OrderStatus.PREPARING, OrderStatus.READY];

/**
 * Raises the alarm when an order goes unacknowledged (ENGINEERING_SPEC.md 33).
 *
 * This is the mechanism behind the product's headline promise, so how it fails
 * matters more than how it runs. It **polls the database** rather than relying
 * on a delayed queue job, deliberately:
 *
 *   * A job scheduled in Redis and then lost — eviction, a flush, a restart
 *     before persistence — fails silently, and the order it was guarding is
 *     never escalated. For a feature whose entire purpose is that nothing goes
 *     unnoticed, silent loss is the one unacceptable failure mode.
 *   * Polling recovers by itself. A worker that was down for ten minutes finds
 *     everything it missed on its first pass and raises every rung that came
 *     due (see dueEscalations), rather than resuming as though nothing had
 *     happened.
 *   * The database is already the source of truth for whether an order is still
 *     CONFIRMED, so there is no second place for the two to disagree.
 *
 * The cost is a query every few seconds against an indexed partial index. That
 * is cheap, and it buys a system whose guarantee survives a Redis outage.
 */
export class EscalationMonitor {
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: Logger,
    private readonly options: { pollMs: number },
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(0);
    this.logger.info({ pollMs: this.options.pollMs }, 'Escalation monitor started');
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
      await this.sweepOnce();
    } catch (error) {
      this.logger.error({ err: error }, 'Escalation sweep failed; retrying');
    }
    this.scheduleNext(this.options.pollMs);
  }

  /**
   * One pass. Returns how many escalation rungs were raised.
   *
   * Also resolves escalations for orders that have since been acknowledged, so
   * a dashboard banner clears itself without anyone dismissing it.
   */
  async sweepOnce(now = new Date()): Promise<number> {
    const since = new Date(now.getTime() - LOOKBACK_HOURS * 3_600_000);

    const organizations = await this.prisma.organization.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, settings: true },
    });

    const ladderByTenant = new Map<string, EscalationRung[]>();
    const settingsByTenant = new Map<string, unknown>();
    for (const organization of organizations) {
      ladderByTenant.set(organization.id, this.ladderFor(organization.settings, organization.id));
      settingsByTenant.set(organization.id, organization.settings);
    }

    const waiting = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.CONFIRMED,
        confirmedAt: { gte: since, not: null },
      },
      select: {
        id: true,
        tenantId: true,
        branchId: true,
        orderNumber: true,
        confirmedAt: true,
        createdAt: true,
      },
      orderBy: { confirmedAt: 'asc' },
      take: 500,
    });

    let raised = 0;

    for (const order of waiting) {
      const ladder = ladderByTenant.get(order.tenantId);
      if (!ladder) continue;

      const confirmedAt = order.confirmedAt ?? order.createdAt;
      const elapsedSeconds = Math.floor((now.getTime() - confirmedAt.getTime()) / 1000);

      const existing = await this.prisma.orderEscalation.findMany({
        where: { orderId: order.id },
        select: { level: true },
      });

      const due = dueEscalations({
        elapsedSeconds,
        ladder,
        alreadyFiredLevels: existing.map((row) => row.level),
      });

      for (const rung of due) {
        const created = await this.raise(order, rung, elapsedSeconds);
        if (created) raised += 1;
      }
    }

    await this.resolveAcknowledged();
    raised += await this.sweepUnansweredHandoffs(now, settingsByTenant);
    raised += await this.sweepOfflineKitchenScreens(now);

    return raised;
  }

  /**
   * Raises the alarm when a branch has orders in the kitchen and no kitchen
   * screen (ENGINEERING_SPEC.md 70; backlog B-17).
   *
   * The third sibling of the two sweeps above, and the quietest failure of the
   * three. An unacknowledged order and an unanswered customer are at least
   * visible to anyone looking at the dashboard. A kitchen whose screen went to
   * sleep shows nothing at all — which is indistinguishable, from the kitchen,
   * from a quiet evening.
   *
   * Two conditions, and the second is the one that makes this liveable:
   *
   *   * Nothing has heartbeated for the threshold. The record is per branch and
   *     rewritten by every screen, so it cannot drift upward the way a count of
   *     open connections does when a process is killed.
   *   * There is work waiting. A closed restaurant has no screen on at three in
   *     the morning and does not want to hear about it; an alarm that cries
   *     every night is one nobody reads by the end of the week.
   */
  private async sweepOfflineKitchenScreens(now: Date): Promise<number> {
    const staleBefore = new Date(now.getTime() - KDS_OFFLINE_SECONDS * 1000);

    const stale = await this.prisma.kdsPresence.findMany({
      where: { lastSeenAt: { lt: staleBefore }, offlineAlertedAt: null },
      select: { branchId: true, tenantId: true, lastSeenAt: true },
      take: 200,
    });

    let raised = 0;

    for (const presence of stale) {
      const waiting = await this.prisma.order.count({
        where: {
          branchId: presence.branchId,
          status: { in: KITCHEN_STATUSES },
        },
      });

      // Nothing to miss. Deliberately left un-alerted rather than marked, so
      // that the first order to arrive while the screen is still off does raise
      // the alarm on the next pass.
      if (waiting === 0) continue;

      // The conditional update is the idempotency, as with handoffs: a second
      // pass or a second worker finds it already set and does nothing, so one
      // outage wakes somebody once rather than every five seconds.
      const claimed = await this.prisma.kdsPresence.updateMany({
        where: { branchId: presence.branchId, offlineAlertedAt: null },
        data: { offlineAlertedAt: now },
      });

      if (claimed.count === 0) continue;

      const offlineSeconds = Math.floor((now.getTime() - presence.lastSeenAt.getTime()) / 1000);

      await this.prisma.outboxEvent.create({
        data: {
          id: randomUUID(),
          tenantId: presence.tenantId,
          eventType: DomainEventType.KITCHEN_SCREEN_OFFLINE,
          aggregateType: AggregateType.BRANCH,
          aggregateId: presence.branchId,
          actor: 'SYSTEM',
          payload: {
            branchId: presence.branchId,
            waitingOrders: waiting,
            offlineSeconds,
          } as Prisma.InputJsonValue,
        },
      });

      this.logger.warn(
        { branchId: presence.branchId, waiting, offlineSeconds },
        'Kitchen screen offline with orders waiting; escalating',
      );

      raised += 1;
    }

    return raised;
  }

  /**
   * Raises the alarm when a customer asked for a person and nobody replied
   * (backlog B-28).
   *
   * The conversational sibling of the unacknowledged-order sweep, and it exists
   * for the same reason: the bot promises "somebody will reply here shortly",
   * and until this ran that promise depended on a member of staff happening to
   * have the inbox open during service.
   *
   * The worker can see which conversation, where, and since when — and is
   * refused the customer's number and their cart at the database (migration
   * 20260901001000). Composing the message is left to the dispatcher, on a
   * connection that is allowed to know who the customer is.
   */
  private async sweepUnansweredHandoffs(
    now: Date,
    settingsByTenant: Map<string, unknown>,
  ): Promise<number> {
    const waiting = await this.prisma.conversationSession.findMany({
      where: {
        state: 'HUMAN_HANDOFF',
        handoffEscalatedAt: null,
        lastInboundAt: { not: null },
      },
      select: { id: true, tenantId: true, branchId: true, lastInboundAt: true },
      orderBy: { lastInboundAt: 'asc' },
      take: 200,
    });

    let raised = 0;

    for (const conversation of waiting) {
      const threshold = this.handoffThresholdFor(settingsByTenant.get(conversation.tenantId));
      const waitedSeconds = Math.floor(
        (now.getTime() - conversation.lastInboundAt!.getTime()) / 1000,
      );

      if (waitedSeconds < threshold) continue;

      // The conditional update is the idempotency: a second pass, or a second
      // worker, finds handoffEscalatedAt already set and changes nothing, so
      // nobody is woken twice for one customer.
      const claimed = await this.prisma.conversationSession.updateMany({
        where: { id: conversation.id, handoffEscalatedAt: null },
        data: { handoffEscalatedAt: now },
      });

      if (claimed.count === 0) continue;

      await this.prisma.outboxEvent.create({
        data: {
          id: randomUUID(),
          tenantId: conversation.tenantId,
          eventType: DomainEventType.CONVERSATION_HANDOFF_UNANSWERED,
          aggregateType: AggregateType.CONVERSATION,
          aggregateId: conversation.id,
          actor: 'SYSTEM',
          payload: {
            conversationId: conversation.id,
            branchId: conversation.branchId,
            waitedSeconds,
          } as Prisma.InputJsonValue,
        },
      });

      this.logger.warn(
        { conversationId: conversation.id, branchId: conversation.branchId, waitedSeconds },
        'Customer waiting for a person; escalating',
      );

      raised += 1;
    }

    return raised;
  }

  /** How long a customer may wait for a person, per tenant. */
  private handoffThresholdFor(settings: unknown): number {
    const raw = (settings as { handoffResponseTimeoutSeconds?: unknown } | null)
      ?.handoffResponseTimeoutSeconds;

    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0
      ? Math.floor(raw)
      : DEFAULT_HANDOFF_RESPONSE_SECONDS;
  }

  /**
   * Records one rung and emits its event.
   *
   * The unique constraint on (order_id, level) is what makes this safe to run
   * concurrently or to re-run: a second worker attempting the same rung loses
   * the race and does nothing, so nobody is alerted twice.
   */
  private async raise(
    order: { id: string; tenantId: string; branchId: string; orderNumber: string },
    rung: EscalationRung,
    elapsedSeconds: number,
  ): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.orderEscalation.create({
          data: {
            tenantId: order.tenantId,
            branchId: order.branchId,
            orderId: order.id,
            level: rung.level,
            target: rung.target as EscalationTarget,
            delaySeconds: elapsedSeconds,
          },
        });

        // The notification itself is not sent here. It goes through the outbox
        // like every other event, so an escalation cannot be lost because a
        // WhatsApp call failed (invariant 8, spec 32).
        await tx.outboxEvent.create({
          data: {
            id: randomUUID(),
            tenantId: order.tenantId,
            eventType: DomainEventType.ORDER_ACKNOWLEDGEMENT_TIMEOUT,
            aggregateType: AggregateType.ORDER,
            aggregateId: order.id,
            actor: 'SYSTEM',
            payload: {
              orderId: order.id,
              orderNumber: order.orderNumber,
              branchId: order.branchId,
              level: rung.level,
              target: rung.target,
              elapsedSeconds,
            } as Prisma.InputJsonValue,
          },
        });
      });

      this.logger.warn(
        {
          orderId: order.id,
          orderNumber: order.orderNumber,
          level: rung.level,
          target: rung.target,
          elapsedSeconds,
        },
        'Order unacknowledged; escalating',
      );

      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // Another worker got there first. Correct, and not worth logging as a
        // problem.
        return false;
      }
      throw error;
    }
  }

  /** Clears open escalations for orders that have since been acknowledged. */
  private async resolveAcknowledged(): Promise<void> {
    const open = await this.prisma.orderEscalation.findMany({
      where: { resolvedAt: null },
      select: { id: true, orderId: true },
      take: 500,
    });

    if (open.length === 0) return;

    const orderIds = [...new Set(open.map((row) => row.orderId))];
    const stillWaiting = await this.prisma.order.findMany({
      where: { id: { in: orderIds }, status: OrderStatus.CONFIRMED },
      select: { id: true },
    });

    const waitingIds = new Set(stillWaiting.map((order) => order.id));
    const resolvable = open
      .filter((row) => !waitingIds.has(row.orderId))
      .map((row) => row.id);

    if (resolvable.length > 0) {
      await this.prisma.orderEscalation.updateMany({
        where: { id: { in: resolvable } },
        data: { resolvedAt: new Date() },
      });
    }
  }

  /**
   * The tenant's ladder, or the default.
   *
   * A misconfigured ladder falls back to the default rather than disabling
   * escalation for that restaurant — losing the alarm because of a bad settings
   * entry is exactly the outcome spec 33 exists to prevent.
   */
  private ladderFor(settings: unknown, tenantId: string): EscalationRung[] {
    const raw = (settings as { escalationLadder?: unknown } | null)?.escalationLadder;
    if (!Array.isArray(raw) || raw.length === 0) {
      return [...DEFAULT_ESCALATION_LADDER];
    }

    try {
      return normalizeEscalationLadder(raw as EscalationRung[]);
    } catch (error) {
      this.logger.error(
        { err: error, tenantId },
        'Invalid escalation ladder in tenant settings; using the default',
      );
      return [...DEFAULT_ESCALATION_LADDER];
    }
  }
}
