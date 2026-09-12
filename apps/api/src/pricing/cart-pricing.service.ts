import { Injectable } from '@nestjs/common';
import type { TransactionClient } from '@restaurant-os/database';
import {
  DomainError,
  Money,
  ValidationError,
  computeOrderTotals,
  isOrderable,
  resolveUnitPrice,
  validateModifierSelection,
  type ModifierLike,
  type OrderTotals,
} from '@restaurant-os/domain';
import { ErrorCode, MenuItemAvailability, OrderType } from '@restaurant-os/types';
import { DeliveryZoneService, type Coordinates, type ZoneMatch } from './delivery-zone.service';
import { resolveSettings, type ResolvedSettings } from './tenant-settings';

export interface PricedCartLine {
  cartItemId: string;
  menuItemId: string;
  itemName: string;
  variantId: string | null;
  variantName: string | null;
  quantity: number;
  notes: string | null;
  /** Base price for one unit, variant applied, before modifiers. */
  unitPrice: Money;
  /** Sum of chosen modifier deltas, for one unit. */
  modifiersTotal: Money;
  lineTotal: Money;
  costPrice: Money | null;
  modifiers: Array<{
    modifierId: string;
    modifierName: string;
    optionId: string;
    optionName: string;
    priceDelta: Money;
  }>;
}

export interface PricedCart {
  cartId: string;
  branchId: string;
  orderType: OrderType;
  currency: string;
  lines: PricedCartLine[];
  totals: OrderTotals;
  settings: ResolvedSettings;
  zone: ZoneMatch | null;
  /** Reasons the cart cannot be checked out yet. Empty means it can. */
  blockers: string[];
}

/**
 * Turns a cart into money (ENGINEERING_SPEC.md 27, 28; invariant 3).
 *
 * This is the ONLY place a cart is priced. The cart preview endpoint and
 * checkout both call it, so what the customer was shown and what they are
 * charged cannot drift — and no client-supplied total is read anywhere.
 *
 * Prices are resolved from the menu on every call rather than stored on the
 * cart. A cart left open while the kitchen changes a price then reprices, which
 * is correct: the customer is shown the new price before they commit. The
 * snapshot is taken exactly once, at checkout (spec 13).
 */
@Injectable()
export class CartPricingService {
  constructor(private readonly deliveryZones: DeliveryZoneService) {}

