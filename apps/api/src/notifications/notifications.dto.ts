import {
  ConsentStatus,
  Language,
  NotificationChannel,
  NotificationStatus,
  RecipientType,
  WhatsAppTemplateCategory,
  WhatsAppTemplateStatus,
} from '@restaurant-os/types';
import { z } from 'zod';

const phone = z.string().min(6).max(32);

export const listNotificationsSchema = z.object({
  status: z.nativeEnum(NotificationStatus).optional(),
  channel: z.nativeEnum(NotificationChannel).optional(),
  branchId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
export type ListNotificationsDto = z.infer<typeof listNotificationsSchema>;

/**
 * Preferences arrive as a whole set rather than one at a time.
 *
 * A settings screen shows a grid of channels against recipients and saves it as
 * a unit; sending partial updates would let two tabs interleave into a state
 * neither of them chose.
 */
export const updatePreferencesSchema = z.object({
  preferences: z
    .array(
      z.object({
        recipientType: z.nativeEnum(RecipientType),
        channel: z.nativeEnum(NotificationChannel),
        enabled: z.boolean(),
      }),
    )
    .min(1)
    .max(20),
});
export type UpdatePreferencesDto = z.infer<typeof updatePreferencesSchema>;

export const createWhatsAppAccountSchema = z.object({
  /** The provider's id for the number; also the inbound webhook's routing key. */
  phoneNumberId: z.string().min(1).max(64),
  displayNumber: phone,
  wabaId: z.string().max(64).optional(),
  branchId: z.string().uuid().optional(),
  provider: z.string().min(1).max(32).default('log'),
  /** Provider credentials. Write-only — never returned by any read endpoint. */
  credentials: z.record(z.unknown()).optional(),
});
export type CreateWhatsAppAccountDto = z.infer<typeof createWhatsAppAccountSchema>;

export const updateWhatsAppAccountSchema = z
  .object({
    displayNumber: phone,
    wabaId: z.string().max(64).nullable(),
    branchId: z.string().uuid().nullable(),
    provider: z.string().min(1).max(32),
    credentials: z.record(z.unknown()),
    isActive: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateWhatsAppAccountDto = z.infer<typeof updateWhatsAppAccountSchema>;

export const createWhatsAppTemplateSchema = z.object({
  accountId: z.string().uuid(),
  templateKey: z.string().min(1).max(64),
  providerName: z.string().min(1).max(128),
  language: z.nativeEnum(Language).default(Language.EN),
  category: z.nativeEnum(WhatsAppTemplateCategory),
  body: z.string().min(1).max(4000),
});
export type CreateWhatsAppTemplateDto = z.infer<typeof createWhatsAppTemplateSchema>;

/**
 * Approval state is recorded, not decided here.
 *
 * Meta approves or rejects a template asynchronously, so this endpoint exists
 * to write down what the provider said — including a rejection reason, which is
 * the thing a restaurant needs to see when their customers stop hearing from
 * them (plan §2.2).
 */
export const updateWhatsAppTemplateSchema = z
  .object({
    status: z.nativeEnum(WhatsAppTemplateStatus),
    rejectionReason: z.string().max(2000).nullable(),
    providerName: z.string().min(1).max(128),
    body: z.string().min(1).max(4000),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateWhatsAppTemplateDto = z.infer<typeof updateWhatsAppTemplateSchema>;

export const recordConsentSchema = z.object({
  channel: z.nativeEnum(NotificationChannel).default(NotificationChannel.WHATSAPP),
  purpose: z.string().min(1).max(32).default('MARKETING'),
  status: z.nativeEnum(ConsentStatus),
  /** How it was obtained: WHATSAPP_REPLY, WEB_FORM, POS, IMPORT. */
  source: z.string().min(1).max(32),
  /** What the customer actually said or did. The part that matters if it is
   *  ever challenged. */
  evidence: z.string().max(2000).optional(),
});
export type RecordConsentDto = z.infer<typeof recordConsentSchema>;
