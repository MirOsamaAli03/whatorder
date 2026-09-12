import { z } from 'zod';

/**
 * Request schemas for the auth endpoints (ENGINEERING_SPEC.md 60, 61.3).
 *
 * Zod strips unknown keys, so a client cannot smuggle extra fields such as
 * `tenantId`, `roles` or `isPlatformAdmin` into a handler.
 */

export const loginSchema = z.object({
  email: z.string().email('A valid email address is required').max(320),
  // Only a floor is enforced at login; strength rules belong at registration,
  // and rejecting an existing password for being short would lock people out.
  password: z.string().min(1, 'Password is required').max(200),
  /** Required only when the account belongs to more than one organization. */
  organizationSlug: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'Organization slug is invalid')
    .max(100)
    .optional(),
});
export type LoginDto = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  /** Optional in the body: the refresh cookie is the primary transport. */
  refreshToken: z.string().min(1).optional(),
});
export type RefreshDto = z.infer<typeof refreshSchema>;
