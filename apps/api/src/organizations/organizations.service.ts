import { Injectable } from '@nestjs/common';
import { Prisma } from '@restaurant-os/database';
import { NotFoundError } from '@restaurant-os/domain';
import { AuditAction, type AuthContext } from '@restaurant-os/types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { UpdateOrganizationDto } from './organizations.dto';

/**
 * Organization (tenant) management (ENGINEERING_SPEC.md 60).
 *
 * Note what is absent: there is no `findById(id)`. Every read is scoped to
 * `auth.tenantId`, so there is no code path that can be handed an arbitrary
 * organization id. Creating organizations belongs to onboarding and the
 * platform back office, not here.
 */
@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The caller's own organization. RLS restricts this to one row. */
  async findCurrent(auth: AuthContext) {
    const organization = await this.prisma.forTenant(auth.tenantId, (tx) =>
      tx.organization.findUnique({ where: { id: auth.tenantId } }),
    );

    if (!organization) {
      throw new NotFoundError('Organization');
    }
    return organization;
  }

  async update(auth: AuthContext, input: UpdateOrganizationDto) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const existing = await tx.organization.findUnique({ where: { id: auth.tenantId } });
      if (!existing) {
        throw new NotFoundError('Organization');
      }

      const updated = await tx.organization.update({
        where: { id: auth.tenantId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          ...(input.logoUrl !== undefined ? { logoUrl: input.logoUrl } : {}),
          ...(input.defaultLanguage !== undefined
            ? { defaultLanguage: input.defaultLanguage }
            : {}),
          ...(input.businessDayStartMinutes !== undefined
            ? { businessDayStartMinutes: input.businessDayStartMinutes }
            : {}),
          ...(input.settings !== undefined
            ? { settings: input.settings as Prisma.InputJsonValue }
            : {}),
        },
      });

      // Written inside the same transaction, so the change and its audit row
      // commit or roll back together.
      await this.audit.recordIn(tx, {
        action: AuditAction.UPDATE,
        entityType: 'Organization',
        entityId: auth.tenantId,
        tenantId: auth.tenantId,
        oldValues: {
          name: existing.name,
          timezone: existing.timezone,
          currency: existing.currency,
          settings: existing.settings,
        },
        newValues: {
          name: updated.name,
          timezone: updated.timezone,
          currency: updated.currency,
          settings: updated.settings,
        },
      });

      return updated;
    });
  }
}
