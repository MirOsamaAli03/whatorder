import { MenuItemAvailability, ModifierSelectionType } from '@restaurant-os/types';
import { z } from 'zod';

/**
 * Menu request schemas (ENGINEERING_SPEC.md 10, 61.3).
 *
 * Prices arrive as decimal STRINGS, never numbers. A JSON number is a float,
 * and `700.10` does not survive the round trip exactly; a string is parsed into
 * integer paisa by `Money.fromDecimalString` with no float in the path
 * (plan 2.6). The regex rejects anything that is not a plain decimal, so
 * "1,250.00" or "Rs 700" fail validation rather than silently becoming NaN.
 */
const decimalAmount = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, 'Amount must be a decimal with at most 2 places, e.g. "700.00"');

/** Modifier deltas may be negative — "no drink" can reduce a combo price. */
const signedDecimalAmount = z
  .string()
  .regex(/^-?\d+(\.\d{1,2})?$/, 'Amount must be a decimal with at most 2 places');

/** Localized names keyed by language code, e.g. { "UR": "..." } (plan 2.3). */
const localizedName = z.record(z.enum(['EN', 'UR', 'UR_ROMAN']), z.string().max(200));

// --- categories -------------------------------------------------------------

export const createCategorySchema = z.object({
  name: z.string().min(1).max(200),
  nameLocalized: localizedName.optional(),
  description: z.string().max(2000).optional(),
  imageUrl: z.string().url().max(2048).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});
export type CreateCategoryDto = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = createCategorySchema
  .extend({ isActive: z.boolean() })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateCategoryDto = z.infer<typeof updateCategorySchema>;

// --- items ------------------------------------------------------------------

export const createItemSchema = z.object({
  name: z.string().min(1).max(200),
  nameLocalized: localizedName.optional(),
  categoryId: z.string().uuid().nullable().optional(),
  description: z.string().max(2000).optional(),
  imageUrl: z.string().url().max(2048).optional(),
  basePrice: decimalAmount,
  costPrice: decimalAmount.nullable().optional(),
  preparationTimeMinutes: z.number().int().min(0).max(600).optional(),
  availability: z.nativeEnum(MenuItemAvailability).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});
export type CreateItemDto = z.infer<typeof createItemSchema>;

export const updateItemSchema = createItemSchema
  .extend({ isActive: z.boolean() })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateItemDto = z.infer<typeof updateItemSchema>;

/**
 * Availability change. With `branchId` it writes a branch override; without
 * one it changes the tenant-wide value for every branch at once.
 */
export const setAvailabilitySchema = z.object({
  availability: z.nativeEnum(MenuItemAvailability),
  branchId: z.string().uuid().optional(),
});
export type SetAvailabilityDto = z.infer<typeof setAvailabilitySchema>;

/** Per-branch price and availability. Null clears a field back to inherited. */
export const setBranchOverrideSchema = z
  .object({
    price: decimalAmount.nullable().optional(),
    availability: z.nativeEnum(MenuItemAvailability).nullable().optional(),
  })
  .refine((value) => value.price !== undefined || value.availability !== undefined, {
    message: 'Provide a price, an availability, or both',
  });
export type SetBranchOverrideDto = z.infer<typeof setBranchOverrideSchema>;

// --- variants ---------------------------------------------------------------

export const createVariantSchema = z.object({
  name: z.string().min(1).max(120),
  /** Replaces the item price outright rather than adding a surcharge. */
  price: decimalAmount,
  isDefault: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});
export type CreateVariantDto = z.infer<typeof createVariantSchema>;

export const updateVariantSchema = createVariantSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'At least one field must be provided' },
);
export type UpdateVariantDto = z.infer<typeof updateVariantSchema>;

// --- modifiers --------------------------------------------------------------

export const createModifierSchema = z
  .object({
    name: z.string().min(1).max(200),
    selectionType: z.nativeEnum(ModifierSelectionType).optional(),
    required: z.boolean().optional(),
    minSelections: z.number().int().min(0).max(50).optional(),
    maxSelections: z.number().int().min(1).max(50).optional(),
    options: z
      .array(
        z.object({
          name: z.string().min(1).max(200),
          priceDelta: signedDecimalAmount.optional(),
          isDefault: z.boolean().optional(),
          sortOrder: z.number().int().min(0).max(10_000).optional(),
        }),
      )
      .max(50)
      .optional(),
  })
  .refine(
    (value) =>
      value.minSelections === undefined ||
      value.maxSelections === undefined ||
      value.minSelections <= value.maxSelections,
    { message: 'minSelections cannot exceed maxSelections', path: ['minSelections'] },
  )
  .refine(
    (value) =>
      value.selectionType !== ModifierSelectionType.SINGLE ||
      value.maxSelections === undefined ||
      value.maxSelections === 1,
    {
      // Otherwise the group's own configuration contradicts itself and
      // validateModifierSelection would reject every plausible choice.
      message: 'A SINGLE selection group cannot allow more than one choice',
      path: ['maxSelections'],
    },
  );
export type CreateModifierDto = z.infer<typeof createModifierSchema>;

export const updateModifierSchema = z
  .object({
    name: z.string().min(1).max(200),
    selectionType: z.nativeEnum(ModifierSelectionType),
    required: z.boolean(),
    minSelections: z.number().int().min(0).max(50),
    maxSelections: z.number().int().min(1).max(50),
    isActive: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateModifierDto = z.infer<typeof updateModifierSchema>;

export const createOptionSchema = z.object({
  name: z.string().min(1).max(200),
  priceDelta: signedDecimalAmount.optional(),
  isDefault: z.boolean().optional(),
  isAvailable: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});
export type CreateOptionDto = z.infer<typeof createOptionSchema>;

export const updateOptionSchema = createOptionSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'At least one field must be provided' },
);
export type UpdateOptionDto = z.infer<typeof updateOptionSchema>;

/** Replaces the full set of modifier groups attached to an item. */
export const setItemModifiersSchema = z.object({
  modifierIds: z.array(z.string().uuid()).max(50),
});
export type SetItemModifiersDto = z.infer<typeof setItemModifiersSchema>;

// --- reads ------------------------------------------------------------------

export const menuQuerySchema = z.object({
  /** Resolves prices and availability for this branch. */
  branchId: z.string().uuid().optional(),
  /** Include archived and hidden entries. Staff screens only. */
  includeHidden: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .optional(),
});
export type MenuQueryDto = z.infer<typeof menuQuerySchema>;
