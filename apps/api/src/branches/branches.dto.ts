import { BranchStatus, OrderType } from '@restaurant-os/types';
import { z } from 'zod';

/**
 * Per-weekday opening hours, interpreted in the organization's timezone.
 * Example: { "mon": [{ "open": "11:00", "close": "23:30" }] }
 */
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM');

const openingHoursSchema = z.record(
  z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
  z.array(z.object({ open: timeOfDay, close: timeOfDay })),
);

export const createBranchSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, 'Slug may contain lowercase letters, digits and hyphens only'),
  address: z.string().max(1000).optional(),
  city: z.string().max(100).optional(),
  phone: z.string().max(32).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  openingHours: openingHoursSchema.optional(),
  deliveryEnabled: z.boolean().optional(),
  pickupEnabled: z.boolean().optional(),
  dineInEnabled: z.boolean().optional(),
  reservationsEnabled: z.boolean().optional(),
});
export type CreateBranchDto = z.infer<typeof createBranchSchema>;

export const updateBranchSchema = createBranchSchema
  .extend({ status: z.nativeEnum(BranchStatus) })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateBranchDto = z.infer<typeof updateBranchSchema>;

/**
 * Branch selection query (ENGINEERING_SPEC.md 29).
 *
 * Coordinates are required for delivery: without them there is no way to tell
 * which zone covers the customer, and guessing the nearest branch by name is
 * how orders end up at the wrong kitchen.
 */
export const eligibleBranchesSchema = z
  .object({
    orderType: z.nativeEnum(OrderType),
    latitude: z.coerce.number().min(-90).max(90).optional(),
    longitude: z.coerce.number().min(-180).max(180).optional(),
  })
  .refine(
    (value) =>
      value.orderType !== OrderType.DELIVERY ||
      (value.latitude !== undefined && value.longitude !== undefined),
    { message: 'Coordinates are required to find a branch for delivery', path: ['latitude'] },
  );
export type EligibleBranchesDto = z.infer<typeof eligibleBranchesSchema>;
