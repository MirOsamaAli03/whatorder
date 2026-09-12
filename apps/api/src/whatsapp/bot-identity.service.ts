import { Injectable, Logger } from '@nestjs/common';
import type { TransactionClient } from '@restaurant-os/database';
import { resolvePermissions } from '@restaurant-os/domain';
import {
  MembershipStatus,
  Permission,
  SystemRole,
  UserStatus,
  type AuthContext,
} from '@restaurant-os/types';
import { randomBytes } from 'node:crypto';
import { PasswordService } from '../auth/password.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The identity the WhatsApp conversation engine acts as.
 *
 * ENGINEERING_SPEC.md §21 requires the channel to go through the same order
 * core as every other, and §87 forbids a `WhatsAppOrderService` shadowing the
 * real one. So the engine calls CartService and OrdersService directly — and
 * those, correctly, want to know *who is asking*.
 *
 * The tempting answer is a synthetic context: a hand-built AuthContext that
 * grants itself whatever it needs. That would work, and it would quietly place
 * the channel outside the authorization model — the one component taking
 * instructions from the public internet would be the one component nothing
 * constrains.
 *
 * Instead the bot is an ordinary principal: a real user, a real membership, a
 * real role, confined to one branch through `membership_branches`. Which means
 *
 *   * `canAccessBranch` applies to it, so a routing mistake cannot place an
 *     order at another branch — the check is the same one staff get;
 *   * RLS applies to it, so a tenant mix-up returns nothing rather than
 *     somebody else's menu;
 *   * the audit trail names it truthfully, with an id that resolves;
 *   * a restaurant can see it in their staff list and see what it may do;
 *   * and when Phase 11 puts a model in this path, the model's output executes
 *     as *this* principal — which is what makes invariant 9 structural rather
 *     than a matter of prompt discipline.
 *
 * The account cannot be signed in to: its password is random bytes that are
 * discarded, and there is no reset flow.
 */
@Injectable()
export class BotIdentityService {
  private readonly logger = new Logger(BotIdentityService.name);

  /**
   * Cached per tenant and branch.
   *
   * The lookup is four joins and the answer changes only when a restaurant
   * edits the bot's role, which no UI offers yet. Permissions for *people* are
   * deliberately never cached (see B-6) because revocation must be immediate;
   * this principal has no human to revoke.
   */
  private readonly cache = new Map<string, AuthContext>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
  ) {}

  async contextFor(tenantId: string, branchId: string): Promise<AuthContext> {
    const key = `${tenantId}:${branchId}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const context = await this.prisma.forTenant(tenantId, (tx) =>
      this.resolve(tx, tenantId, branchId),
    );

    this.cache.set(key, context);
    return context;
  }

  /** Drops the cache, for tests and for a role change taking effect. */
  forget(tenantId?: string): void {
    if (!tenantId) {
      this.cache.clear();
      return;
    }
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${tenantId}:`)) this.cache.delete(key);
    }
  }

  private async resolve(
    tx: TransactionClient,
    tenantId: string,
    branchId: string,
  ): Promise<AuthContext> {
    const email = `whatsapp-bot+${tenantId}@channels.restaurant-os.local`;

    // The user is global and therefore outside RLS, which is why it is upserted
    // by its unique email rather than looked up by tenant.
    const user = await tx.user.upsert({
      where: { email },
      update: {},
      create: {
        email,
        name: 'WhatsApp',
        // Random and immediately discarded. Nothing can sign in as this
        // account, and no reset flow exists to change that.
        passwordHash: await this.passwords.hash(randomBytes(32).toString('hex')),
        status: UserStatus.ACTIVE,
      },
    });

    const membership = await tx.membership.upsert({
      where: { userId_tenantId: { userId: user.id, tenantId } },
      update: { status: MembershipStatus.ACTIVE },
      create: { tenantId, userId: user.id, status: MembershipStatus.ACTIVE },
    });

    const role = await tx.role.findFirst({
      where: { tenantId: null, name: SystemRole.CHANNEL_BOT },
    });

    if (!role) {
      // The system roles are seeded; a missing one means the database was not
      // prepared, and guessing at permissions here would be worse than saying
      // so plainly.
      throw new Error(
        `The ${SystemRole.CHANNEL_BOT} role is not seeded. Run the seed before ` +
          'accepting WhatsApp traffic.',
      );
    }

    const existingRole = await tx.membershipRole.findFirst({
      where: { membershipId: membership.id, roleId: role.id },
    });
    if (!existingRole) {
      await tx.membershipRole.create({
        data: { tenantId, membershipId: membership.id, roleId: role.id },
      });
      this.logger.log(`Provisioned the WhatsApp channel principal for tenant ${tenantId}`);
    }

    // Confined to the branch whose number the customer messaged. The bot is
    // branch-scoped (BRANCH_SCOPED_ROLES), so this set is the whole of its
    // reach, and a number routed to the wrong branch is refused rather than
    // silently obeyed.
    const existingBranch = await tx.membershipBranch.findFirst({
      where: { membershipId: membership.id, branchId },
    });
    if (!existingBranch) {
      await tx.membershipBranch.create({
        data: { tenantId, membershipId: membership.id, branchId },
      });
    }

    const branches = await tx.membershipBranch.findMany({
      where: { membershipId: membership.id },
      select: { branchId: true },
    });

    return {
      userId: user.id,
      // No HTTP session exists: the caller is a webhook, not a browser. The id
      // is the membership's, so anything logging it points at something real.
      sessionId: membership.id,
      tenantId,
      membershipId: membership.id,
      roles: [SystemRole.CHANNEL_BOT],
      permissions: resolvePermissions([SystemRole.CHANNEL_BOT]) as Permission[],
      branchIds: branches.map((row) => row.branchId),
      isPlatformAdmin: false,
    };
  }
}
