import { Language } from '@restaurant-os/types';
import { z } from 'zod';

export const updateOrganizationSchema = z
  .object({
    name: z.string().min(1).max(200),
    timezone: z.string().min(1).max(64),
    currency: z.string().length(3).toUpperCase(),
    logoUrl: z.string().url().max(2048).nullable(),
    defaultLanguage: z.nativeEnum(Language),
    /** Minutes past midnight at which the business day rolls over (plan 2.6). */
    businessDayStartMinutes: z.number().int().min(0).max(1439),
    /** Tenant configuration (ENGINEERING_SPEC.md 74). */
    settings: z.record(z.unknown()),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });

export type UpdateOrganizationDto = z.infer<typeof updateOrganizationSchema>;
