import { MenuItemAvailability, ModifierSelectionType } from '@restaurant-os/types';
import { describe, expect, it } from 'vitest';
import { ValidationError } from './errors';
import {
  isOrderable,
  isVisibleToCustomer,
  resolveAvailability,
  resolvePrice,
  resolveUnitPrice,
  validateModifierSelection,
  type MenuItemLike,
  type ModifierLike,
} from './menu';

function item(overrides: Partial<MenuItemLike> = {}): MenuItemLike {
  return {
    id: 'item-1',
    basePrice: '700.00',
    currency: 'PKR',
    availability: MenuItemAvailability.AVAILABLE,
    isActive: true,
    ...overrides,
  };
}

function modifier(overrides: Partial<ModifierLike> = {}): ModifierLike {
  return {
    id: 'mod-1',
    name: 'Choose your sauce',
    selectionType: ModifierSelectionType.SINGLE,
    required: false,
    minSelections: 0,
    maxSelections: 1,
    options: [
      { id: 'opt-garlic', name: 'Garlic', priceDelta: '0.00', isAvailable: true },
      { id: 'opt-chilli', name: 'Chilli', priceDelta: '50.00', isAvailable: true },
      { id: 'opt-mint', name: 'Mint', priceDelta: '0.00', isAvailable: false },
    ],
    ...overrides,
  };
}

describe('resolvePrice', () => {
  it('uses the tenant-wide price when there is no override', () => {
    expect(resolvePrice(item()).toDecimalString()).toBe('700.00');
    expect(resolvePrice(item(), null).toDecimalString()).toBe('700.00');
  });

  it('uses the branch price when one is set', () => {
    // A chain charging more in one city.
    const branch = { price: '850.00', availability: null };
    expect(resolvePrice(item(), branch).toDecimalString()).toBe('850.00');
  });

  it('inherits when the override row exists but leaves price NULL', () => {
    const branch = { price: null, availability: MenuItemAvailability.OUT_OF_STOCK };
    expect(resolvePrice(item(), branch).toDecimalString()).toBe('700.00');
  });
});

describe('resolveAvailability', () => {
  it('inherits when there is no override', () => {
    expect(resolveAvailability(item())).toBe(MenuItemAvailability.AVAILABLE);
  });

  it('lets a branch restrict an available item', () => {
    const branch = { price: null, availability: MenuItemAvailability.OUT_OF_STOCK };
    expect(resolveAvailability(item(), branch)).toBe(MenuItemAvailability.OUT_OF_STOCK);
  });

  it('does NOT let a branch loosen a centrally withdrawn item', () => {
    // The property that matters: an item hidden chain-wide — discontinued,
    // recalled — must not become orderable because of a stale branch row.
    const hidden = item({ availability: MenuItemAvailability.HIDDEN });
    const branch = { price: null, availability: MenuItemAvailability.AVAILABLE };
    expect(resolveAvailability(hidden, branch)).toBe(MenuItemAvailability.HIDDEN);
  });

  it('keeps the more restrictive of two non-available states', () => {
    const outOfStock = item({ availability: MenuItemAvailability.OUT_OF_STOCK });
    const branchHidden = { price: null, availability: MenuItemAvailability.HIDDEN };
    expect(resolveAvailability(outOfStock, branchHidden)).toBe(MenuItemAvailability.HIDDEN);

    const hidden = item({ availability: MenuItemAvailability.HIDDEN });
    const branchOut = { price: null, availability: MenuItemAvailability.OUT_OF_STOCK };
    expect(resolveAvailability(hidden, branchOut)).toBe(MenuItemAvailability.HIDDEN);
  });
});

describe('isOrderable and isVisibleToCustomer', () => {
  it('allows an available, active item', () => {
    expect(isOrderable(item())).toBe(true);
    expect(isVisibleToCustomer(item())).toBe(true);
  });

  it('refuses an archived item whatever its availability says', () => {
    const archived = item({ isActive: false, availability: MenuItemAvailability.AVAILABLE });
    expect(isOrderable(archived)).toBe(false);
    expect(isVisibleToCustomer(archived)).toBe(false);
  });

  it('lists a sold-out item but will not accept an order for it', () => {
    const soldOut = item({ availability: MenuItemAvailability.OUT_OF_STOCK });
    expect(isVisibleToCustomer(soldOut)).toBe(true);
    expect(isOrderable(soldOut)).toBe(false);
  });

  it('does not list a hidden item', () => {
    const hidden = item({ availability: MenuItemAvailability.HIDDEN });
    expect(isVisibleToCustomer(hidden)).toBe(false);
    expect(isOrderable(hidden)).toBe(false);
  });

  it('applies the branch override', () => {
    const branch = { price: null, availability: MenuItemAvailability.OUT_OF_STOCK };
    expect(isOrderable(item(), branch)).toBe(false);
    expect(isVisibleToCustomer(item(), branch)).toBe(true);
  });
});

