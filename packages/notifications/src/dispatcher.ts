import {
  Prisma,
  withTenantContext,
  type PrismaClient,
  type TransactionClient,
} from '@restaurant-os/database';
import {
  ESCALATION_NOTIFICATION,
  notificationForOrderStatus,
  type MessageVariables,
  type NotificationSpec,
} from '@restaurant-os/domain';
import {
  DomainEventType,
  NotificationChannel,
  NotificationStatus,
  OrderStatus,
  Permission,
  RecipientType,
} from '@restaurant-os/types';
import type { Logger } from 'pino';

const CONSUMER = 'notifications';

/**
 * Turns committed domain events into the notifications they imply
 * (ENGINEERING_SPEC.md 30, 32).
 *
 * ## Why this reads the outbox with its own cursor
 *
 * The outbox already has a reader: OutboxPublisher fans events out to Redis and
 * marks each row PROCESSED. A second consumer cannot share that marker —
 * whichever got there first would hide the row from the other, and the symptom
 * would be *missing notifications*, which is silent. So this one keeps a
 * watermark in `outbox_cursors` and reads the outbox as an ordered log.
 *
 * ## Why it does not send anything
 *
 * It only writes rows. Sending is NotificationSender's job, on its own
 * schedule, with its own retries. That separation is what makes invariant 8
 * hold end to end: an order commits, an event commits with it, a notification
 * row is written from that event, and a WhatsApp outage can delay the last step
 * indefinitely without any of the earlier ones knowing or caring.
 *
 * ## Why it uses two database connections
 *
 * Discovering that work exists is a cross-tenant question, and answering it is
 * the worker role's whole purpose. But *doing* the work needs a customer's
 * phone number, and the worker role is deliberately refused customers at the
 * database (Phase 4). So the worker reads the outbox to learn which tenant has
 * work, and everything after that happens on an ordinary tenant-scoped
 * application connection under the same RLS policy the API uses.
 */