  /**
   * @param strict when true (checkout), an unavailable item throws. When false
   *   (preview), it is reported in `blockers` so the customer can see what to
   *   remove instead of being handed an error page.
   */
  async priceCart(
    tx: TransactionClient,
    input: {
      cartId: string;
      tenantId: string;
      deliveryPoint?: Coordinates | null;
      discount?: Money;
      strict?: boolean;
    },
  ): Promise<PricedCart> {
    const cart = await tx.cart.findUnique({
      where: { id: input.cartId },
      include: {
        items: {
          orderBy: { createdAt: 'asc' },
          include: { modifiers: true },
        },
      },
    });

    if (!cart) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'Cart was not found', 404);
    }

    const [organization, branch] = await Promise.all([
      tx.organization.findUniqueOrThrow({
        where: { id: input.tenantId },
        select: { currency: true, settings: true },
      }),
      tx.branch.findUniqueOrThrow({
        where: { id: cart.branchId },
        select: { id: true, settings: true, status: true, name: true },
      }),
    ]);

    const currency = organization.currency;
    const settings = resolveSettings(organization.settings, branch.settings, currency);
    const blockers: string[] = [];

    const menuItemIds = [...new Set(cart.items.map((item) => item.menuItemId))];

    const menuItems = await tx.menuItem.findMany({
      where: { id: { in: menuItemIds } },
      include: {
        variants: true,
        modifiers: {
          include: { modifier: { include: { options: true } } },
        },
        overrides: { where: { branchId: cart.branchId } },
      },
    });

    const menuItemById = new Map(menuItems.map((item) => [item.id, item]));
    const lines: PricedCartLine[] = [];

    for (const cartItem of cart.items) {
      const menuItem = menuItemById.get(cartItem.menuItemId);

      if (!menuItem) {
        // Archived or deleted between adding and pricing.
        const message = 'An item in this cart is no longer on the menu';
        if (input.strict) {
          throw new DomainError(ErrorCode.MENU_ITEM_UNAVAILABLE, message, 409);
        }
        blockers.push(message);
        continue;
      }

      const override = menuItem.overrides[0]
        ? {
            price: menuItem.overrides[0].price?.toString() ?? null,
            availability: menuItem.overrides[0].availability,
          }
        : null;

      const itemLike = {
        id: menuItem.id,
        basePrice: menuItem.basePrice.toString(),
        currency: menuItem.currency,
        availability: menuItem.availability as MenuItemAvailability,
        isActive: menuItem.isActive,
      };

      if (!isOrderable(itemLike, override)) {
        const message = `"${menuItem.name}" is not available at ${branch.name}`;
        if (input.strict) {
          throw new DomainError(ErrorCode.MENU_ITEM_UNAVAILABLE, message, 409);
        }
        blockers.push(message);
        continue;
      }

      const variant = cartItem.variantId
        ? menuItem.variants.find((candidate) => candidate.id === cartItem.variantId)
        : null;

      if (cartItem.variantId && !variant) {
        const message = `The selected size for "${menuItem.name}" is no longer offered`;
        if (input.strict) {
          throw new DomainError(ErrorCode.MENU_ITEM_UNAVAILABLE, message, 409);
        }
        blockers.push(message);
        continue;
      }

      // Resolve the chosen options, and check each group's rules. Doing this on
      // every pricing pass means a modifier that sells out invalidates the cart
      // before checkout rather than at the till.
      const chosenByModifier = new Map<string, string[]>();
      for (const chosen of cartItem.modifiers) {
        const list = chosenByModifier.get(chosen.modifierId) ?? [];
        list.push(chosen.optionId);
        chosenByModifier.set(chosen.modifierId, list);
      }

      const selectedOptions: PricedCartLine['modifiers'] = [];
      let modifierError: string | null = null;

      for (const link of menuItem.modifiers) {
        const group = link.modifier;
        if (!group.isActive) continue;

        const chosenIds = chosenByModifier.get(group.id) ?? [];

        const groupLike: ModifierLike = {
          id: group.id,
          name: group.name,
          selectionType: group.selectionType,
          required: group.required,
          minSelections: group.minSelections,
          maxSelections: group.maxSelections,
          options: group.options.map((option) => ({
            id: option.id,
            name: option.name,
            priceDelta: option.priceDelta.toString(),
            isAvailable: option.isAvailable,
          })),
        };

        try {
          validateModifierSelection(groupLike, chosenIds);
        } catch (error) {
          modifierError =
            error instanceof ValidationError
              ? error.message
              : `"${menuItem.name}": invalid options selected`;
          break;
        }

        for (const optionId of chosenIds) {
          const option = group.options.find((candidate) => candidate.id === optionId)!;
          selectedOptions.push({
            modifierId: group.id,
            modifierName: group.name,
            optionId: option.id,
            optionName: option.name,
            priceDelta: Money.fromDecimalString(option.priceDelta.toString(), currency),
          });
        }
      }

      if (modifierError) {
        if (input.strict) {
          throw new ValidationError(modifierError);
        }
        blockers.push(modifierError);
        continue;
      }

      const unitPrice = resolveUnitPrice(
        itemLike,
        override,
        variant
          ? { variant: { id: variant.id, name: variant.name, price: variant.price.toString() } }
          : {},
      );

      const modifiersTotal = Money.sum(
        selectedOptions.map((option) => option.priceDelta),
        currency,
      );

      lines.push({
        cartItemId: cartItem.id,
        menuItemId: menuItem.id,
        itemName: menuItem.name,
        variantId: variant?.id ?? null,
        variantName: variant?.name ?? null,
        quantity: cartItem.quantity,
        notes: cartItem.notes,
        unitPrice,
        modifiersTotal,
        lineTotal: unitPrice.add(modifiersTotal).multiply(cartItem.quantity),
        costPrice: menuItem.costPrice
          ? Money.fromDecimalString(menuItem.costPrice.toString(), currency)
          : null,
        modifiers: selectedOptions,
      });
    }

    // The subtotal has to be known before the delivery fee, because a
    // free-delivery threshold is measured against it.
    const discountedSubtotal = Money.sum(
      lines.map((line) => line.lineTotal),
      currency,
    ).subtract(input.discount ?? Money.zero(currency)).clampToZero();

    const zone =
      cart.orderType === OrderType.DELIVERY && input.deliveryPoint
        ? await this.deliveryZones.findZoneForPoint(
            tx,
            cart.branchId,
            input.deliveryPoint,
            currency,
          )
        : null;

    const deliveryFee = this.deliveryZones.resolveDeliveryFee({
      orderType: cart.orderType,
      zone,
      defaultFee: settings.defaultDeliveryFee,
      freeDeliveryAbove: settings.freeDeliveryAbove,
      discountedSubtotal,
    });

    const totals = computeOrderTotals({
      lines: lines.map((line) => ({
        unitPrice: line.unitPrice.add(line.modifiersTotal),
        quantity: line.quantity,
      })),
      rules: settings.rules,
      discount: input.discount,
      deliveryFee,
      currency,
    });

    if (lines.length === 0) {
      blockers.push('The cart is empty');
    }

    // A zone minimum overrides the tenant default: it exists because delivering
    // that far is only worth it above a certain basket size.
    const minimumOrder = zone?.minimumOrder ?? settings.minimumOrder;
    if (
      cart.orderType === OrderType.DELIVERY &&
      minimumOrder.isPositive() &&
      totals.subtotal.lessThan(minimumOrder)
    ) {
      blockers.push(
        `Minimum order for delivery is ${currency} ${minimumOrder.toDecimalString()}`,
      );
    }

    if (cart.orderType === OrderType.DELIVERY && !zone && input.deliveryPoint) {
      blockers.push(`${branch.name} does not deliver to that address`);
    }

    return {
      cartId: cart.id,
      branchId: cart.branchId,
      orderType: cart.orderType,
      currency,
      lines,
      totals,
      settings,
      zone,
      blockers,
    };
  }
}
