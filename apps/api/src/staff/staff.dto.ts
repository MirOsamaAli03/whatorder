import { ALL_SYSTEM_ROLES, MembershipStatus } from '@restaurant-os/types';
import { z } from 'zod';

/**
 * Role names are validated against the system role list plus whatever custom
 * roles the organization defines; existence is checked in the service, where
 * the query is tenant-scoped.
 */
const roleName = z.string().min(1).max(64);

export const inviteStaffSchema = z.object({
  email: z.string().email().max(320),
  name: z.string().min(1).max(200),
  phone: z.string().max(32).optional(),
  roleNames: z.array(roleName).min(1, 'At least one role is required'),
  /**
   * Required in practice for branch-scoped roles: an unassigned cashier can
   * see nothing at all (see canAccessBranch).
   */
  branchIds: z.array(z.string().uuid()).optional(),
});
export type InviteStaffDto = z.infer<typeof inviteStaffSchema>;

export const updateStaffSchema = z
  .object({
    roleNames: z.array(roleName).min(1),
    branchIds: z.array(z.string().uuid()),
    status: z.nativeEnum(MembershipStatus),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateStaffDto = z.infer<typeof updateStaffSchema>;

export const SYSTEM_ROLE_NAMES = ALL_SYSTEM_ROLES;
