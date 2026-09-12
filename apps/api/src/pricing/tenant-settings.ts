import { Money, type PricingRules } from '@restaurant-os/domain';
import { z } from 'zod';

/**
 * Tenant and branch configuration (ENGINEERING_SPEC.md 74).
 *
 * `Organization.settings` and `Branch.settings` are JSON so tenant behaviour is
 * never hard-coded. That flexibility has a cost: the shape is not enforced by
 * the database, and a typo would otherwise surface as `NaN` inside a tax
 * calculation. Everything is parsed defensively here, once, with defaults that
 * are safe rather than convenient — an unreadable tax rate becomes 0, which is
 * visibly wrong on a receipt, rather than a plausible-looking guess.
 */

const money = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/)
  .optional();

/**
 * Every field is individually forgiving.
 *
 * `.catch(undefined)` makes an invalid value fall back to the default for that
 * one field instead of failing the whole object. Without it a single typo —
 * `taxPercent: "15"` instead of `15` — would discard the delivery fee, the
 * minimum order and the acknowledgement timeout along with it, and the
 * restaurant would silently start operating on defaults it never chose.
 */
const settingsSchema = z
  .object({
    taxPercent: z.number().min(0).max(100).optional().catch(undefined),
    serviceChargePercent: z.number().min(0).max(100).optional().catch(undefined),
    taxAppliesToDeliveryFee: z.boolean().optional().catch(undefined),
    deliveryFee: money.catch(undefined),
    minimumOrder: money.catch(undefined),
    freeDeliveryAbove: money.catch(undefined),
    orderAcknowledgementTimeoutSeconds: z
      .number()
      .int()
      .min(10)
      .max(3600)
      .optional()
      .catch(undefined),
  })
  .partial()
  // Unknown keys (the escalation ladder, notification preferences, whatever a
  // later phase adds) pass through untouched rather than failing the parse.
  .passthrough();

export type TenantSettingsInput = z.infer<typeof settingsSchema>;

export interface ResolvedSettings {
  rules: PricingRules;
  defaultDeliveryFee: Money;
  minimumOrder: Money;
  /** Orders above this deliver free. Null when the tenant offers no such deal. */
  freeDeliveryAbove: Money | null;
  acknowledgementTimeoutSeconds: number;
}

/**
 * Merges organization defaults with branch overrides.
 *
 * Branch settings win key by key, so a branch can raise its delivery fee
 * without restating the tax rate.
 */
export function resolveSettings(
  organizationSettings: unknown,
  branchSettings: unknown,
  currency = 'PKR',
): ResolvedSettings {
  const organization = settingsSchema.safeParse(organizationSettings);
  const branch = settingsSchema.safeParse(branchSettings);

  const merged: TenantSettingsInput = {
    ...(organization.success ? organization.data : {}),
    ...(branch.success ? branch.data : {}),
  };

  return {
    rules: {
      taxPercent: merged.taxPercent ?? 0,
      serviceChargePercent: merged.serviceChargePercent ?? 0,
      taxAppliesToDeliveryFee: merged.taxAppliesToDeliveryFee ?? false,
    },
    defaultDeliveryFee: merged.deliveryFee
      ? Money.fromDecimalString(merged.deliveryFee, currency)
      : Money.zero(currency),
    minimumOrder: merged.minimumOrder
      ? Money.fromDecimalString(merged.minimumOrder, currency)
      : Money.zero(currency),
    freeDeliveryAbove: merged.freeDeliveryAbove
      ? Money.fromDecimalString(merged.freeDeliveryAbove, currency)
      : null,
    acknowledgementTimeoutSeconds: merged.orderAcknowledgementTimeoutSeconds ?? 60,
  };
}
