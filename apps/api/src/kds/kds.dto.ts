import { z } from 'zod';

/** Reconnect query: the last sequence the client successfully applied. */
export const kdsSinceSchema = z.object({
  sequence: z.string().regex(/^\d+$/, 'Sequence must be a non-negative integer'),
});
export type KdsSinceDto = z.infer<typeof kdsSinceSchema>;

/**
 * Stream query. The ticket is the credential; `branchId` is optional and only
 * ever cross-checked against the ticket's claims, never trusted on its own.
 */
export const kdsStreamSchema = z.object({
  ticket: z.string().min(16).max(256),
  branchId: z.string().uuid().optional(),
});
export type KdsStreamDto = z.infer<typeof kdsStreamSchema>;
