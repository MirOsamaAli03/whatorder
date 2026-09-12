import { Injectable } from '@nestjs/common';
import type { TransactionClient } from '@restaurant-os/database';
import {
  BranchAccessDeniedError,
  KDS_COLUMNS,
  KDS_STATUSES,
  NotFoundError,
  canAccessBranch,
  elapsedInColumn,
  isUnacknowledged,
  kdsColumnFor,
  urgencyFor,
  type KdsColumn,
} from '@restaurant-os/domain';
import { OrderStatus, type AuthContext } from '@restaurant-os/types';
import { resolveSettings } from '../pricing/tenant-settings';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Default colouring bands for a card's age. Overridable per tenant, because a
 * biryani and a burger are not late at the same moment.
 */
const DEFAULT_URGENCY = { warningSeconds: 300, criticalSeconds: 600 };

/**
 * Kitchen Display System (ENGINEERING_SPEC.md 33, 34, 35).
 *
 * The snapshot is the backbone of the reliability story, not a fallback. A
 * socket-only kitchen screen is worse than a polling one, because a silently
 * dead connection loses orders invisibly (plan 2.8). The screen therefore:
 *
 *   1. loads a snapshot, which carries the current outbox sequence;
 *   2. applies live events, each carrying its own sequence;
 *   3. reloads the snapshot whenever it sees a gap, a disconnect, or nothing
 *      at all for too long.
 *
 * That makes the live stream an optimisation over a correct baseline rather
 * than the only thing standing between a customer and an uncooked order.
 */
