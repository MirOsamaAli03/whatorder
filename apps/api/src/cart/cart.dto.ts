import { OrderSource, OrderType } from '@restaurant-os/types';
import { z } from 'zod';

export const createCartSchema = z.object({
  branchId: z.string().uuid(),
  source: z.nativeEnum(OrderSource),
  orderType: z.nativeEnum(OrderType),
  customerId: z.string().uuid().optional(),
  notes: z.string().max(2000).optional(),
});
export type CreateCartDto = z.infer<typeof createCartSchema>;

export const updateCartSchema = z
  .object({
    orderType: z.nativeEnum(OrderType),
    customerId: z.string().uuid().nullable(),
    notes: z.string().max(2000).nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateCartDto = z.infer<typeof updateCartSchema>;

export const addCartItemSchema = z.object({
  menuItemId: z.string().uuid(),
  variantId: z.string().uuid().optional(),
  quantity: z.number().int().min(1).max(999).optional(),
  /**
   * Chosen modifier options. The service checks each one belongs to a group
   * attached to this item, so a caller cannot price a burger with a pizza's
   * toppings.
   */
  optionIds: z.array(z.string().uuid()).max(50).optional(),
  notes: z.string().max(500).optional(),
});
export type AddCartItemDto = z.infer<typeof addCartItemSchema>;

export const updateCartItemSchema = z
  .object({
    /** Zero removes the line, which is what a stepper control sends. */
    quantity: z.number().int().min(0).max(999),
    notes: z.string().max(500).nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateCartItemDto = z.infer<typeof updateCartItemSchema>;
