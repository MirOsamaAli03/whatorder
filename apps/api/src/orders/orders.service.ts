import { Injectable } from '@nestjs/common';
import { Prisma, type TransactionClient } from '@restaurant-os/database';
import {
  BranchAccessDeniedError,
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  assertTransition,
  canAccessBranch,
  completionStatusFor,
  computeBusinessDate,
  customerMayCancel,
  nextStatuses,
  statusAfterCheckout,
} from '@restaurant-os/domain';
import {
  AggregateType,
  AuditAction,
  CartStatus,
  DomainEventType,
  ErrorCode,
  OrderStatus,
  OrderType,
  PaymentMethod,
  PaymentStatus,
  Permission,
  type AuthContext,
} from '@restaurant-os/types';
import { AuditService } from '../audit/audit.service';
import { toMoneyString } from '../common/decimal';
import { normalizePhone } from '../common/phone';
import { CustomersService } from '../customers/customers.service';
import { OutboxService } from '../events/outbox.service';
import { CartPricingService } from '../pricing/cart-pricing.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CheckoutDto, ListOrdersDto, TransitionOrderDto } from './orders.dto';

/** Which timestamp column each status stamps (ENGINEERING_SPEC.md 35). */
const STAGE_TIMESTAMP: Partial<Record<OrderStatus, string>> = {
  [OrderStatus.CONFIRMED]: 'confirmedAt',
  [OrderStatus.ACCEPTED]: 'acceptedAt',
  [OrderStatus.PREPARING]: 'preparingAt',
  [OrderStatus.READY]: 'readyAt',
  [OrderStatus.OUT_FOR_DELIVERY]: 'dispatchedAt',
  [OrderStatus.DELIVERED]: 'completedAt',
  [OrderStatus.COMPLETED]: 'completedAt',
  [OrderStatus.CANCELLED]: 'cancelledAt',
  [OrderStatus.REJECTED]: 'cancelledAt',
};

