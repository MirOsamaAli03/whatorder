import { Language } from '@restaurant-os/types';
import { z } from 'zod';

/**
 * Phone numbers are accepted in any shape a person might type and normalised
 * to E.164 in the service — see common/phone.ts for why that matters.
 */
const phone = z.string().min(6).max(32);

export const createCustomerSchema = z.object({
  phone,
  name: z.string().min(1).max(200).optional(),
  whatsappNumber: phone.optional(),
  email: z.string().email().max(320).optional(),
  preferredLanguage: z.nativeEnum(Language).optional(),
  notes: z.string().max(2000).optional(),
});
export type CreateCustomerDto = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = z
  .object({
    phone,
    name: z.string().min(1).max(200).nullable(),
    whatsappNumber: phone.nullable(),
    email: z.string().email().max(320).nullable(),
    preferredLanguage: z.nativeEnum(Language),
    notes: z.string().max(2000).nullable(),
    isBlocked: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateCustomerDto = z.infer<typeof updateCustomerSchema>;

export const listCustomersSchema = z.object({
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
export type ListCustomersDto = z.infer<typeof listCustomersSchema>;

export const createAddressSchema = z.object({
  address: z.string().min(1).max(1000),
  label: z.string().max(64).optional(),
  city: z.string().max(100).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  notes: z.string().max(500).optional(),
  isDefault: z.boolean().optional(),
});
export type CreateAddressDto = z.infer<typeof createAddressSchema>;

export const updateAddressSchema = createAddressSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'At least one field must be provided' },
);
export type UpdateAddressDto = z.infer<typeof updateAddressSchema>;