export class NotificationDispatcher {
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    /** Worker role: reads the outbox and the cursor across tenants. */
    private readonly workerPrisma: PrismaClient,
    /** Application role: everything tenant-scoped, under RLS. */
    private readonly appPrisma: PrismaClient,
    private readonly logger: Logger,
    private readonly options: { pollMs: number; batchSize: number },
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(0);
    this.logger.info(
      { pollMs: this.options.pollMs, batchSize: this.options.batchSize },
      'Notification dispatcher started',
    );
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
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      const read = await this.dispatchOnce();
      this.scheduleNext(read >= this.options.batchSize ? 0 : this.options.pollMs);
    } catch (error) {
      this.logger.error({ err: error }, 'Notification dispatch failed; retrying');
      this.scheduleNext(this.options.pollMs);
    }
  }

  /**
   * Reads one batch of events and writes the notifications they imply.
   *
   * Returns how many events were consumed, not how many notifications were
   * created — most events imply none.
   */
  async dispatchOnce(): Promise<number> {
    const cursor = await this.readCursor();

    const events = await this.workerPrisma.outboxEvent.findMany({
      where: { sequence: { gt: cursor } },
      orderBy: { sequence: 'asc' },
      take: this.options.batchSize,
    });

    if (events.length === 0) return 0;

    // Grouped by tenant so each tenant's work opens one transaction rather than
    // one per event.
    const byTenant = new Map<string, typeof events>();
    for (const event of events) {
      const existing = byTenant.get(event.tenantId);
      if (existing) existing.push(event);
      else byTenant.set(event.tenantId, [event]);
    }

    let created = 0;
    for (const [tenantId, tenantEvents] of byTenant) {
      created += await this.dispatchForTenant(tenantId, tenantEvents);
    }

    // Advanced only after every tenant's rows are committed. A crash before
    // this point replays the batch, which is safe: the unique constraint on
    // (event_id, recipient_type, recipient_id, channel) turns a replayed event
    // into a no-op rather than a second message.
    const highest = events[events.length - 1]!.sequence;
    await this.advanceCursor(highest);

    if (created > 0) {
      this.logger.info({ events: events.length, created }, 'Notifications queued');
    }

    return events.length;
  }

  private async readCursor(): Promise<bigint> {
    const row = await this.workerPrisma.outboxCursor.findUnique({
      where: { consumer: CONSUMER },
    });
    return row?.lastSequence ?? 0n;
  }

  private async advanceCursor(sequence: bigint): Promise<void> {
    await this.workerPrisma.outboxCursor.upsert({
      where: { consumer: CONSUMER },
      create: { consumer: CONSUMER, lastSequence: sequence },
      update: { lastSequence: sequence },
    });
  }

  /** All of one tenant's events, inside that tenant's RLS context. */
  private async dispatchForTenant(
    tenantId: string,
    events: Array<{
      id: string;
      eventType: string;
      payload: Prisma.JsonValue;
    }>,
  ): Promise<number> {
    const relevant = events.filter((event) => this.specFor(event.eventType, event.payload) !== null);
    if (relevant.length === 0) return 0;

    return withTenantContext(this.appPrisma, tenantId, async (tx) => {
      let created = 0;
      for (const event of relevant) {
        const spec = this.specFor(event.eventType, event.payload)!;
        created += await this.planNotifications(tx, tenantId, event.id, event.eventType, spec, event.payload);
      }
      return created;
    });
  }

  /**
   * Which notification an event implies, if any.
   *
   * ORDER_CREATED is deliberately ignored. A cash order is created already
   * CONFIRMED and emits a status event saying so, so acting on both would
   * message the customer twice about one thing; and a card order that is still
   * awaiting payment must not be announced at all.
   */
  private specFor(eventType: string, payload: Prisma.JsonValue): NotificationSpec | null {
    if (eventType === DomainEventType.ORDER_ACKNOWLEDGEMENT_TIMEOUT) {
      return ESCALATION_NOTIFICATION;
    }

    if (eventType !== DomainEventType.ORDER_STATUS_CHANGED) return null;

    const toStatus = readString(payload, 'toStatus');
    if (!toStatus) return null;

    return notificationForOrderStatus(toStatus as OrderStatus);
  }

  private async planNotifications(
    tx: TransactionClient,
    tenantId: string,
    eventId: string,
    eventType: string,
    spec: NotificationSpec,
    payload: Prisma.JsonValue,
  ): Promise<number> {
    const orderId = readString(payload, 'orderId');
    if (!orderId) return 0;

    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        branchId: true,
        customerId: true,
        cancellationReason: true,
        total: true,
        currency: true,
        branch: { select: { name: true } },
      },
    });

    // The order may have been deleted between the event and this pass. An
    // absent order is not an error; there is simply nobody to tell.
    if (!order) return 0;

    const organization = await tx.organization.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });

    const preferences = await tx.notificationPreference.findMany({ where: { tenantId } });
    const enabled = (recipientType: string, channel: NotificationChannel): boolean => {
      const preference = preferences.find(
        (row) => row.recipientType === recipientType && row.channel === channel,
      );
      // Absent means "default on": a tenant who has never opened the settings
      // page still gets their order notifications.
      return preference?.enabled ?? true;
    };

    const rows: Prisma.NotificationCreateManyInput[] = [];

    if (spec.notifyCustomer && order.customerId) {
      const customer = await tx.customer.findUnique({
        where: { id: order.customerId },
        select: { id: true, name: true, phone: true, whatsappNumber: true },
      });

      if (customer) {
        const variables: MessageVariables = {
          customerName: customer.name,
          orderNumber: order.orderNumber,
          restaurantName: organization?.name ?? 'the restaurant',
          branchName: order.branch.name,
          total: order.total.toFixed(2),
          currency: order.currency,
          reason: order.cancellationReason,
        };

        for (const channel of this.channelsFor(spec, (channel) =>
          enabled(RecipientType.CUSTOMER, channel),
        )) {
          rows.push({
            tenantId,
            branchId: order.branchId,
            eventId,
            eventType,
            recipientType: RecipientType.CUSTOMER,
            recipientId: customer.id,
            destination:
              channel === NotificationChannel.WHATSAPP
                ? (customer.whatsappNumber ?? customer.phone)
                : customer.phone,
            channel,
            templateKey: spec.templateKey,
            payload: { variables } as unknown as Prisma.InputJsonValue,
            status: NotificationStatus.PENDING,
            // Due immediately. The backoff ladder only starts once an attempt
            // has actually failed.
            nextAttemptAt: new Date(),
          });
        }
      }
    }

    if (spec.notifyStaff) {
      const staff = await this.staffFor(tx, tenantId, order.branchId);

      const variables: MessageVariables = {
        customerName: null,
        orderNumber: order.orderNumber,
        restaurantName: organization?.name ?? 'the restaurant',
        branchName: order.branch.name,
        reason: order.cancellationReason,
      };

      for (const member of staff) {
        for (const channel of this.channelsFor(spec, (channel) => {
          if (!enabled(RecipientType.STAFF, channel)) return false;
          // A staff member with no phone number can still be alerted in the
          // dashboard; they simply cannot be alerted on their phone.
          if (channel === NotificationChannel.DASHBOARD) return true;
          return Boolean(member.phone);
        })) {
          rows.push({
            tenantId,
            branchId: order.branchId,
            eventId,
            eventType,
            recipientType: RecipientType.STAFF,
            recipientId: member.id,
            destination: channel === NotificationChannel.DASHBOARD ? member.id : member.phone,
            channel,
            templateKey: spec.templateKey,
            payload: { variables } as unknown as Prisma.InputJsonValue,
            status: NotificationStatus.PENDING,
            nextAttemptAt: new Date(),
          });
        }
      }
    }

    if (rows.length === 0) return 0;

    // skipDuplicates, not a failed insert: replaying an event is expected after
    // a crash, and it must be a no-op rather than an error that stalls the
    // cursor forever.
    const result = await tx.notification.createMany({ data: rows, skipDuplicates: true });
    return result.count;
  }

  /**
   * The channels to actually use, honouring the spec's delivery mode.
   *
   * An order update takes the first channel that works — a customer does not
   * want the same news by WhatsApp and SMS. An escalation takes all of them,
   * because the dashboard alert being ignored is exactly the situation that
   * raised it (plan 2.8).
   */
  private channelsFor(
    spec: NotificationSpec,
    usable: (channel: NotificationChannel) => boolean,
  ): NotificationChannel[] {
    const candidates = spec.channels.filter(usable);
    if (candidates.length === 0) return [];
    return spec.deliveryMode === 'all-channels' ? candidates : [candidates[0]!];
  }

  /**
   * Who at this branch should hear about it.
   *
   * The same rule the API uses for reading orders: an active membership holding
   * `orders.view`, restricted to the branch unless the role is
   * organization-wide. Deriving it from permissions rather than from a
   * hard-coded role list means a tenant's custom role behaves like a system one
   * (ENGINEERING_SPEC.md 9).
   */
  private async staffFor(
    tx: TransactionClient,
    tenantId: string,
    branchId: string,
  ): Promise<Array<{ id: string; phone: string | null }>> {
    const memberships = await tx.membership.findMany({
      where: { tenantId, status: 'ACTIVE' },
      select: {
        userId: true,
        user: { select: { id: true, phone: true, status: true } },
        branches: { select: { branchId: true } },
        roles: {
          select: {
            role: { select: { permissions: { select: { permission: { select: { key: true } } } } } },
          },
        },
      },
    });

    const recipients: Array<{ id: string; phone: string | null }> = [];

    for (const membership of memberships) {
      if (membership.user.status !== 'ACTIVE') continue;

      const permissions = new Set(
        membership.roles.flatMap((membershipRole) =>
          membershipRole.role.permissions.map((rolePermission) => rolePermission.permission.key),
        ),
      );
      if (!permissions.has(Permission.ORDERS_VIEW)) continue;

      // No branch rows means an organization-wide role: everything is theirs.
      const branches = membership.branches.map((row) => row.branchId);
      if (branches.length > 0 && !branches.includes(branchId)) continue;

      recipients.push({ id: membership.user.id, phone: membership.user.phone });
    }

    return recipients;
  }
}

/** Reads a string field out of an outbox payload, which is untyped JSON. */
function readString(payload: Prisma.JsonValue, key: string): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}
