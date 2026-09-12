import { Injectable } from '@nestjs/common';
import type { TransactionClient } from '@restaurant-os/database';
import { ConflictError, ForbiddenError, NotFoundError, isBranchScoped } from '@restaurant-os/domain';
import {
  AuditAction,
  MembershipStatus,
  Permission,
  UserStatus,
  type AuthContext,
} from '@restaurant-os/types';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { PasswordService } from '../auth/password.service';
import { PrismaService } from '../prisma/prisma.service';
import type { InviteStaffDto, UpdateStaffDto } from './staff.dto';

/**
 * Staff and role administration (ENGINEERING_SPEC.md 9, 60).
 *
 * The privilege-escalation rule is the important part: a member may only grant
 * roles whose permissions they already hold themselves. Without it, any account
 * with staff.manage could mint itself an OWNER role and defeat the entire
 * permission model in one request.
 */
@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
  ) {}

  async findAll(auth: AuthContext) {
    const memberships = await this.prisma.forTenant(auth.tenantId, (tx) =>
      tx.membership.findMany({
        where: { status: { not: MembershipStatus.REMOVED } },
        include: {
          user: { select: { id: true, name: true, email: true, phone: true, status: true } },
          roles: { include: { role: { select: { id: true, name: true } } } },
          branches: { select: { branchId: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    );

    return memberships.map((membership) => this.present(membership));
  }

  async findOne(auth: AuthContext, membershipId: string) {
    const membership = await this.prisma.forTenant(auth.tenantId, (tx) =>
      tx.membership.findUnique({
        where: { id: membershipId },
        include: {
          user: { select: { id: true, name: true, email: true, phone: true, status: true } },
          roles: { include: { role: { select: { id: true, name: true } } } },
          branches: { select: { branchId: true } },
        },
      }),
    );

    if (!membership) {
      throw new NotFoundError('Staff member', membershipId);
    }
    return this.present(membership);
  }

  /**
   * Adds a person to the organization, creating the global user record if this
   * is their first organization.
   */
  async invite(auth: AuthContext, input: InviteStaffDto) {
    const email = input.email.trim().toLowerCase();

    // The user record is global, so it is created outside tenant context.
    const existingUser = await this.prisma.withoutTenant((tx) =>
      tx.user.findUnique({ where: { email } }),
    );

    let user = existingUser;
    if (!user) {
      // A password nobody knows, not a default or predictable one: the invitee
      // must set their own through password reset before they can sign in.
      const unusablePassword = await this.passwords.hash(randomBytes(32).toString('hex'));
      user = await this.prisma.withoutTenant((tx) =>
        tx.user.create({
          data: {
            email,
            name: input.name,
            phone: input.phone ?? null,
            passwordHash: unusablePassword,
            status: UserStatus.INVITED,
          },
        }),
      );
    }

    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const existingMembership = await tx.membership.findFirst({ where: { userId: user.id } });
      if (existingMembership && existingMembership.status !== MembershipStatus.REMOVED) {
        throw new ConflictError('That person is already a member of this organization');
      }

      const roles = await this.loadGrantableRoles(tx, auth, input.roleNames);
      await this.assertBranchesExist(tx, input.branchIds ?? []);

      const membership = existingMembership
        ? await tx.membership.update({
            where: { id: existingMembership.id },
            data: { status: MembershipStatus.INVITED },
          })
        : await tx.membership.create({
            data: {
              tenantId: auth.tenantId,
              userId: user.id,
              status: existingUser ? MembershipStatus.ACTIVE : MembershipStatus.INVITED,
            },
          });

      await tx.membershipRole.deleteMany({ where: { membershipId: membership.id } });
      await tx.membershipRole.createMany({
        data: roles.map((role) => ({
          tenantId: auth.tenantId,
          membershipId: membership.id,
          roleId: role.id,
        })),
      });

      await this.replaceBranches(tx, auth, membership.id, input.branchIds ?? []);

      await this.audit.recordIn(tx, {
        action: AuditAction.PERMISSION_CHANGE,
        entityType: 'Membership',
        entityId: membership.id,
        tenantId: auth.tenantId,
        newValues: {
          email,
          roles: roles.map((role) => role.name),
          branchIds: input.branchIds ?? [],
        },
      });

      return { membershipId: membership.id, userId: user.id, email, status: membership.status };
    });
  }

  async update(auth: AuthContext, membershipId: string, input: UpdateStaffDto) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const membership = await tx.membership.findUnique({
        where: { id: membershipId },
        include: { roles: { include: { role: true } }, branches: true },
      });

      if (!membership) {
        throw new NotFoundError('Staff member', membershipId);
      }

      const previous = {
        roles: membership.roles.map((membershipRole) => membershipRole.role.name),
        branchIds: membership.branches.map((branch) => branch.branchId),
        status: membership.status,
      };

      if (input.roleNames) {
        // Removing your own last privileged role locks you out of your own
        // organization, and nobody else can restore it.
        if (membership.userId === auth.userId) {
          throw new ForbiddenError('You cannot change your own roles');
        }

        const roles = await this.loadGrantableRoles(tx, auth, input.roleNames);
        await tx.membershipRole.deleteMany({ where: { membershipId } });
        await tx.membershipRole.createMany({
          data: roles.map((role) => ({
            tenantId: auth.tenantId,
            membershipId,
            roleId: role.id,
          })),
        });
      }

      if (input.branchIds) {
        await this.assertBranchesExist(tx, input.branchIds);
        await this.replaceBranches(tx, auth, membershipId, input.branchIds);
      }

      if (input.status) {
        if (membership.userId === auth.userId) {
          throw new ForbiddenError('You cannot change your own membership status');
        }
        await tx.membership.update({ where: { id: membershipId }, data: { status: input.status } });

        // Suspending someone must take effect immediately, not at token expiry.
        if (input.status !== MembershipStatus.ACTIVE) {
          await tx.session.updateMany({
            where: { membershipId, revokedAt: null },
            data: { revokedAt: new Date(), revokedReason: 'MEMBERSHIP_STATUS_CHANGED' },
          });
        }
      }

      const updated = await tx.membership.findUniqueOrThrow({
        where: { id: membershipId },
        include: {
          user: { select: { id: true, name: true, email: true, phone: true, status: true } },
          roles: { include: { role: { select: { id: true, name: true } } } },
          branches: { select: { branchId: true } },
        },
      });

      await this.audit.recordIn(tx, {
        action: AuditAction.PERMISSION_CHANGE,
        entityType: 'Membership',
        entityId: membershipId,
        tenantId: auth.tenantId,
        oldValues: previous,
        newValues: {
          roles: updated.roles.map((membershipRole) => membershipRole.role.name),
          branchIds: updated.branches.map((branch) => branch.branchId),
          status: updated.status,
        },
      });

      return this.present(updated);
    });
  }

  /** The roles this organization can assign: the system roles plus its own. */
  async listRoles(auth: AuthContext) {
    return this.prisma.forTenant(auth.tenantId, (tx) =>
      tx.role.findMany({
        include: { permissions: { include: { permission: { select: { key: true } } } } },
        orderBy: { name: 'asc' },
      }),
    );
  }

  /**
   * Resolves role names to rows, rejecting any that would grant the actor's
   * grantee more than the actor holds.
   */
  private async loadGrantableRoles(
    tx: TransactionClient,
    auth: AuthContext,
    roleNames: string[],
  ) {
    const roles = await tx.role.findMany({
      where: { name: { in: roleNames } },
      include: { permissions: { include: { permission: { select: { key: true } } } } },
    });

    const missing = roleNames.filter((name) => !roles.some((role) => role.name === name));
    if (missing.length > 0) {
      throw new NotFoundError(`Role "${missing[0]}"`);
    }

    // Owners may grant anything within their organization. Everyone else is
    // capped at their own permission set.
    const actorPermissions = new Set<string>(auth.permissions);
    const canGrantAnything = actorPermissions.has(Permission.ORGANIZATION_MANAGE);

    if (!canGrantAnything) {
      for (const role of roles) {
        const excess = role.permissions
          .map((rolePermission) => rolePermission.permission.key)
          .filter((key) => !actorPermissions.has(key));

        if (excess.length > 0) {
          throw new ForbiddenError(
            `You cannot grant the role "${role.name}" because it includes permissions you do not hold: ${excess.join(', ')}`,
          );
        }
      }
    }

    return roles;
  }

  private async assertBranchesExist(tx: TransactionClient, branchIds: string[]): Promise<void> {
    if (branchIds.length === 0) return;

    // RLS confines this count to the caller's organization, so a branch id
    // belonging to another tenant simply will not be found.
    const found = await tx.branch.count({ where: { id: { in: branchIds } } });
    if (found !== branchIds.length) {
      throw new NotFoundError('One or more branches');
    }
  }

  private async replaceBranches(
    tx: TransactionClient,
    auth: AuthContext,
    membershipId: string,
    branchIds: string[],
  ): Promise<void> {
    await tx.membershipBranch.deleteMany({ where: { membershipId } });
    if (branchIds.length === 0) return;

    await tx.membershipBranch.createMany({
      data: branchIds.map((branchId) => ({
        tenantId: auth.tenantId,
        membershipId,
        branchId,
      })),
    });
  }

  private present(membership: {
    id: string;
    status: string;
    user: { id: string; name: string; email: string; phone: string | null; status: string };
    roles: Array<{ role: { id: string; name: string } }>;
    branches: Array<{ branchId: string }>;
  }) {
    const roleNames = membership.roles.map((membershipRole) => membershipRole.role.name);
    return {
      membershipId: membership.id,
      status: membership.status,
      user: membership.user,
      roles: roleNames,
      // Mirrors AuthContext.branchIds: null means organization-wide.
      branchIds: isBranchScoped(roleNames)
        ? membership.branches.map((branch) => branch.branchId)
        : null,
    };
  }
}