describe('validateModifierSelection', () => {
  it('accepts a valid single choice', () => {
    expect(() => validateModifierSelection(modifier(), ['opt-garlic'])).not.toThrow();
  });

  it('accepts no choice when the group is optional', () => {
    expect(() => validateModifierSelection(modifier(), [])).not.toThrow();
  });

  it('rejects an option that belongs to another group', () => {
    expect(() => validateModifierSelection(modifier(), ['opt-from-elsewhere'])).toThrow(
      ValidationError,
    );
  });

  it('rejects an unavailable option', () => {
    expect(() => validateModifierSelection(modifier(), ['opt-mint'])).toThrow(/not available/);
  });

  it('rejects the same option twice', () => {
    const multi = modifier({
      selectionType: ModifierSelectionType.MULTIPLE,
      maxSelections: 3,
    });
    expect(() => validateModifierSelection(multi, ['opt-garlic', 'opt-garlic'])).toThrow(
      /more than once/,
    );
  });

  it('rejects two choices in a single-selection group', () => {
    expect(() => validateModifierSelection(modifier(), ['opt-garlic', 'opt-chilli'])).toThrow(
      /only one option/,
    );
  });

  it('requires a choice when the group is required', () => {
    const required = modifier({ required: true });
    expect(() => validateModifierSelection(required, [])).toThrow(/at least 1 option/);
    expect(() => validateModifierSelection(required, ['opt-garlic'])).not.toThrow();
  });

  it('treats required as a floor of one even when minSelections is zero', () => {
    // The configuration people produce by accident: "required" ticked, minimum
    // left at its default.
    const required = modifier({ required: true, minSelections: 0 });
    expect(() => validateModifierSelection(required, [])).toThrow(/at least 1/);
  });

  it('enforces minimum and maximum for a multi-selection group', () => {
    const toppings = modifier({
      name: 'Toppings',
      selectionType: ModifierSelectionType.MULTIPLE,
      minSelections: 2,
      maxSelections: 3,
      options: [
        { id: 'a', name: 'A', priceDelta: '0.00', isAvailable: true },
        { id: 'b', name: 'B', priceDelta: '0.00', isAvailable: true },
        { id: 'c', name: 'C', priceDelta: '0.00', isAvailable: true },
        { id: 'd', name: 'D', priceDelta: '0.00', isAvailable: true },
      ],
    });

    expect(() => validateModifierSelection(toppings, ['a'])).toThrow(/at least 2 options/);
    expect(() => validateModifierSelection(toppings, ['a', 'b'])).not.toThrow();
    expect(() => validateModifierSelection(toppings, ['a', 'b', 'c'])).not.toThrow();
    expect(() => validateModifierSelection(toppings, ['a', 'b', 'c', 'd'])).toThrow(
      /at most 3 options/,
    );
  });
});

describe('resolveUnitPrice', () => {
  it('is the base price with no variant or options', () => {
    expect(resolveUnitPrice(item(), null).toDecimalString()).toBe('700.00');
  });

  it('uses the branch price', () => {
    const branch = { price: '850.00', availability: null };
    expect(resolveUnitPrice(item(), branch).toDecimalString()).toBe('850.00');
  });

  it('lets a variant replace the price rather than add to it', () => {
    const large = { id: 'v1', name: 'Large', price: '1100.00' };
    expect(resolveUnitPrice(item(), null, { variant: large }).toDecimalString()).toBe('1100.00');
  });

  it('adds modifier deltas', () => {
    const options = [
      { id: 'opt-chilli', name: 'Chilli', priceDelta: '50.00', isAvailable: true },
      { id: 'opt-cheese', name: 'Extra cheese', priceDelta: '120.00', isAvailable: true },
    ];
    expect(resolveUnitPrice(item(), null, { options }).toDecimalString()).toBe('870.00');
  });

  it('combines a branch price, a variant and modifiers in the right order', () => {
    const branch = { price: '850.00', availability: null };
    const large = { id: 'v1', name: 'Large', price: '1100.00' };
    const options = [{ id: 'o', name: 'Extra cheese', priceDelta: '120.00', isAvailable: true }];

    // The variant replaces the branch price, then the modifier is added.
    expect(resolveUnitPrice(item(), branch, { variant: large, options }).toDecimalString()).toBe(
      '1220.00',
    );
  });

  it('accepts a negative delta but never returns a negative price', () => {
    const options = [{ id: 'o', name: 'No drink', priceDelta: '-900.00', isAvailable: true }];
    expect(resolveUnitPrice(item(), null, { options }).toDecimalString()).toBe('0.00');
  });
});
