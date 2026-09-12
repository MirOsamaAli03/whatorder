import { MenuItemAvailability, ModifierSelectionType } from '@restaurant-os/types';
import { ValidationError } from './errors';
import { Money } from './money';

/**
 * Menu resolution (ENGINEERING_SPEC.md 10, 26, 27).
 *
 * Pure functions over plain shapes — no Prisma types, no framework — so the
 * same rules apply identically wherever a menu is read: the dashboard, the
 * POS, the WhatsApp adapter, QR ordering and the AI tool layer. This is the
 * mechanism behind spec 87: there is one implementation of "what does this item
 * cost here, and can it be ordered", not one per channel.
 */

export interface MenuItemLike {
  id: string;
  basePrice: string;
  currency: string;
  availability: MenuItemAvailability;
  isActive: boolean;
}

export interface BranchOverrideLike {
  /** NULL means "inherit the item's price". */
  price: string | null;
  /** NULL means "inherit the item's availability". */
  availability: MenuItemAvailability | null;
}

export interface VariantLike {
  id: string;
  name: string;
  price: string;
}

export interface ModifierOptionLike {
  id: string;
  name: string;
  priceDelta: string;
  isAvailable: boolean;
}

export interface ModifierLike {
  id: string;
  name: string;
  selectionType: ModifierSelectionType;
  required: boolean;
  minSelections: number;
  maxSelections: number;
  options: ModifierOptionLike[];
}

/**
 * How restrictive each state is. Used to combine a tenant-wide setting with a
 * branch override.
 */
const RESTRICTIVENESS: Record<MenuItemAvailability, number> = {
  [MenuItemAvailability.AVAILABLE]: 0,
  [MenuItemAvailability.OUT_OF_STOCK]: 1,
  [MenuItemAvailability.HIDDEN]: 2,
};

/**
 * Combines the tenant-wide availability with a branch override.
 *
 * The MORE RESTRICTIVE of the two wins, rather than the override simply
 * replacing the item's value. An item withdrawn centrally — discontinued,
 * recalled, out of season — must not become orderable again because one branch
 * has a stale override. Restricting is always safe; loosening is not.
 *
 * The cost is that a branch cannot pilot an item that is hidden chain-wide.
 * That case is served by leaving the item AVAILABLE and marking it HIDDEN at
 * every branch except the pilot.
 */
export function resolveAvailability(
  item: Pick<MenuItemLike, 'availability'>,
  override?: Pick<BranchOverrideLike, 'availability'> | null,
): MenuItemAvailability {
  const branchValue = override?.availability;
  if (!branchValue) {
    return item.availability;
  }
  return RESTRICTIVENESS[branchValue] > RESTRICTIVENESS[item.availability]
    ? branchValue
    : item.availability;
}

/** The branch price when set, otherwise the tenant-wide base price. */
export function resolvePrice(
  item: Pick<MenuItemLike, 'basePrice' | 'currency'>,
  override?: Pick<BranchOverrideLike, 'price'> | null,
): Money {
  const value = override?.price ?? item.basePrice;
  return Money.fromDecimalString(value, item.currency);
}

/**
 * Whether a customer may add this item to a cart at this branch.
 *
 * Archived items are never orderable regardless of availability: `isActive` is
 * the administrative state and outranks the customer-facing one.
 */
export function isOrderable(
  item: Pick<MenuItemLike, 'availability' | 'isActive'>,
  override?: Pick<BranchOverrideLike, 'availability'> | null,
): boolean {
  if (!item.isActive) return false;
  return resolveAvailability(item, override) === MenuItemAvailability.AVAILABLE;
}

/** Whether the item should appear in a customer-facing menu listing. */
export function isVisibleToCustomer(
  item: Pick<MenuItemLike, 'availability' | 'isActive'>,
  override?: Pick<BranchOverrideLike, 'availability'> | null,
): boolean {
  if (!item.isActive) return false;
  // OUT_OF_STOCK stays listed, visibly sold out. HIDDEN does not appear.
  return resolveAvailability(item, override) !== MenuItemAvailability.HIDDEN;
}

/**
 * Validates a customer's choices against one modifier group.
 *
 * Runs server-side on every channel. ENGINEERING_SPEC.md 24 is explicit that
 * AI-produced selections are untrusted input like any other: the model may
 * propose, but this function decides.
 */
export function validateModifierSelection(
  modifier: ModifierLike,
  selectedOptionIds: readonly string[],
): void {
  const unique = new Set(selectedOptionIds);
  if (unique.size !== selectedOptionIds.length) {
    throw new ValidationError(`"${modifier.name}": the same option was selected more than once`);
  }

  const optionsById = new Map(modifier.options.map((option) => [option.id, option]));

  for (const optionId of unique) {
    const option = optionsById.get(optionId);
    if (!option) {
      throw new ValidationError(`"${modifier.name}": unknown option selected`);
    }
    if (!option.isAvailable) {
      throw new ValidationError(`"${modifier.name}": "${option.name}" is not available`);
    }
  }

  const count = unique.size;

  if (modifier.selectionType === ModifierSelectionType.SINGLE && count > 1) {
    throw new ValidationError(`"${modifier.name}": only one option may be selected`);
  }

  // `required` sets a floor of one even when minSelections was left at zero,
  // which is the configuration most people produce by accident.
  const minimum = modifier.required ? Math.max(1, modifier.minSelections) : modifier.minSelections;

  if (count < minimum) {
    throw new ValidationError(
      `"${modifier.name}": choose at least ${minimum} option${minimum === 1 ? '' : 's'}`,
    );
  }

  if (modifier.maxSelections > 0 && count > modifier.maxSelections) {
    throw new ValidationError(
      `"${modifier.name}": choose at most ${modifier.maxSelections} option${
        modifier.maxSelections === 1 ? '' : 's'
      }`,
    );
  }
}

export interface ConfiguredItemSelection {
  /** Chosen variant, when the item has variants. */
  variant?: VariantLike | null;
  /** Chosen options across all of the item's modifier groups. */
  options?: readonly ModifierOptionLike[];
}

/**
 * The unit price of one configured item, before quantity, discounts and tax.
 *
 * A variant REPLACES the base price rather than adding to it — a "Large" is
 * priced outright, not as a surcharge — because partial surcharge pricing makes
 * every price change a two-place edit and drifts. Modifier deltas are then
 * added, and may be negative.
 *
 * Invariant 3: this is the only place a unit price is computed, and it never
 * reads a number supplied by a client.
 */
export function resolveUnitPrice(
  item: MenuItemLike,
  override: BranchOverrideLike | null | undefined,
  selection: ConfiguredItemSelection = {},
): Money {
  const base = selection.variant
    ? Money.fromDecimalString(selection.variant.price, item.currency)
    : resolvePrice(item, override);

  const deltas = (selection.options ?? []).map((option) =>
    Money.fromDecimalString(option.priceDelta, item.currency),
  );

  // Clamped: a stack of negative modifiers must never produce a negative line.
  return deltas.reduce<Money>((total, delta) => total.add(delta), base).clampToZero();
}
