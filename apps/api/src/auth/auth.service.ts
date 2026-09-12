import { Inject, Injectable, Logger } from '@nestjs/common';
import type { TransactionClient } from '@restaurant-os/database';
import { DomainError, isBranchScoped } from '@restaurant-os/domain';
import {
  AuditAction,
  ErrorCode,
  MembershipStatus,
  OrganizationStatus,
  UserStatus,
  type AuthContext,
  type Permission,
} from '@restaurant-os/types';
import { AuditService } from '../audit/audit.service';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

/** Consecutive failures before an account is temporarily locked. */
const MAX_FAILED_LOGINS = 10;
const LOCKOUT_MINUTES = 15;

export interface LoginInput {
  email: string;
  password: string;
  /** Required only when the user belongs to more than one organization. */
  organizationSlug?: string;
}

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface LoginResult extends AuthTokens {
  user: { id: string; name: string; email: string };
  organization: { id: string; name: string; slug: string; type: string };
  roles: string[];
  permissions: Permission[];
  branchIds: string[] | null;
}

/** Returned when the caller must choose which organization to sign in to. */
export interface OrganizationChoice {
  organizations: Array<{ id: string; name: string; slug: string; type: string }>;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  async login(input: LoginInput, meta: RequestMeta): Promise<LoginResult | OrganizationChoice> {
    const email = input.email.trim().toLowerCase();

    const user = await this.prisma.withoutTenant((tx) =>
      tx.user.findUnique({ where: { email } }),
    );

    if (!user) {
      // Burn the same CPU as a real verification so response time does not
      // reveal whether the address is registered.
      await this.passwords.burnTimingBudget();
      await this.audit.record({
        action: AuditAction.LOGIN_FAILED,
        entityType: 'User',
        actorType: 'ANONYMOUS',
        newValues: { email, reason: 'UNKNOWN_EMAIL' },
      });
      throw new DomainError(ErrorCode.INVALID_CREDENTIALS, 'Invalid email or password', 401);
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new DomainError(
        ErrorCode.ACCOUNT_SUSPENDED,
        'Too many failed sign-in attempts. Try again shortly.',
        423,
      );
    }

    const passwordValid = await this.passwords.verify(user.passwordHash, input.password);
    if (!passwordValid) {
      await this.registerFailedLogin(user.id, user.failedLoginCount);
      await this.audit.record({
        action: AuditAction.LOGIN_FAILED,
        entityType: 'User',
        entityId: user.id,
        actorId: user.id,
        newValues: { email, reason: 'BAD_PASSWORD' },
      });
      throw new DomainError(ErrorCode.INVALID_CREDENTIALS, 'Invalid email or password', 401);
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw new DomainError(
        ErrorCode.ACCOUNT_SUSPENDED,
        'This account is not active. Contact your administrator.',
        403,
      );
    }

    // Password is correct: the user may now see their own memberships.
    const memberships = await this.prisma.forUser(user.id, (tx) =>
      tx.membership.findMany({
        where: { status: MembershipStatus.ACTIVE, userId: user.id },
        include: { organization: true },
      }),
    );

    const available = memberships.filter(
      (membership) => membership.organization.status === OrganizationStatus.ACTIVE,
    );

    if (available.length === 0) {
      throw new DomainError(
        ErrorCode.FORBIDDEN,
        'This account is not attached to an active organization',
        403,
      );
    }

    const selected = input.organizationSlug
      ? available.find((m) => m.organization.slug === input.organizationSlug)
      : available.length === 1
        ? available[0]
        : undefined;

    if (!selected) {
      if (input.organizationSlug) {
        throw new DomainError(
          ErrorCode.FORBIDDEN,
          'You do not have access to that organization',
          403,
        );
      }
      // Ambiguous: let the client pick. Not an error.
      return {
        organizations: available.map((m) => ({
          id: m.organization.id,
          name: m.organization.name,
          slug: m.organization.slug,
          type: m.organization.type,
        })),
      };
    }

    const grants = await this.loadGrants(selected.tenantId, selected.id);
    const tokens = await this.issueSession({
      userId: user.id,
      tenantId: selected.tenantId,
      membershipId: selected.id,
      meta,
    });

    await this.prisma.withoutTenant((tx) =>
      tx.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
      }),
    );

    await this.audit.record({
      action: AuditAction.LOGIN,
      entityType: 'User',
      entityId: user.id,
      tenantId: selected.tenantId,
      actorId: user.id,
    });

    return {
      ...tokens,
      user: { id: user.id, name: user.name, email: user.email },
      organization: {
        id: selected.organization.id,
        name: selected.organization.name,
        slug: selected.organization.slug,
        type: selected.organization.type,
      },
      roles: grants.roles,
      permissions: grants.permissions,
      branchIds: grants.branchIds,
    };
  }

  /**
   * Rotates a refresh token.
   *
   * Rotation plus reuse detection: each refresh issues a new session row and
   * revokes the old one. Presenting an already-rotated token means the token
   * was captured, so every session in that chain is revoked rather than just
   * rejecting the request.
   */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<AuthTokens> {
    const claims = await this.tokens.verifyRefreshToken(refreshToken);
    const tokenHash = this.tokens.hashRefreshToken(refreshToken);

    const session = await this.prisma.withoutTenant((tx) =>
      tx.session.findUnique({ where: { refreshTokenHash: tokenHash } }),
    );

    if (!session || session.userId !== claims.sub) {
      throw new DomainError(ErrorCode.TOKEN_INVALID, 'Refresh token is not recognised', 401);
    }

    if (session.revokedAt) {
      await this.revokeChain(session.userId, session.tenantId, 'REFRESH_TOKEN_REUSED');
      this.logger.warn(
        { userId: session.userId, sessionId: session.id },
        'Refresh token reuse detected; revoked all sessions for this user and organization',
      );
      throw new DomainError(
        ErrorCode.SESSION_REVOKED,
        'This session has been revoked. Please sign in again.',
        401,
      );
    }

    if (session.expiresAt <= new Date()) {
      throw new DomainError(ErrorCode.TOKEN_EXPIRED, 'Session has expired', 401);
    }

    const membership = await this.prisma.forTenant(session.tenantId, (tx) =>
      tx.membership.findUnique({ where: { id: session.membershipId } }),
    );

    if (!membership || membership.status !== MembershipStatus.ACTIVE) {
      await this.revokeChain(session.userId, session.tenantId, 'MEMBERSHIP_INACTIVE');
      throw new DomainError(ErrorCode.FORBIDDEN, 'Access to this organization was removed', 403);
    }

    const issued = await this.issueSession({
      userId: session.userId,
      tenantId: session.tenantId,
      membershipId: session.membershipId,
      meta,
    });

    await this.prisma.withoutTenant((tx) =>
      tx.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date(), revokedReason: 'ROTATED' },
      }),
    );

    return issued;
  }

  async logout(sessionId: string): Promise<void> {
    await this.prisma.withoutTenant((tx) =>
      tx.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'LOGOUT' },
      }),
    );
  }

  /**
   * Rebuilds the caller's authorization context from a verified access token.
   *
   * Read on every authenticated request so that a revoked session, a removed
   * membership or a changed role takes effect immediately rather than at the
   * next token expiry. Permission caching is a Phase 9 optimisation; being
   * wrong about authorization for up to 15 minutes is not an acceptable
   * starting point.
   */
  async resolveAuthContext(input: {
    userId: string;
    sessionId: string;
    tenantId: string;
  }): Promise<AuthContext> {
    const session = await this.prisma.withoutTenant((tx) =>
      tx.session.findUnique({
        where: { id: input.sessionId },
        include: { user: true },
      }),
    );

    if (!session || session.userId !== input.userId || session.tenantId !== input.tenantId) {
      throw new DomainError(ErrorCode.TOKEN_INVALID, 'Session is not recognised', 401);
    }
    if (session.revokedAt) {
      throw new DomainError(ErrorCode.SESSION_REVOKED, 'Session has been revoked', 401);
    }
    if (session.expiresAt <= new Date()) {
      throw new DomainError(ErrorCode.TOKEN_EXPIRED, 'Session has expired', 401);
    }
    if (session.user.status !== UserStatus.ACTIVE) {
      throw new DomainError(ErrorCode.ACCOUNT_SUSPENDED, 'This account is not active', 403);
    }

    const membership = await this.prisma.forTenant(input.tenantId, (tx) =>
      tx.membership.findUnique({ where: { id: session.membershipId } }),
    );

    if (!membership || membership.status !== MembershipStatus.ACTIVE) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'Access to this organization was removed', 403);
    }

    const grants = await this.loadGrants(input.tenantId, session.membershipId);

    return {
      userId: session.userId,
      sessionId: session.id,
      tenantId: input.tenantId,
      membershipId: session.membershipId,
      roles: grants.roles,
      permissions: grants.permissions,
      branchIds: grants.branchIds,
      isPlatformAdmin: session.user.isPlatformAdmin,
    };
  }

  /**
   * Loads the roles, permissions and branch scope for a membership.
   *
   * Permissions come from the database rather than from the in-code role map,
   * so a tenant's custom roles work identically to system roles. The code map
   * in @restaurant-os/domain is what seeds this, and enum-parity keeps them
   * consistent.
   */
  private async loadGrants(
    tenantId: string,
    membershipId: string,
  ): Promise<{ roles: string[]; permissions: Permission[]; branchIds: string[] | null }> {
    return this.prisma.forTenant(tenantId, async (tx: TransactionClient) => {
      const membershipRoles = await tx.membershipRole.findMany({
        where: { membershipId },
        include: {
          role: { include: { permissions: { include: { permission: true } } } },
        },
      });

      const roles = membershipRoles.map((membershipRole) => membershipRole.role.name);

      const permissions = [
        ...new Set(
          membershipRoles.flatMap((membershipRole) =>
            membershipRole.role.permissions.map((rolePermission) => rolePermission.permission.key),
          ),
        ),
      ] as Permission[];

      // Organization-wide roles ignore branch assignment entirely.
      if (!isBranchScoped(roles)) {
        return { roles, permissions, branchIds: null };
      }

      const branches = await tx.membershipBranch.findMany({
        where: { membershipId },
        select: { branchId: true },
      });

      return { roles, permissions, branchIds: branches.map((branch) => branch.branchId) };
    });
  }

  private async issueSession(input: {
    userId: string;
    tenantId: string;
    membershipId: string;
    meta: RequestMeta;
  }): Promise<AuthTokens> {
    const expiresAt = new Date(Date.now() + this.env.JWT_REFRESH_TTL * 1000);

    // The session row must exist before the refresh token is signed, because
    // the token carries the session id. It is created with a placeholder hash
    // that no token can produce, then updated with the real one.
    const session = await this.prisma.withoutTenant((tx) =>
      tx.session.create({
        data: {
          userId: input.userId,
          tenantId: input.tenantId,
          membershipId: input.membershipId,
          refreshTokenHash: `pending:${crypto.randomUUID()}`,
          userAgent: input.meta.userAgent ?? null,
          ipAddress: input.meta.ipAddress ?? null,
          expiresAt,
        },
      }),
    );

    const refreshToken = await this.tokens.signRefreshToken({
      userId: input.userId,
      sessionId: session.id,
    });

    await this.prisma.withoutTenant((tx) =>
      tx.session.update({
        where: { id: session.id },
        data: { refreshTokenHash: this.tokens.hashRefreshToken(refreshToken) },
      }),
    );

    const accessToken = await this.tokens.signAccessToken({
      userId: input.userId,
      sessionId: session.id,
      tenantId: input.tenantId,
    });

    return { accessToken, refreshToken, expiresIn: this.env.JWT_ACCESS_TTL };
  }

  private async registerFailedLogin(userId: string, currentCount: number): Promise<void> {
    const nextCount = currentCount + 1;
    const shouldLock = nextCount >= MAX_FAILED_LOGINS;

    await this.prisma.withoutTenant((tx) =>
      tx.user.update({
        where: { id: userId },
        data: {
          failedLoginCount: nextCount,
          lockedUntil: shouldLock ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
        },
      }),
    );
  }

  private async revokeChain(userId: string, tenantId: string, reason: string): Promise<void> {
    await this.prisma.withoutTenant((tx) =>
      tx.session.updateMany({
        where: { userId, tenantId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      }),
    );
  }
}