@Injectable()
export class KdsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Everything a kitchen screen needs to render itself from scratch.
   *
   * `sequence` is the watermark: the client records it, and anything arriving
   * with a sequence more than one ahead means events were missed.
   */
  async snapshot(auth: AuthContext, branchId: string) {
    if (!canAccessBranch(auth, branchId)) throw new BranchAccessDeniedError();

    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const branch = await tx.branch.findUnique({ where: { id: branchId } });
      if (!branch) throw new NotFoundError('Branch', branchId);

      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: auth.tenantId },
        select: { settings: true, currency: true },
      });

      const settings = resolveSettings(
        organization.settings,
        branch.settings,
        organization.currency,
      );

      const orders = await tx.order.findMany({
        where: { branchId, status: { in: [...KDS_STATUSES] } },
        orderBy: { confirmedAt: 'asc' },
        include: {
          items: {
            orderBy: { createdAt: 'asc' },
            include: { modifiers: true },
          },
        },
      });

      const now = new Date();
      const sequence = await this.currentSequence(tx);

      const columns = Object.fromEntries(
        KDS_COLUMNS.map((column) => [column, [] as ReturnType<typeof this.presentCard>[]]),
      ) as Record<KdsColumn, ReturnType<typeof this.presentCard>[]>;

      for (const order of orders) {
        const column = kdsColumnFor(order.status);
        if (!column) continue;
        columns[column].push(this.presentCard(order, now, settings.acknowledgementTimeoutSeconds));
      }

      return {
        branchId,
        branchName: branch.name,
        /** Watermark for gap detection on the live stream. */
        sequence,
        serverTime: now.toISOString(),
        acknowledgementTimeoutSeconds: settings.acknowledgementTimeoutSeconds,
        urgency: DEFAULT_URGENCY,
        columns,
        counts: Object.fromEntries(
          KDS_COLUMNS.map((column) => [column, columns[column].length]),
        ) as Record<KdsColumn, number>,
        unacknowledged: columns.NEW.filter((card) => card.isUnacknowledged).length,
      };
    });
  }

  /**
   * Orders that have gone unacknowledged, with the escalation rungs that fired
   * (ENGINEERING_SPEC.md 33).
   *
   * This is what a dashboard banner reads: "12 confirmed orders have not been
   * acknowledged for more than 2 minutes."
   */
  async unacknowledged(auth: AuthContext, branchId?: string) {
    if (branchId && !canAccessBranch(auth, branchId)) throw new BranchAccessDeniedError();

    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: auth.tenantId },
        select: { settings: true, currency: true },
      });
      const settings = resolveSettings(organization.settings, null, organization.currency);

      const branchFilter = branchId
        ? { branchId }
        : auth.branchIds === null
          ? {}
          : { branchId: { in: auth.branchIds } };

      const orders = await tx.order.findMany({
        where: { status: OrderStatus.CONFIRMED, ...branchFilter },
        orderBy: { confirmedAt: 'asc' },
        include: { escalations: { orderBy: { level: 'asc' } } },
      });

      const now = new Date();

      const overdue = orders
        .map((order) => {
          const elapsedSeconds = elapsedInColumn(now, order);
          return { order, elapsedSeconds };
        })
        .filter(({ order, elapsedSeconds }) =>
          isUnacknowledged({
            status: order.status,
            elapsedSeconds,
            thresholdSeconds: settings.acknowledgementTimeoutSeconds,
          }),
        );

      return {
        thresholdSeconds: settings.acknowledgementTimeoutSeconds,
        count: overdue.length,
        orders: overdue.map(({ order, elapsedSeconds }) => ({
          id: order.id,
          orderNumber: order.orderNumber,
          branchId: order.branchId,
          orderType: order.orderType,
          source: order.source,
          confirmedAt: order.confirmedAt,
          waitingSeconds: elapsedSeconds,
          escalations: order.escalations.map((escalation) => ({
            level: escalation.level,
            target: escalation.target,
            delaySeconds: escalation.delaySeconds,
            at: escalation.createdAt,
            resolvedAt: escalation.resolvedAt,
          })),
        })),
      };
    });
  }

  /**
   * Events this branch missed, for a client that reconnects with a stale
   * sequence.
   *
   * Bounded: past a certain gap, replaying is slower and less reliable than
   * reloading, so the client is told to take a fresh snapshot instead.
   */
  async since(auth: AuthContext, branchId: string, afterSequence: bigint, limit = 200) {
    if (!canAccessBranch(auth, branchId)) throw new BranchAccessDeniedError();

    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const current = await this.currentSequence(tx);

      const events = await tx.outboxEvent.findMany({
        where: { sequence: { gt: afterSequence } },
        orderBy: { sequence: 'asc' },
        take: limit + 1,
      });

      const forBranch = events.filter((event) => {
        const payload = (event.payload ?? {}) as { branchId?: unknown };
        return payload.branchId === branchId || payload.branchId === undefined;
      });

      // More than one page behind: a snapshot is cheaper and cannot be wrong.
      const resyncRequired = events.length > limit;

      return {
        sequence: current,
        resyncRequired,
        events: resyncRequired
          ? []
          : forBranch.map((event) => ({
              sequence: event.sequence.toString(),
              eventId: event.id,
              eventType: event.eventType,
              aggregateType: event.aggregateType,
              aggregateId: event.aggregateId,
              payload: event.payload,
              occurredAt: event.createdAt,
            })),
      };
    });
  }

  /** The highest published sequence, used as the snapshot watermark. */
  private async currentSequence(tx: TransactionClient): Promise<string> {
    const rows = await tx.$queryRaw<Array<{ max: bigint | null }>>`
      SELECT MAX(sequence) AS max FROM outbox_events
    `;
    return (rows[0]?.max ?? 0n).toString();
  }

  private presentCard(
    order: {
      id: string;
      orderNumber: string;
      status: OrderStatus;
      orderType: string;
      source: string;
      tableLabel: string | null;
      deliveryAddress: string | null;
      customerName: string | null;
      notes: string | null;
      createdAt: Date;
      confirmedAt: Date | null;
      acceptedAt: Date | null;
      preparingAt: Date | null;
      readyAt: Date | null;
      items: Array<{
        id: string;
        itemNameSnapshot: string;
        variantNameSnapshot: string | null;
        quantity: number;
        notes: string | null;
        modifiers: Array<{ modifierNameSnapshot: string; optionNameSnapshot: string }>;
      }>;
    },
    now: Date,
    acknowledgementTimeoutSeconds: number,
  ) {
    const elapsedSeconds = elapsedInColumn(now, order);

    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      column: kdsColumnFor(order.status),
      orderType: order.orderType,
      source: order.source,

      // A kitchen card carries no phone number and no money (spec 11): the
      // kitchen needs to cook the food, not to know what it cost.
      customerName: order.customerName,
      tableLabel: order.tableLabel,
      /** Present for delivery so the kitchen can judge travel time. */
      hasDeliveryAddress: Boolean(order.deliveryAddress),
      notes: order.notes,

      elapsedSeconds,
      urgency: urgencyFor(elapsedSeconds, DEFAULT_URGENCY),
      isUnacknowledged: isUnacknowledged({
        status: order.status,
        elapsedSeconds,
        thresholdSeconds: acknowledgementTimeoutSeconds,
      }),

      placedAt: order.confirmedAt ?? order.createdAt,

      items: order.items.map((item) => ({
        id: item.id,
        name: item.itemNameSnapshot,
        variantName: item.variantNameSnapshot,
        quantity: item.quantity,
        notes: item.notes,
        modifiers: item.modifiers.map(
          (modifier) => `${modifier.modifierNameSnapshot}: ${modifier.optionNameSnapshot}`,
        ),
      })),
    };
  }
}