/**
 * Orders (ENGINEERING_SPEC.md 12–16, 28, 35).
 *
 * Two things in here carry most of the weight:
 *
 *   checkout()        — the only place a cart becomes an order, and the only
 *                       place prices are snapshotted (spec 13, invariant 5).
 *   transitionOrder() — the only place `status` ever changes (spec 16,
 *                       invariant 6). An ESLint rule rejects direct writes.
 *
 * Every channel — POS, WhatsApp, website, QR — goes through these. There is no
 * WhatsAppOrderService or POSOrderService, which is spec 87's whole point.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: CartPricingService,
    private readonly customers: CustomersService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  // -------------------------------------------------------------------------
  // Checkout
  // -------------------------------------------------------------------------

  /**
   * Converts a cart into an order (ENGINEERING_SPEC.md 28).
   *
   * Everything happens in one transaction: the order, its snapshotted lines,
   * the status history row, the audit entry, the outbox event and closing the
   * cart. A half-written order is worse than no order — the kitchen would cook
   * something the customer was never charged for.
   */
  async checkout(auth: AuthContext, input: CheckoutDto) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const cart = await tx.cart.findUnique({ where: { id: input.cartId } });
      if (!cart) throw new NotFoundError('Cart', input.cartId);

      if (!canAccessBranch(auth, cart.branchId)) throw new BranchAccessDeniedError();

      if (cart.status !== CartStatus.ACTIVE) {
        throw new ConflictError('This cart has already been checked out');
      }

      const [organization, branch] = await Promise.all([
        tx.organization.findUniqueOrThrow({
          where: { id: auth.tenantId },
          select: { currency: true, timezone: true, businessDayStartMinutes: true },
        }),
        tx.branch.findUniqueOrThrow({ where: { id: cart.branchId } }),
      ]);

      const customer = await this.customers.findOrCreateInTransaction(tx, auth.tenantId, {
        phone: input.customerPhone,
        name: input.customerName ?? null,
      });

      if (customer.isBlocked) {
        throw new DomainError(ErrorCode.FORBIDDEN, 'This customer is blocked', 403);
      }

      const delivery = await this.resolveDelivery(tx, {
        orderType: cart.orderType,
        customerId: customer.id,
        addressId: input.addressId,
        address: input.deliveryAddress,
        latitude: input.deliveryLatitude,
        longitude: input.deliveryLongitude,
      });

      // strict: an unavailable item now fails the checkout rather than being
      // reported as a blocker. This is the last moment the menu is consulted.
      const priced = await this.pricing.priceCart(tx, {
        cartId: cart.id,
        tenantId: auth.tenantId,
        deliveryPoint: delivery.point,
        strict: true,
      });

      if (priced.blockers.length > 0) {
        throw new ValidationError(priced.blockers[0]!, [
          { path: 'cart', message: priced.blockers.join('; ') },
        ]);
      }

      const businessDate = computeBusinessDate(
        new Date(),
        organization.timezone,
        organization.businessDayStartMinutes,
      );

      const orderNumber = await this.allocateOrderNumber(
        tx,
        auth.tenantId,
        branch,
        businessDate,
      );

      const status = statusAfterCheckout(input.paymentMethod);
      const now = new Date();

      const order = await tx.order.create({
        data: {
          tenantId: auth.tenantId,
          branchId: cart.branchId,
          customerId: customer.id,
          addressId: delivery.addressId,
          orderNumber,
          source: cart.source,
          orderType: cart.orderType,
          status,
          // Cash orders rest at UNPAID until the money is handed over; that is
          // the normal state of a COD order, not a problem to be fixed.
          paymentStatus:
            input.paymentMethod === PaymentMethod.ONLINE
              ? PaymentStatus.PENDING
              : PaymentStatus.UNPAID,
          paymentMethod: input.paymentMethod,
          businessDate: new Date(`${businessDate}T00:00:00Z`),

          subtotal: priced.totals.subtotal.toDecimalString(),
          discountAmount: priced.totals.discountAmount.toDecimalString(),
          serviceCharge: priced.totals.serviceCharge.toDecimalString(),
          deliveryFee: priced.totals.deliveryFee.toDecimalString(),
          taxAmount: priced.totals.taxAmount.toDecimalString(),
          total: priced.totals.total.toDecimalString(),
          currency: priced.currency,

          customerName: input.customerName ?? customer.name,
          customerPhone: normalizePhone(input.customerPhone),

          deliveryAddress: delivery.addressText,
          deliveryLatitude: delivery.point?.latitude ?? null,
          deliveryLongitude: delivery.point?.longitude ?? null,
          tableLabel: input.tableLabel ?? null,

          notes: input.notes ?? cart.notes,
          confirmedAt: status === OrderStatus.CONFIRMED ? now : null,
        },
      });

      // Snapshot every line. Nothing on an order_item is ever resolved by
      // joining back to the menu, so a later price change cannot rewrite this
      // receipt (spec 13, invariant 5).
      for (const line of priced.lines) {
        const orderItem = await tx.orderItem.create({
          data: {
            tenantId: auth.tenantId,
            orderId: order.id,
            menuItemId: line.menuItemId,
            variantId: line.variantId,
            itemNameSnapshot: line.itemName,
            variantNameSnapshot: line.variantName,
            unitPrice: line.unitPrice.toDecimalString(),
            modifiersTotal: line.modifiersTotal.toDecimalString(),
            quantity: line.quantity,
            totalPrice: line.lineTotal.toDecimalString(),
            costPriceSnapshot: line.costPrice?.toDecimalString() ?? null,
            notes: line.notes,
          },
        });

        if (line.modifiers.length > 0) {
          await tx.orderItemModifier.createMany({
            data: line.modifiers.map((modifier) => ({
              tenantId: auth.tenantId,
              orderItemId: orderItem.id,
              modifierId: modifier.modifierId,
              optionId: modifier.optionId,
              modifierNameSnapshot: modifier.modifierName,
              optionNameSnapshot: modifier.optionName,
              priceDelta: modifier.priceDelta.toDecimalString(),
            })),
          });
        }
      }

      await tx.orderStatusHistory.createMany({
        data: [
          {
            tenantId: auth.tenantId,
            orderId: order.id,
            fromStatus: null,
            toStatus: status,
            actorId: auth.userId,
            actorType: 'USER',
            reason: 'Checkout',
          },
        ],
      });

      await tx.cart.update({
        where: { id: cart.id },
        data: { status: CartStatus.CHECKED_OUT },
      });

      await tx.customer.update({
        where: { id: customer.id },
        data: {
          lastOrderAt: now,
          ...(customer.firstOrderAt ? {} : { firstOrderAt: now }),
        },
      });

      await this.audit.recordIn(tx, {
        action: AuditAction.CREATE,
        entityType: 'Order',
        entityId: order.id,
        tenantId: auth.tenantId,
        newValues: {
          orderNumber: order.orderNumber,
          total: toMoneyString(order.total),
          status: order.status,
          paymentMethod: order.paymentMethod,
        },
      });

      await this.outbox.emit(tx, {
        eventType: DomainEventType.ORDER_CREATED,
        aggregateType: AggregateType.ORDER,
        aggregateId: order.id,
        tenantId: auth.tenantId,
        payload: {
          orderId: order.id,
          orderNumber: order.orderNumber,
          branchId: order.branchId,
          status: order.status,
          orderType: order.orderType,
          total: toMoneyString(order.total),
          currency: order.currency,
        },
      });

      // CONFIRMED starts the acknowledgement clock (spec 33), so it is its own
      // event rather than being implied by ORDER_CREATED — a card order that
      // is still awaiting payment must not start that timer.
      if (status === OrderStatus.CONFIRMED) {
        await this.emitStatusEvent(
          tx,
          auth.tenantId,
          order.branchId,
          order.id,
          null,
          OrderStatus.CONFIRMED,
        );
      }

      return this.findOneInTransaction(tx, order.id);
    });
  }

  // -------------------------------------------------------------------------
  // The single state transition entry point (ENGINEERING_SPEC.md 16)
  // -------------------------------------------------------------------------

  /**
   * Moves an order to a new status.
   *
   * The nine steps spec 16 requires, in order: load, verify tenant, verify
   * actor, validate current state, validate target state, update, audit,
   * publish event, and leave notifications to the queue. Everything runs in one
   * transaction so a status change and its history, audit row and event either
   * all happen or none do.
   */
  async transitionOrder(auth: AuthContext, orderId: string, input: TransitionOrderDto) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      // 1 & 2 — load, tenant verified by RLS and by the scoped transaction.
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new NotFoundError('Order', orderId);

      // 3 — the actor may act on this branch, and on this kind of change.
      if (!canAccessBranch(auth, order.branchId)) throw new BranchAccessDeniedError();
      this.assertActorMayTransition(auth, order.status, input.status);

      // 4 & 5 — the state machine decides, using data rather than branching.
      assertTransition(order.status, input.status, { orderType: order.orderType });

      if (
        (input.status === OrderStatus.CANCELLED || input.status === OrderStatus.REJECTED) &&
        !input.reason
      ) {
        // A cancellation without a reason is unanswerable when the customer
        // asks why, and it is the first thing a manager looks for.
        throw new ValidationError('A reason is required when cancelling or rejecting an order');
      }

      const now = new Date();
      const timestampField = STAGE_TIMESTAMP[input.status];

      // 6 — the update.
      //
      // This is the single permitted write of `order.status`, and the lint rule
      // that forbids it everywhere else is disabled for exactly these lines.
      // The exemption is deliberately one line wide: if a second site ever
      // needs it, that is the signal the rule is there to raise.
      const updated = await tx.order.update({
        where: { id: orderId },
        data: {
          // eslint-disable-next-line no-restricted-syntax -- the one legitimate status write (spec 16)
          status: input.status,
          ...(timestampField ? { [timestampField]: now } : {}),
          ...(input.reason ? { cancellationReason: input.reason } : {}),
          // Cash is collected at handover, so reaching the customer is what
          // makes a COD order paid.
          ...(this.shouldMarkPaid(order, input.status)
            ? { paymentStatus: PaymentStatus.PAID }
            : {}),
        },
      });

      await tx.orderStatusHistory.createMany({
        data: [
          {
            tenantId: auth.tenantId,
            orderId,
            fromStatus: order.status,
            toStatus: input.status,
            actorId: auth.userId,
            actorType: 'USER',
            reason: input.reason ?? null,
          },
        ],
      });

      // 7 — audit.
      await this.audit.recordIn(tx, {
        action: AuditAction.ORDER_TRANSITION,
        entityType: 'Order',
        entityId: orderId,
        tenantId: auth.tenantId,
        oldValues: { status: order.status, paymentStatus: order.paymentStatus },
        newValues: {
          status: updated.status,
          paymentStatus: updated.paymentStatus,
          reason: input.reason ?? null,
        },
      });

      // 8 — the domain event. 9 — notifications are the worker's job (spec 32),
      // and must never be able to fail this transaction (invariant 8).
      await this.emitStatusEvent(
        tx,
        auth.tenantId,
        order.branchId,
        orderId,
        order.status,
        updated.status,
      );

      // Lifetime figures count orders the customer actually received.
      if (
        updated.customerId &&
        (updated.status === OrderStatus.DELIVERED || updated.status === OrderStatus.COMPLETED)
      ) {
        await tx.customer.update({
          where: { id: updated.customerId },
          data: {
            totalOrders: { increment: 1 },
            totalSpend: { increment: updated.total },
          },
        });
      }

      return this.findOneInTransaction(tx, orderId);
    });
  }

  /** Cancellation, expressed through the same state machine. */
  async cancel(auth: AuthContext, orderId: string, reason: string) {
    return this.transitionOrder(auth, orderId, { status: OrderStatus.CANCELLED, reason });
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async findAll(auth: AuthContext, query: ListOrdersDto) {
    if (query.branchId && !canAccessBranch(auth, query.branchId)) {
      throw new BranchAccessDeniedError();
    }

    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const where: Prisma.OrderWhereInput = {
        // A branch-scoped user never sees another branch's orders (spec 7).
        ...(auth.branchIds === null
          ? query.branchId
            ? { branchId: query.branchId }
            : {}
          : { branchId: query.branchId ? query.branchId : { in: auth.branchIds } }),
        ...(query.status ? { status: { in: query.status } } : {}),
        ...(query.source ? { source: query.source } : {}),
        ...(query.orderType ? { orderType: query.orderType } : {}),
        ...(query.customerId ? { customerId: query.customerId } : {}),
        ...(query.businessDate
          ? { businessDate: new Date(`${query.businessDate}T00:00:00Z`) }
          : {}),
      };

      const [orders, total] = await Promise.all([
        tx.order.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: query.limit ?? 50,
          skip: query.offset ?? 0,
          include: { items: { include: { modifiers: true } } },
        }),
        tx.order.count({ where }),
      ]);

      return { orders: orders.map((order) => this.present(order)), total };
    });
  }

  async findOne(auth: AuthContext, orderId: string) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new NotFoundError('Order', orderId);
      if (!canAccessBranch(auth, order.branchId)) throw new BranchAccessDeniedError();
      return this.findOneInTransaction(tx, orderId);
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Allocates a human-readable order number, unique per branch per business
   * day, e.g. `DHA-0042`.
   *
   * The counter row is updated inside the order's transaction, which takes a
   * row lock, so two simultaneous checkouts at one branch cannot be handed the
   * same number. A sequence would be simpler but would produce gaps and leak
   * platform-wide volume to anyone who counted them.
   */
  private async allocateOrderNumber(
    tx: TransactionClient,
    tenantId: string,
    branch: { id: string; slug: string },
    businessDate: string,
  ): Promise<string> {
    const date = new Date(`${businessDate}T00:00:00Z`);

    const counter = await tx.orderNumberCounter.upsert({
      where: { branchId_businessDate: { branchId: branch.id, businessDate: date } },
      create: { tenantId, branchId: branch.id, businessDate: date, lastNumber: 1 },
      update: { lastNumber: { increment: 1 } },
    });

    const prefix = branch.slug.slice(0, 6).toUpperCase();
    return `${prefix}-${String(counter.lastNumber).padStart(4, '0')}`;
  }

  /**
   * Resolves where a delivery order is going.
   *
   * A saved address is preferred because it carries coordinates, which is what
   * makes zone matching and the delivery fee correct. An inline address is
   * accepted for a first-time customer, and then has no coordinates unless the
   * caller supplies them.
   */
  private async resolveDelivery(
    tx: TransactionClient,
    input: {
      orderType: OrderType;
      customerId: string;
      addressId?: string;
      address?: string;
      latitude?: number;
      longitude?: number;
    },
  ): Promise<{
    addressId: string | null;
    addressText: string | null;
    point: { latitude: number; longitude: number } | null;
  }> {
    if (input.orderType !== OrderType.DELIVERY) {
      return { addressId: null, addressText: null, point: null };
    }

    if (input.addressId) {
      const address = await tx.customerAddress.findUnique({ where: { id: input.addressId } });
      if (!address || address.customerId !== input.customerId) {
        throw new NotFoundError('Address', input.addressId);
      }

      return {
        addressId: address.id,
        addressText: address.address,
        point:
          address.latitude !== null && address.longitude !== null
            ? { latitude: Number(address.latitude), longitude: Number(address.longitude) }
            : null,
      };
    }

    if (!input.address) {
      throw new ValidationError('A delivery address is required for delivery orders');
    }

    return {
      addressId: null,
      addressText: input.address,
      point:
        input.latitude !== undefined && input.longitude !== undefined
          ? { latitude: input.latitude, longitude: input.longitude }
          : null,
    };
  }

  /**
   * Role rules that sit on top of the endpoint's permission.
   *
   * `orders.update` covers the whole kitchen workflow, but cancelling a
   * confirmed order is a different kind of decision from moving it to READY,
   * so it needs `orders.cancel` as well.
   */
  private assertActorMayTransition(
    auth: AuthContext,
    from: OrderStatus,
    to: OrderStatus,
  ): void {
    const isCancellation = to === OrderStatus.CANCELLED || to === OrderStatus.REJECTED;

    if (isCancellation && !auth.permissions.includes(Permission.ORDERS_CANCEL)) {
      // Before the kitchen commits, cancelling is routine and anyone who can
      // take the order may undo it.
      if (!customerMayCancel(from)) {
        throw new ForbiddenError(
          'Cancelling an order the kitchen has started requires the orders.cancel permission',
        );
      }
    }
  }

  /** Cash and card-on-delivery are settled when the customer receives it. */
  private shouldMarkPaid(
    order: { paymentMethod: PaymentMethod; paymentStatus: PaymentStatus },
    to: OrderStatus,
  ): boolean {
    const isHandover = to === OrderStatus.DELIVERED || to === OrderStatus.COMPLETED;
    const isCollectedOnHandover =
      order.paymentMethod === PaymentMethod.CASH ||
      order.paymentMethod === PaymentMethod.CARD_ON_DELIVERY;

    return isHandover && isCollectedOnHandover && order.paymentStatus === PaymentStatus.UNPAID;
  }

  /**
   * Publishes a status change.
   *
   * `branchId` is not decoration: the outbox publisher routes on it, sending
   * events that carry one to `tenant:{id}:branch:{id}:orders` and everything
   * else to the tenant-wide channel. An event without it would be delivered to
   * the wrong channel, and a kitchen screen — which subscribes only to its own
   * branch — would show new orders but never see them move.
   */
  private async emitStatusEvent(
    tx: TransactionClient,
    tenantId: string,
    branchId: string,
    orderId: string,
    from: OrderStatus | null,
    to: OrderStatus,
  ): Promise<void> {
    await this.outbox.emit(tx, {
      eventType: DomainEventType.ORDER_STATUS_CHANGED,
      aggregateType: AggregateType.ORDER,
      aggregateId: orderId,
      tenantId,
      payload: { orderId, branchId, fromStatus: from, toStatus: to },
    });
  }

  private async findOneInTransaction(tx: TransactionClient, orderId: string) {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        items: { include: { modifiers: true }, orderBy: { createdAt: 'asc' } },
        history: { orderBy: { createdAt: 'asc' } },
      },
    });

    return this.present(order);
  }

  private present(order: {
    id: string;
    orderNumber: string;
    branchId: string;
    customerId: string | null;
    source: string;
    orderType: OrderType;
    status: OrderStatus;
    paymentStatus: PaymentStatus;
    paymentMethod: PaymentMethod;
    businessDate: Date;
    subtotal: Prisma.Decimal;
    discountAmount: Prisma.Decimal;
    serviceCharge: Prisma.Decimal;
    deliveryFee: Prisma.Decimal;
    taxAmount: Prisma.Decimal;
    total: Prisma.Decimal;
    currency: string;
    customerName: string | null;
    customerPhone: string;
    deliveryAddress: string | null;
    tableLabel: string | null;
    notes: string | null;
    cancellationReason: string | null;
    createdAt: Date;
    confirmedAt: Date | null;
    acceptedAt: Date | null;
    preparingAt: Date | null;
    readyAt: Date | null;
    dispatchedAt: Date | null;
    completedAt: Date | null;
    cancelledAt: Date | null;
    items?: Array<{
      id: string;
      menuItemId: string | null;
      itemNameSnapshot: string;
      variantNameSnapshot: string | null;
      unitPrice: Prisma.Decimal;
      modifiersTotal: Prisma.Decimal;
      quantity: number;
      totalPrice: Prisma.Decimal;
      notes: string | null;
      modifiers?: Array<{
        modifierNameSnapshot: string;
        optionNameSnapshot: string;
        priceDelta: Prisma.Decimal;
      }>;
    }>;
    history?: Array<{
      fromStatus: OrderStatus | null;
      toStatus: OrderStatus;
      actorId: string | null;
      reason: string | null;
      createdAt: Date;
    }>;
  }) {
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      branchId: order.branchId,
      customerId: order.customerId,
      source: order.source,
      orderType: order.orderType,
      status: order.status,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      businessDate: order.businessDate.toISOString().slice(0, 10),

      currency: order.currency,
      totals: {
        subtotal: toMoneyString(order.subtotal),
        discountAmount: toMoneyString(order.discountAmount),
        serviceCharge: toMoneyString(order.serviceCharge),
        deliveryFee: toMoneyString(order.deliveryFee),
        taxAmount: toMoneyString(order.taxAmount),
        total: toMoneyString(order.total),
      },

      customerName: order.customerName,
      customerPhone: order.customerPhone,
      deliveryAddress: order.deliveryAddress,
      tableLabel: order.tableLabel,
      notes: order.notes,
      cancellationReason: order.cancellationReason,

      timestamps: {
        createdAt: order.createdAt,
        confirmedAt: order.confirmedAt,
        acceptedAt: order.acceptedAt,
        preparingAt: order.preparingAt,
        readyAt: order.readyAt,
        dispatchedAt: order.dispatchedAt,
        completedAt: order.completedAt,
        cancelledAt: order.cancelledAt,
      },

      /** What this order may do next, for rendering action buttons. */
      allowedTransitions: nextStatuses(order.status, { orderType: order.orderType }),
      /** The terminal success state for this order type. */
      completionStatus: completionStatusFor(order.orderType),

      items:
        order.items?.map((item) => ({
          id: item.id,
          menuItemId: item.menuItemId,
          name: item.itemNameSnapshot,
          variantName: item.variantNameSnapshot,
          unitPrice: toMoneyString(item.unitPrice),
          modifiersTotal: toMoneyString(item.modifiersTotal),
          quantity: item.quantity,
          totalPrice: toMoneyString(item.totalPrice),
          notes: item.notes,
          modifiers:
            item.modifiers?.map((modifier) => ({
              modifierName: modifier.modifierNameSnapshot,
              optionName: modifier.optionNameSnapshot,
              priceDelta: toMoneyString(modifier.priceDelta),
            })) ?? [],
        })) ?? [],

      history:
        order.history?.map((entry) => ({
          fromStatus: entry.fromStatus,
          toStatus: entry.toStatus,
          actorId: entry.actorId,
          reason: entry.reason,
          at: entry.createdAt,
        })) ?? [],
    };
  }
}
