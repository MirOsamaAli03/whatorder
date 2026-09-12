import { Injectable } from '@nestjs/common';
import type { TransactionClient } from '@restaurant-os/database';
import {
  BranchAccessDeniedError,
  ConflictError,
  DomainError,
  NotFoundError,
  ValidationError,
  canAccessBranch,
  isOrderable,
} from '@restaurant-os/domain';
import {
  CartStatus,
  ErrorCode,
  MenuItemAvailability,
  OrderType,
  type AuthContext,
} from '@restaurant-os/types';
import { CartPricingService, type PricedCart } from '../pricing/cart-pricing.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AddCartItemDto, CreateCartDto, UpdateCartDto, UpdateCartItemDto } from './cart.dto';

/** How long an untouched cart survives before the sweeper may discard it. */
const CART_TTL_HOURS = 48;

/**
 * Cart management (ENGINEERING_SPEC.md 27).
 *
 * The cart holds *intent* — which item, which size, which options, how many —
 * and never money. Every total is computed on read by CartPricingService, so
 * there is no stored figure that can go stale and no client-supplied total that
 * could be believed (invariant 3).
 */
@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: CartPricingService,
  ) {}

  async create(auth: AuthContext, input: CreateCartDto) {
    if (!canAccessBranch(auth, input.branchId)) {
      throw new BranchAccessDeniedError();
    }

    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const branch = await tx.branch.findUnique({ where: { id: input.branchId } });
      if (!branch) throw new NotFoundError('Branch', input.branchId);

      this.assertBranchSupports(branch, input.orderType);

      if (input.customerId) {
        const customer = await tx.customer.findUnique({ where: { id: input.customerId } });
        if (!customer) throw new NotFoundError('Customer', input.customerId);
        if (customer.isBlocked) {
          throw new DomainError(ErrorCode.FORBIDDEN, 'This customer is blocked', 403);
        }
      }

      const cart = await tx.cart.create({
        data: {
          tenantId: auth.tenantId,
          branchId: input.branchId,
          customerId: input.customerId ?? null,
          source: input.source,
          orderType: input.orderType,
          notes: input.notes ?? null,
          expiresAt: new Date(Date.now() + CART_TTL_HOURS * 3_600_000),
        },
      });

      return this.priceAndPresent(tx, auth, cart.id);
    });
  }

  /**
   * Reads a cart in any state.
   *
   * A checked-out cart is still readable — support needs to see what the
   * customer had in front of them, and the client that just checked out may
   * poll it. Only mutation requires an ACTIVE cart.
   */
  async findOne(auth: AuthContext, cartId: string) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const cart = await tx.cart.findUnique({ where: { id: cartId } });
      if (!cart) throw new NotFoundError('Cart', cartId);
      if (!canAccessBranch(auth, cart.branchId)) throw new BranchAccessDeniedError();

      return this.priceAndPresent(tx, auth, cart.id);
    });
  }

  async update(auth: AuthContext, cartId: string, input: UpdateCartDto) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const cart = await this.loadActiveCart(tx, cartId, auth);

      if (input.orderType) {
        const branch = await tx.branch.findUniqueOrThrow({ where: { id: cart.branchId } });
        this.assertBranchSupports(branch, input.orderType);
      }

      if (input.customerId) {
        const customer = await tx.customer.findUnique({ where: { id: input.customerId } });
        if (!customer) throw new NotFoundError('Customer', input.customerId);
      }

      await tx.cart.update({
        where: { id: cartId },
        data: {
          ...(input.orderType !== undefined ? { orderType: input.orderType } : {}),
          ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          expiresAt: new Date(Date.now() + CART_TTL_HOURS * 3_600_000),
        },
      });

      return this.priceAndPresent(tx, auth, cartId);
    });
  }

  /**
   * Adds a line.
   *
   * Availability and the item's own modifier rules are checked here as well as
   * at checkout. Rejecting a sold-out dish at the moment it is added is far
   * better service than accepting it and failing at the till — and checkout
   * still re-validates, because the menu can change in between.
   */
  async addItem(auth: AuthContext, cartId: string, input: AddCartItemDto) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const cart = await this.loadActiveCart(tx, cartId, auth);

      const menuItem = await tx.menuItem.findUnique({
        where: { id: input.menuItemId },
        include: {
          variants: true,
          modifiers: { include: { modifier: { include: { options: true } } } },
          overrides: { where: { branchId: cart.branchId } },
        },
      });

      if (!menuItem) throw new NotFoundError('Menu item', input.menuItemId);

      const override = menuItem.overrides[0]
        ? {
            price: menuItem.overrides[0].price?.toString() ?? null,
            availability: menuItem.overrides[0].availability,
          }
        : null;

      const orderable = isOrderable(
        {
          availability: menuItem.availability as MenuItemAvailability,
          isActive: menuItem.isActive,
        },
        override,
      );

      if (!orderable) {
        throw new DomainError(
          ErrorCode.MENU_ITEM_UNAVAILABLE,
          `"${menuItem.name}" is not available right now`,
          409,
        );
      }

      if (input.variantId && !menuItem.variants.some((v) => v.id === input.variantId)) {
        throw new NotFoundError('Variant', input.variantId);
      }

      // Options must belong to a group actually attached to this item;
      // otherwise a caller could price a burger with a pizza's toppings.
      const allowedOptionIds = new Set(
        menuItem.modifiers.flatMap((link) => link.modifier.options.map((option) => option.id)),
      );
      const optionIds = [...new Set(input.optionIds ?? [])];

      for (const optionId of optionIds) {
        if (!allowedOptionIds.has(optionId)) {
          throw new ValidationError('One or more selected options are not offered on this item');
        }
      }

      const options = optionIds.length
        ? await tx.modifierOption.findMany({ where: { id: { in: optionIds } } })
        : [];

      const cartItem = await tx.cartItem.create({
        data: {
          tenantId: auth.tenantId,
          cartId,
          menuItemId: input.menuItemId,
          variantId: input.variantId ?? null,
          quantity: input.quantity ?? 1,
          notes: input.notes ?? null,
          modifiers: {
            create: options.map((option) => ({
              tenantId: auth.tenantId,
              modifierId: option.modifierId,
              optionId: option.id,
            })),
          },
        },
      });

      await this.touch(tx, cartId);
      const priced = await this.priceAndPresent(tx, auth, cartId);
      return { ...priced, addedItemId: cartItem.id };
    });
  }

  async updateItem(
    auth: AuthContext,
    cartId: string,
    cartItemId: string,
    input: UpdateCartItemDto,
  ) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      await this.loadActiveCart(tx, cartId, auth);

      const item = await tx.cartItem.findUnique({ where: { id: cartItemId } });
      if (!item || item.cartId !== cartId) throw new NotFoundError('Cart item', cartItemId);

      // Quantity zero means "remove", which is what a stepper control produces
      // when the customer taps minus once too often.
      if (input.quantity === 0) {
        await tx.cartItem.delete({ where: { id: cartItemId } });
      } else {
        await tx.cartItem.update({
          where: { id: cartItemId },
          data: {
            ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
          },
        });
      }

      await this.touch(tx, cartId);
      return this.priceAndPresent(tx, auth, cartId);
    });
  }

  async removeItem(auth: AuthContext, cartId: string, cartItemId: string) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      await this.loadActiveCart(tx, cartId, auth);

      const deleted = await tx.cartItem.deleteMany({ where: { id: cartItemId, cartId } });
      if (deleted.count === 0) throw new NotFoundError('Cart item', cartItemId);

      await this.touch(tx, cartId);
      return this.priceAndPresent(tx, auth, cartId);
    });
  }

  async clear(auth: AuthContext, cartId: string) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      await this.loadActiveCart(tx, cartId, auth);
      await tx.cartItem.deleteMany({ where: { cartId } });
      await this.touch(tx, cartId);
      return this.priceAndPresent(tx, auth, cartId);
    });
  }

  // --- internals ------------------------------------------------------------

  /**
   * Loads a cart that may still be modified.
   *
   * A checked-out cart is kept for support and analytics but must never accept
   * another item — otherwise the cart and the order it became would disagree.
   */
  private async loadActiveCart(tx: TransactionClient, cartId: string, auth: AuthContext) {
    const cart = await tx.cart.findUnique({ where: { id: cartId } });
    if (!cart) throw new NotFoundError('Cart', cartId);

    if (!canAccessBranch(auth, cart.branchId)) {
      throw new BranchAccessDeniedError();
    }

    if (cart.status !== CartStatus.ACTIVE) {
      throw new ConflictError('This cart has already been checked out');
    }

    return cart;
  }

  private async touch(tx: TransactionClient, cartId: string): Promise<void> {
    await tx.cart.update({
      where: { id: cartId },
      data: { expiresAt: new Date(Date.now() + CART_TTL_HOURS * 3_600_000) },
    });
  }

  private assertBranchSupports(
    branch: { deliveryEnabled: boolean; pickupEnabled: boolean; dineInEnabled: boolean; name: string },
    orderType: OrderType,
  ): void {
    const supported =
      (orderType === OrderType.DELIVERY && branch.deliveryEnabled) ||
      (orderType === OrderType.PICKUP && branch.pickupEnabled) ||
      (orderType === OrderType.DINE_IN && branch.dineInEnabled);

    if (!supported) {
      throw new ValidationError(`${branch.name} does not offer ${orderType.toLowerCase()} orders`);
    }
  }

  /**
   * Prices the cart and shapes it for the wire.
   *
   * Every mutating method returns this, so a client always has the current
   * totals without a second round trip — and never has to add anything up.
   */
  private async priceAndPresent(tx: TransactionClient, auth: AuthContext, cartId: string) {
    const cart = await tx.cart.findUniqueOrThrow({ where: { id: cartId } });

    const address = cart.customerId
      ? await tx.customerAddress.findFirst({
          where: { customerId: cart.customerId, isDefault: true },
        })
      : null;

    const deliveryPoint =
      address?.latitude != null && address?.longitude != null
        ? { latitude: Number(address.latitude), longitude: Number(address.longitude) }
        : null;

    const priced = await this.pricing.priceCart(tx, {
      cartId,
      tenantId: auth.tenantId,
      deliveryPoint,
      strict: false,
    });

    return this.presentPricedCart(cart, priced);
  }

  presentPricedCart(
    cart: { id: string; branchId: string; customerId: string | null; source: string; orderType: OrderType; status: string; notes: string | null },
    priced: PricedCart,
  ) {
    return {
      id: cart.id,
      branchId: cart.branchId,
      customerId: cart.customerId,
      source: cart.source,
      orderType: cart.orderType,
      status: cart.status,
      notes: cart.notes,
      currency: priced.currency,
      items: priced.lines.map((line) => ({
        id: line.cartItemId,
        menuItemId: line.menuItemId,
        name: line.itemName,
        variantId: line.variantId,
        variantName: line.variantName,
        quantity: line.quantity,
        notes: line.notes,
        unitPrice: line.unitPrice.toDecimalString(),
        modifiersTotal: line.modifiersTotal.toDecimalString(),
        lineTotal: line.lineTotal.toDecimalString(),
        modifiers: line.modifiers.map((modifier) => ({
          modifierId: modifier.modifierId,
          modifierName: modifier.modifierName,
          optionId: modifier.optionId,
          optionName: modifier.optionName,
          priceDelta: modifier.priceDelta.toDecimalString(),
        })),
      })),
      totals: {
        subtotal: priced.totals.subtotal.toDecimalString(),
        discountAmount: priced.totals.discountAmount.toDecimalString(),
        serviceCharge: priced.totals.serviceCharge.toDecimalString(),
        deliveryFee: priced.totals.deliveryFee.toDecimalString(),
        taxAmount: priced.totals.taxAmount.toDecimalString(),
        total: priced.totals.total.toDecimalString(),
      },
      deliveryZone: priced.zone
        ? { id: priced.zone.zoneId, name: priced.zone.zoneName }
        : null,
      /** Empty means the cart can be checked out. */
      blockers: priced.blockers,
      canCheckout: priced.blockers.length === 0,
    };
  }
}
