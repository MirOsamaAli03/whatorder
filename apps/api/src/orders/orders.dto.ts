import { OrderSource, OrderStatus, OrderType, PaymentMethod } from '@restaurant-os/types';
import { z } from 'zod';

/**
 * Order request schemas (ENGINEERING_SPEC.md 60, 61.3).
 *
 * Note what is absent: no prices, no totals, no tax. A client says which cart,
 * who it is for and how they will pay; every figure is computed server-side
 * (invariant 3). Zod strips unknown keys, so a `total` field in the body is
 * discarded rather than considered.
 */

export const checkoutSchema = z.object({
  cartId: z.string().uuid(),

  customerPhone: z.string().min(6).max(32),
  customerName: z.string().min(1).max(200).optional(),

  paymentMethod: z.nativeEnum(PaymentMethod),

  /** A saved address; preferred, because it carries coordinates. */
  addressId: z.string().uuid().optional(),
  /** An inline address, for a customer who has not saved one yet. */
  deliveryAddress: z.string().min(1).max(1000).optional(),
  deliveryLatitude: z.number().min(-90).max(90).optional(),
  deliveryLongitude: z.number().min(-180).max(180).optional(),

  /** Dine-in table identifier, until the tables module arrives in Phase 10. */
  tableLabel: z.string().max(64).optional(),

  notes: z.string().max(2000).optional(),
});
export type CheckoutDto = z.infer<typeof checkoutSchema>;

/**
 * A status change. The state machine decides whether it is legal; this only
 * checks that the value is a real status.
 */
export const transitionOrderSchema = z.object({
  status: z.nativeEnum(OrderStatus),
  /** Required for CANCELLED and REJECTED — enforced in the service. */
  reason: z.string().min(1).max(500).optional(),
});
export type TransitionOrderDto = z.infer<typeof transitionOrderSchema>;

export const cancelOrderSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type CancelOrderDto = z.infer<typeof cancelOrderSchema>;

/** Accepts `?status=READY&status=PREPARING` or a single value. */
const statusFilter = z
  .union([z.nativeEnum(OrderStatus), z.array(z.nativeEnum(OrderStatus))])
  .transform((value) => (Array.isArray(value) ? value : [value]));

export const listOrdersSchema = z.object({
  branchId: z.string().uuid().optional(),
  status: statusFilter.optional(),
  source: z.nativeEnum(OrderSource).optional(),
  orderType: z.nativeEnum(OrderType).optional(),
  customerId: z.string().uuid().optional(),
  /**
   * Trading day, YYYY-MM-DD. Not a created_at range: a restaurant's "today"
   * ends when it closes, not at midnight UTC (plan 2.6).
   */
  businessDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Business date must be YYYY-MM-DD')
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
export type ListOrdersDto = z.infer<typeof listOrdersSchema>;
