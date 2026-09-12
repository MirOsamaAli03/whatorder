import { Injectable } from '@nestjs/common';
import { ConflictError, NotFoundError, ValidationError } from '@restaurant-os/domain';
import {
  AuditAction,
  ModifierSelectionType,
  type AuthContext,
} from '@restaurant-os/types';
import { AuditService } from '../audit/audit.service';
import { toMoneyString } from '../common/decimal';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateModifierDto,
  CreateOptionDto,
  SetItemModifiersDto,
  UpdateModifierDto,
  UpdateOptionDto,
} from './menu.dto';

/**
 * Modifier groups and their options (ENGINEERING_SPEC.md 10).
 *
 * A modifier group belongs to the organization, not to one item, so "Choose
 * your sauce" is defined once and attached to every item that offers it. The
 * attachment lives in `menu_item_modifiers` — the join table the spec omits,
 * without which none of this connects to a menu at all (plan 2.4).
 */
@Injectable()
export class ModifiersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findAll(auth: AuthContext) {
    return this.prisma.forTenant(auth.tenantId, (tx) =>
      tx.modifier.findMany({
        include: { options: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] } },
        orderBy: { name: 'asc' },
      }),
    );
  }

  async create(auth: AuthContext, input: CreateModifierDto) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const duplicate = await tx.modifier.findFirst({ where: { name: input.name } });
      if (duplicate) {
        throw new ConflictError(`A modifier group named "${input.name}" already exists`);
      }

      const selectionType = input.selectionType ?? ModifierSelectionType.SINGLE;
      const maxSelections =
        input.maxSelections ?? (selectionType === ModifierSelectionType.SINGLE ? 1 : 5);

      const modifier = await tx.modifier.create({
        data: {
          tenantId: auth.tenantId,
          name: input.name,
          selectionType,
          required: input.required ?? false,
          minSelections: input.minSelections ?? 0,
          maxSelections,
          options: {
            create: (input.options ?? []).map((option, index) => ({
              tenantId: auth.tenantId,
              name: option.name,
              priceDelta: option.priceDelta ?? '0.00',
              isDefault: option.isDefault ?? false,
              sortOrder: option.sortOrder ?? index,
            })),
          },
        },
        include: { options: true },
      });

      await this.audit.recordIn(tx, {
        action: AuditAction.CREATE,
        entityType: 'Modifier',
        entityId: modifier.id,
        tenantId: auth.tenantId,
        newValues: {
          name: modifier.name,
          selectionType: modifier.selectionType,
          optionCount: modifier.options.length,
        },
      });

      return modifier;
    });
  }

  async update(auth: AuthContext, modifierId: string, input: UpdateModifierDto) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const existing = await tx.modifier.findUnique({ where: { id: modifierId } });
      if (!existing) throw new NotFoundError('Modifier', modifierId);

      const selectionType = input.selectionType ?? existing.selectionType;
      const minSelections = input.minSelections ?? existing.minSelections;
      const maxSelections = input.maxSelections ?? existing.maxSelections;

      // Checked against the merged result, not the patch: changing only
      // selectionType could otherwise leave the group self-contradictory, and
      // validateModifierSelection would then reject every possible choice.
      if (minSelections > maxSelections) {
        throw new ValidationError('minSelections cannot exceed maxSelections');
      }
      if (selectionType === ModifierSelectionType.SINGLE && maxSelections !== 1) {
        throw new ValidationError('A SINGLE selection group cannot allow more than one choice');
      }

      const modifier = await tx.modifier.update({
        where: { id: modifierId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.selectionType !== undefined ? { selectionType: input.selectionType } : {}),
          ...(input.required !== undefined ? { required: input.required } : {}),
          ...(input.minSelections !== undefined ? { minSelections: input.minSelections } : {}),
          ...(input.maxSelections !== undefined ? { maxSelections: input.maxSelections } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
        include: { options: true },
      });

      await this.audit.recordIn(tx, {
        action: AuditAction.UPDATE,
        entityType: 'Modifier',
        entityId: modifierId,
        tenantId: auth.tenantId,
        oldValues: {
          name: existing.name,
          selectionType: existing.selectionType,
          required: existing.required,
          isActive: existing.isActive,
        },
        newValues: {
          name: modifier.name,
          selectionType: modifier.selectionType,
          required: modifier.required,
          isActive: modifier.isActive,
        },
      });

      return modifier;
    });
  }

  async archive(auth: AuthContext, modifierId: string) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const existing = await tx.modifier.findUnique({ where: { id: modifierId } });
      if (!existing) throw new NotFoundError('Modifier', modifierId);

      const modifier = await tx.modifier.update({
        where: { id: modifierId },
        data: { isActive: false },
      });

      await this.audit.recordIn(tx, {
        action: AuditAction.DELETE,
        entityType: 'Modifier',
        entityId: modifierId,
        tenantId: auth.tenantId,
        oldValues: { name: existing.name, isActive: existing.isActive },
        newValues: { isActive: false },
      });

      return modifier;
    });
  }

  async addOption(auth: AuthContext, modifierId: string, input: CreateOptionDto) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const modifier = await tx.modifier.findUnique({ where: { id: modifierId } });
      if (!modifier) throw new NotFoundError('Modifier', modifierId);

      const duplicate = await tx.modifierOption.findFirst({
        where: { modifierId, name: input.name },
      });
      if (duplicate) {
        throw new ConflictError(`This group already has an option named "${input.name}"`);
      }

      const option = await tx.modifierOption.create({
        data: {
          tenantId: auth.tenantId,
          modifierId,
          name: input.name,
          priceDelta: input.priceDelta ?? '0.00',
          isDefault: input.isDefault ?? false,
          isAvailable: input.isAvailable ?? true,
          sortOrder: input.sortOrder ?? 0,
        },
      });

      await this.audit.recordIn(tx, {
        action: AuditAction.CREATE,
        entityType: 'ModifierOption',
        entityId: option.id,
        tenantId: auth.tenantId,
        newValues: { modifierId, name: option.name, priceDelta: toMoneyString(option.priceDelta) },
      });

      return option;
    });
  }

  async updateOption(auth: AuthContext, optionId: string, input: UpdateOptionDto) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const existing = await tx.modifierOption.findUnique({ where: { id: optionId } });
      if (!existing) throw new NotFoundError('Modifier option', optionId);

      const option = await tx.modifierOption.update({
        where: { id: optionId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.priceDelta !== undefined ? { priceDelta: input.priceDelta } : {}),
          ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
          ...(input.isAvailable !== undefined ? { isAvailable: input.isAvailable } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        },
      });

      const priceChanged = toMoneyString(existing.priceDelta) !== toMoneyString(option.priceDelta);

      await this.audit.recordIn(tx, {
        action: priceChanged
          ? AuditAction.PRICE_CHANGE
          : existing.isAvailable !== option.isAvailable
            ? AuditAction.AVAILABILITY_CHANGE
            : AuditAction.UPDATE,
        entityType: 'ModifierOption',
        entityId: optionId,
        tenantId: auth.tenantId,
        oldValues: {
          name: existing.name,
          priceDelta: toMoneyString(existing.priceDelta),
          isAvailable: existing.isAvailable,
        },
        newValues: {
          name: option.name,
          priceDelta: toMoneyString(option.priceDelta),
          isAvailable: option.isAvailable,
        },
      });

      return option;
    });
  }

  async removeOption(auth: AuthContext, optionId: string) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const existing = await tx.modifierOption.findUnique({ where: { id: optionId } });
      if (!existing) throw new NotFoundError('Modifier option', optionId);

      await tx.modifierOption.delete({ where: { id: optionId } });

      await this.audit.recordIn(tx, {
        action: AuditAction.DELETE,
        entityType: 'ModifierOption',
        entityId: optionId,
        tenantId: auth.tenantId,
        oldValues: { name: existing.name, modifierId: existing.modifierId },
      });

      return { deleted: true };
    });
  }

  /**
   * Replaces the full set of modifier groups on an item.
   *
   * A replace rather than add/remove endpoints: the dashboard edits this as one
   * list, and a replace has no ordering hazard between two concurrent editors —
   * the last write is coherent rather than a mix of both.
   */
  async setItemModifiers(auth: AuthContext, itemId: string, input: SetItemModifiersDto) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const item = await tx.menuItem.findUnique({ where: { id: itemId } });
      if (!item) throw new NotFoundError('Menu item', itemId);

      const unique = [...new Set(input.modifierIds)];

      if (unique.length > 0) {
        // RLS scopes this count to the caller's organization, so a modifier id
        // from another tenant is simply not found.
        const found = await tx.modifier.count({ where: { id: { in: unique } } });
        if (found !== unique.length) {
          throw new NotFoundError('One or more modifier groups');
        }
      }

      const previous = await tx.menuItemModifier.findMany({
        where: { menuItemId: itemId },
        select: { modifierId: true },
      });

      await tx.menuItemModifier.deleteMany({ where: { menuItemId: itemId } });

      if (unique.length > 0) {
        await tx.menuItemModifier.createMany({
          data: unique.map((modifierId, index) => ({
            tenantId: auth.tenantId,
            menuItemId: itemId,
            modifierId,
            sortOrder: index,
          })),
        });
      }

      await this.audit.recordIn(tx, {
        action: AuditAction.UPDATE,
        entityType: 'MenuItemModifier',
        entityId: itemId,
        tenantId: auth.tenantId,
        oldValues: { modifierIds: previous.map((link) => link.modifierId) },
        newValues: { modifierIds: unique },
      });

      return { menuItemId: itemId, modifierIds: unique };
    });
  }
}
