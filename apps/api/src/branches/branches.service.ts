import { Injectable } from '@nestjs/common';
import { BranchAccessDeniedError, ConflictError, NotFoundError, canAccessBranch } from '@restaurant-os/domain';
import { AuditAction, type AuthContext } from '@restaurant-os/types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { DeliveryZoneService } from '../pricing/delivery-zone.service';
import type { CreateBranchDto, EligibleBranchesDto, UpdateBranchDto } from './branches.dto';

/**
 * Branch management (ENGINEERING_SPEC.md 60).
 *
 * Two independent layers protect every read:
 *   1. RLS confines the query to the caller's organization.
 *   2. canAccessBranch confines it further to the branches a branch-scoped
 *      user was assigned (spec 7: `order.branch_id IN authorizedBranches`).
 *
 * A missing branch and a branch belonging to another tenant produce the same
 * 404. Distinguishing them would let an attacker enumerate branch ids.
 */
@Injectable()
export class BranchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly deliveryZones: DeliveryZoneService,
  ) {}

  async findAll(auth: AuthContext) {
    return this.prisma.forTenant(auth.tenantId, (tx) =>
      tx.branch.findMany({
        // branchIds === null means organization-wide access.
        where: auth.branchIds === null ? {} : { id: { in: auth.branchIds } },
        orderBy: { name: 'asc' },
      }),
    );
  }

  /**
   * Branches that can serve an order, nearest first (ENGINEERING_SPEC.md 29).
   *
   * Delegates to DeliveryZoneService so the branch a customer is routed to and
   * the delivery fee they are quoted come from the same rules.
   */
  async findEligible(auth: AuthContext, query: EligibleBranchesDto) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const point =
        query.latitude !== undefined && query.longitude !== undefined
          ? { latitude: query.latitude, longitude: query.longitude }
          : null;

      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: auth.tenantId },
        select: { currency: true },
      });

      const candidates = await this.deliveryZones.findEligibleBranches(tx, {
        orderType: query.orderType,
        point,
        currency: organization.currency,
      });

      // A branch-scoped user only ever sees their own branches (spec 7).
      const visible =
        auth.branchIds === null
          ? candidates
          : candidates.filter((candidate) => auth.branchIds!.includes(candidate.branchId));

      return {
        orderType: query.orderType,
        branches: visible.map((candidate) => ({
          branchId: candidate.branchId,
          branchName: candidate.branchName,
          distanceMetres: candidate.distanceMetres,
          deliveryZone: candidate.zone
            ? {
                id: candidate.zone.zoneId,
                name: candidate.zone.zoneName,
                deliveryFee: candidate.zone.deliveryFee.toDecimalString(),
                minimumOrder: candidate.zone.minimumOrder?.toDecimalString() ?? null,
              }
            : null,
        })),
      };
    });
  }

  async findOne(auth: AuthContext, branchId: string) {
    if (!canAccessBranch(auth, branchId)) {
      throw new BranchAccessDeniedError();
    }

    const branch = await this.prisma.forTenant(auth.tenantId, (tx) =>
      tx.branch.findUnique({ where: { id: branchId } }),
    );

    if (!branch) {
      throw new NotFoundError('Branch', branchId);
    }
    return branch;
  }

  async create(auth: AuthContext, input: CreateBranchDto) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const duplicate = await tx.branch.findFirst({ where: { slug: input.slug } });
      if (duplicate) {
        throw new ConflictError(`A branch with the slug "${input.slug}" already exists`);
      }

      const branch = await tx.branch.create({
        data: {
          // Taken from the session, never from the request body (spec 6).
          tenantId: auth.tenantId,
          name: input.name,
          slug: input.slug,
          address: input.address ?? null,
          city: input.city ?? null,
          phone: input.phone ?? null,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          openingHours: input.openingHours ?? {},
          deliveryEnabled: input.deliveryEnabled ?? true,
          pickupEnabled: input.pickupEnabled ?? true,
          dineInEnabled: input.dineInEnabled ?? false,
          reservationsEnabled: input.reservationsEnabled ?? false,
        },
      });

      await this.audit.recordIn(tx, {
        action: AuditAction.CREATE,
        entityType: 'Branch',
        entityId: branch.id,
        tenantId: auth.tenantId,
        newValues: { name: branch.name, slug: branch.slug, status: branch.status },
      });

      return branch;
    });
  }

  async update(auth: AuthContext, branchId: string, input: UpdateBranchDto) {
    if (!canAccessBranch(auth, branchId)) {
      throw new BranchAccessDeniedError();
    }

    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const existing = await tx.branch.findUnique({ where: { id: branchId } });
      if (!existing) {
        throw new NotFoundError('Branch', branchId);
      }

      if (input.slug && input.slug !== existing.slug) {
        const duplicate = await tx.branch.findFirst({
          where: { slug: input.slug, id: { not: branchId } },
        });
        if (duplicate) {
          throw new ConflictError(`A branch with the slug "${input.slug}" already exists`);
        }
      }

      const branch = await tx.branch.update({
        where: { id: branchId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(input.address !== undefined ? { address: input.address } : {}),
          ...(input.city !== undefined ? { city: input.city } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.latitude !== undefined ? { latitude: input.latitude } : {}),
          ...(input.longitude !== undefined ? { longitude: input.longitude } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.openingHours !== undefined ? { openingHours: input.openingHours } : {}),
          ...(input.deliveryEnabled !== undefined
            ? { deliveryEnabled: input.deliveryEnabled }
            : {}),
          ...(input.pickupEnabled !== undefined ? { pickupEnabled: input.pickupEnabled } : {}),
          ...(input.dineInEnabled !== undefined ? { dineInEnabled: input.dineInEnabled } : {}),
          ...(input.reservationsEnabled !== undefined
            ? { reservationsEnabled: input.reservationsEnabled }
            : {}),
        },
      });

      await this.audit.recordIn(tx, {
        action: AuditAction.UPDATE,
        entityType: 'Branch',
        entityId: branchId,
        tenantId: auth.tenantId,
        oldValues: { name: existing.name, slug: existing.slug, status: existing.status },
        newValues: { name: branch.name, slug: branch.slug, status: branch.status },
      });

      return branch;
    });
  }
}
