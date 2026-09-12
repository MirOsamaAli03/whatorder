import { Injectable } from '@nestjs/common';
import { Prisma, type TransactionClient } from '@restaurant-os/database';
import {
  BranchAccessDeniedError,
  ConflictError,
  NotFoundError,
  canAccessBranch,
  isVisibleToCustomer,
  resolveAvailability,
  resolvePrice,
} from '@restaurant-os/domain';
import {
  AggregateType,
  AuditAction,
  DomainEventType,
  MenuItemAvailability,
  type AuthContext,
} from '@restaurant-os/types';
import { AuditService } from '../audit/audit.service';
import { toMoneyString, toMoneyStringOrNull } from '../common/decimal';
import { OutboxService } from '../events/outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateCategoryDto,
  CreateItemDto,
  CreateVariantDto,
  MenuQueryDto,
  SetAvailabilityDto,
  SetBranchOverrideDto,
  UpdateCategoryDto,
  UpdateItemDto,
  UpdateVariantDto,
} from './menu.dto';

/**
 * Menu management (ENGINEERING_SPEC.md 10, 60, 86).
 *
 * Two rules shape everything here:
 *
 *   1. Prices and availability are resolved by the pure functions in
 *      @restaurant-os/domain, never re-implemented. The dashboard, the POS,
 *      WhatsApp and the AI tool layer all read a menu through this service and
 *      therefore see identical answers (spec 87).
 *   2. Price and availability changes are audited, and availability changes
 *      also emit a domain event, because they must reach every channel
 *      immediately (spec 10) and the real-time fan-out in Phase 4 will be
 *      driven from the outbox.
 */
@Injectable()
export class MenuService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * The full menu, with prices and availability resolved for one branch.
   *
   * `includeHidden` is what separates a staff screen from a customer-facing
   * one: management needs to see hidden and archived entries in order to
   * un-hide them, and a customer must never receive them.
   */
  async getMenu(auth: AuthContext, query: MenuQueryDto) {
    if (query.branchId && !canAccessBranch(auth, query.branchId)) {
      throw new BranchAccessDeniedError();
    }

    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      if (query.branchId) {
        // RLS confines this to the caller's organization, so a branch id from
        // another tenant simply is not found.
        const branch = await tx.branch.findUnique({ where: { id: query.branchId } });
        if (!branch) throw new NotFoundError('Branch', query.branchId);
      }

      const categories = await tx.menuCategory.findMany({
        where: query.includeHidden ? {} : { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      });

      const items = await tx.menuItem.findMany({
        where: query.includeHidden ? {} : { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        include: {
          variants: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] },
          modifiers: {
            orderBy: { sortOrder: 'asc' },
            include: {
              modifier: {
                include: { options: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] } },
              },
            },
          },
          overrides: query.branchId ? { where: { branchId: query.branchId } } : false,
        },
      });

      const presented = items
        .map((item) => this.presentItem(item, query.branchId ?? null))
        .filter((item) => query.includeHidden || item.isVisible);

      const byCategory = new Map<string | null, typeof presented>();
      for (const item of presented) {
        const key = item.categoryId;
        const bucket = byCategory.get(key);
        if (bucket) bucket.push(item);
        else byCategory.set(key, [item]);
      }

      const grouped = categories.map((category) => ({
        id: category.id,
        name: category.name,
        nameLocalized: category.nameLocalized,
        description: category.description,
        imageUrl: category.imageUrl,
        sortOrder: category.sortOrder,
        isActive: category.isActive,
        items: byCategory.get(category.id) ?? [],
      }));

      // Items with no category would otherwise vanish from the menu entirely.
      const uncategorized = byCategory.get(null) ?? [];

      return {
        branchId: query.branchId ?? null,
        categories: grouped,
        uncategorized,
      };
    });
  }

  async getItem(auth: AuthContext, itemId: string, branchId?: string) {
    if (branchId && !canAccessBranch(auth, branchId)) {
      throw new BranchAccessDeniedError();
    }

    const item = await this.prisma.forTenant(auth.tenantId, (tx) =>
      tx.menuItem.findUnique({
        where: { id: itemId },
        include: {
          variants: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] },
          modifiers: {
            orderBy: { sortOrder: 'asc' },
            include: {
              modifier: {
                include: { options: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] } },
              },
            },
          },
          overrides: branchId ? { where: { branchId } } : true,
        },
      }),
    );

    if (!item) throw new NotFoundError('Menu item', itemId);
    return this.presentItem(item, branchId ?? null);
  }

  // -------------------------------------------------------------------------
  // Categories
  // -------------------------------------------------------------------------

  async createCategory(auth: AuthContext, input: CreateCategoryDto) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const category = await tx.menuCategory.create({
        data: {
          // From the session, never the request body (spec 6).
          tenantId: auth.tenantId,
          name: input.name,
          nameLocalized: (input.nameLocalized ?? {}) as Prisma.InputJsonValue,
          description: input.description ?? null,
          imageUrl: input.imageUrl ?? null,
          sortOrder: input.sortOrder ?? 0,
        },
      });

      await this.audit.recordIn(tx, {
        action: AuditAction.CREATE,
        entityType: 'MenuCategory',
        entityId: category.id,
        tenantId: auth.tenantId,
        newValues: { name: category.name, sortOrder: category.sortOrder },
      });

      return category;
    });
  }

  async updateCategory(auth: AuthContext, categoryId: string, input: UpdateCategoryDto) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const existing = await tx.menuCategory.findUnique({ where: { id: categoryId } });
      if (!existing) throw new NotFoundError('Menu category', categoryId);

      const category = await tx.menuCategory.update({
        where: { id: categoryId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.nameLocalized !== undefined
            ? { nameLocalized: input.nameLocalized as Prisma.InputJsonValue }
            : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.imageUrl !== undefined ? { imageUrl: input.imageUrl } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
      });

      await this.audit.recordIn(tx, {
        action: AuditAction.UPDATE,
        entityType: 'MenuCategory',
        entityId: categoryId,
        tenantId: auth.tenantId,
        oldValues: { name: existing.name, isActive: existing.isActive },
        newValues: { name: category.name, isActive: category.isActive },
      });

      return category;
    });
  }

  /**
   * Archives a category. Its items are kept and become uncategorized rather
   * than disappearing, which is why the schema sets `categoryId` to NULL on
   * delete instead of cascading.
   */
  async archiveCategory(auth: AuthContext, categoryId: string) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const existing = await tx.menuCategory.findUnique({ where: { id: categoryId } });
      if (!existing) throw new NotFoundError('Menu category', categoryId);

      const category = await tx.menuCategory.update({
        where: { id: categoryId },
        data: { isActive: false },
      });

      await this.audit.recordIn(tx, {
        action: AuditAction.DELETE,
        entityType: 'MenuCategory',
        entityId: categoryId,
        tenantId: auth.tenantId,
        oldValues: { isActive: existing.isActive },
        newValues: { isActive: false },
      });

      return category;
    });
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  async createItem(auth: AuthContext, input: CreateItemDto) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      if (input.categoryId) {
        const category = await tx.menuCategory.findUnique({ where: { id: input.categoryId } });
        if (!category) throw new NotFoundError('Menu category', input.categoryId);
      }

      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: auth.tenantId },
        select: { currency: true },
      });

      const item = await tx.menuItem.create({
        data: {
          tenantId: auth.tenantId,
          categoryId: input.categoryId ?? null,
          name: input.name,
          nameLocalized: (input.nameLocalized ?? {}) as Prisma.InputJsonValue,
          description: input.description ?? null,
          imageUrl: input.imageUrl ?? null,
          basePrice: input.basePrice,
          costPrice: input.costPrice ?? null,
          // The organization's currency, never a client-supplied one.
          currency: organization.currency,
          preparationTimeMinutes: input.preparationTimeMinutes ?? 15,
          availability: input.availability ?? MenuItemAvailability.AVAILABLE,
          sortOrder: input.sortOrder ?? 0,
        },
      });

      await this.audit.recordIn(tx, {
        action: AuditAction.CREATE,
        entityType: 'MenuItem',
        entityId: item.id,
        tenantId: auth.tenantId,
        newValues: {
          name: item.name,
          basePrice: toMoneyString(item.basePrice),
          availability: item.availability,
        },
      });

      return item;
    });
  }

  async updateItem(auth: AuthContext, itemId: string, input: UpdateItemDto) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const existing = await tx.menuItem.findUnique({ where: { id: itemId } });
      if (!existing) throw new NotFoundError('Menu item', itemId);

      if (input.categoryId) {
        const category = await tx.menuCategory.findUnique({ where: { id: input.categoryId } });
        if (!category) throw new NotFoundError('Menu category', input.categoryId);
      }

      const item = await tx.menuItem.update({
        where: { id: itemId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.nameLocalized !== undefined
            ? { nameLocalized: input.nameLocalized as Prisma.InputJsonValue }
            : {}),
          ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.imageUrl !== undefined ? { imageUrl: input.imageUrl } : {}),
          ...(input.basePrice !== undefined ? { basePrice: input.basePrice } : {}),
          ...(input.costPrice !== undefined ? { costPrice: input.costPrice } : {}),
          ...(input.preparationTimeMinutes !== undefined
            ? { preparationTimeMinutes: input.preparationTimeMinutes }
            : {}),
          ...(input.availability !== undefined ? { availability: input.availability } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
      });

      const priceChanged = toMoneyString(existing.basePrice) !== toMoneyString(item.basePrice);
      const availabilityChanged = existing.availability !== item.availability;

      // Price changes get their own audit action because spec 59 calls them
      // out specifically: they are the changes an owner most needs to trace.
      await this.audit.recordIn(tx, {
        action: priceChanged ? AuditAction.PRICE_CHANGE : AuditAction.UPDATE,
        entityType: 'MenuItem',
        entityId: itemId,
        tenantId: auth.tenantId,
        oldValues: {
          name: existing.name,
          basePrice: toMoneyString(existing.basePrice),
          availability: existing.availability,
          isActive: existing.isActive,
        },
        newValues: {
          name: item.name,
          basePrice: toMoneyString(item.basePrice),
          availability: item.availability,
          isActive: item.isActive,
        },
      });

      if (availabilityChanged) {
        await this.emitAvailabilityChanged(tx, auth, item.id, null, item.availability);
      }

      return item;
    });
  }

  /** Archives an item. Never a hard delete — see the schema comment. */
  async archiveItem(auth: AuthContext, itemId: string) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const existing = await tx.menuItem.findUnique({ where: { id: itemId } });
      if (!existing) throw new NotFoundError('Menu item', itemId);

      const item = await tx.menuItem.update({
        where: { id: itemId },
        data: { isActive: false },
      });

      await this.audit.recordIn(tx, {
        action: AuditAction.DELETE,
        entityType: 'MenuItem',
        entityId: itemId,
        tenantId: auth.tenantId,
        oldValues: { isActive: existing.isActive, name: existing.name },
        newValues: { isActive: false },
      });

      // Archiving removes it from every channel, so the same event fires.
      await this.emitAvailabilityChanged(tx, auth, itemId, null, MenuItemAvailability.HIDDEN);

      return item;
    });
  }

  /**
   * Sets availability tenant-wide, or for a single branch when `branchId` is
   * given (ENGINEERING_SPEC.md 10, 86).
   *
   * The commonest real use is a branch marking one dish sold out for the
   * evening, which must not affect the rest of the chain.
   */
  async setAvailability(auth: AuthContext, itemId: string, input: SetAvailabilityDto) {
    if (input.branchId && !canAccessBranch(auth, input.branchId)) {
      throw new BranchAccessDeniedError();
    }

    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const item = await tx.menuItem.findUnique({ where: { id: itemId } });
      if (!item) throw new NotFoundError('Menu item', itemId);

      if (!input.branchId) {
        const updated = await tx.menuItem.update({
          where: { id: itemId },
          data: { availability: input.availability },
        });

        await this.audit.recordIn(tx, {
          action: AuditAction.AVAILABILITY_CHANGE,
          entityType: 'MenuItem',
          entityId: itemId,
          tenantId: auth.tenantId,
          oldValues: { availability: item.availability },
          newValues: { availability: updated.availability },
        });

        await this.emitAvailabilityChanged(tx, auth, itemId, null, updated.availability);
        return { scope: 'TENANT' as const, availability: updated.availability };
      }

      const branch = await tx.branch.findUnique({ where: { id: input.branchId } });
      if (!branch) throw new NotFoundError('Branch', input.branchId);

      const previous = await tx.branchMenuOverride.findUnique({
        where: { branchId_menuItemId: { branchId: input.branchId, menuItemId: itemId } },
      });

      const override = await tx.branchMenuOverride.upsert({
        where: { branchId_menuItemId: { branchId: input.branchId, menuItemId: itemId } },
        create: {
          tenantId: auth.tenantId,
          branchId: input.branchId,
          menuItemId: itemId,
          availability: input.availability,
        },
        update: { availability: input.availability },
      });

      await this.audit.recordIn(tx, {
        action: AuditAction.AVAILABILITY_CHANGE,
        entityType: 'BranchMenuOverride',
        entityId: override.id,
        tenantId: auth.tenantId,
        oldValues: { branchId: input.branchId, availability: previous?.availability ?? null },
        newValues: { branchId: input.branchId, availability: override.availability },
      });

      await this.emitAvailabilityChanged(
        tx,
        auth,
        itemId,
        input.branchId,
        // What a customer at that branch will actually see.
        resolveAvailability(item, override),
      );

      return { scope: 'BRANCH' as const, branchId: input.branchId, availability: override.availability };
    });
  }

  /** Sets or clears a branch's price and availability override. */
  async setBranchOverride(
    auth: AuthContext,
    itemId: string,
    branchId: string,
    input: SetBranchOverrideDto,
  ) {
    if (!canAccessBranch(auth, branchId)) {
      throw new BranchAccessDeniedError();
    }

    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const item = await tx.menuItem.findUnique({ where: { id: itemId } });
      if (!item) throw new NotFoundError('Menu item', itemId);

      const branch = await tx.branch.findUnique({ where: { id: branchId } });
      if (!branch) throw new NotFoundError('Branch', branchId);

      const previous = await tx.branchMenuOverride.findUnique({
        where: { branchId_menuItemId: { branchId, menuItemId: itemId } },
      });

      const override = await tx.branchMenuOverride.upsert({
        where: { branchId_menuItemId: { branchId, menuItemId: itemId } },
        create: {
          tenantId: auth.tenantId,
          branchId,
          menuItemId: itemId,
          price: input.price ?? null,
          availability: input.availability ?? null,
        },
        update: {
          ...(input.price !== undefined ? { price: input.price } : {}),
          ...(input.availability !== undefined ? { availability: input.availability } : {}),
        },
      });

      const priceChanged = (toMoneyStringOrNull(previous?.price)) !== (toMoneyStringOrNull(override.price));

      await this.audit.recordIn(tx, {
        action: priceChanged ? AuditAction.PRICE_CHANGE : AuditAction.AVAILABILITY_CHANGE,
        entityType: 'BranchMenuOverride',
        entityId: override.id,
        tenantId: auth.tenantId,
        oldValues: {
          branchId,
          price: toMoneyStringOrNull(previous?.price),
          availability: previous?.availability ?? null,
        },
        newValues: {
          branchId,
          price: toMoneyStringOrNull(override.price),
          availability: override.availability,
        },
      });

      if (input.availability !== undefined) {
        await this.emitAvailabilityChanged(
          tx,
          auth,
          itemId,
          branchId,
          resolveAvailability(item, override),
        );
      }

      return override;
    });
  }

  async clearBranchOverride(auth: AuthContext, itemId: string, branchId: string) {
    if (!canAccessBranch(auth, branchId)) {
      throw new BranchAccessDeniedError();
    }

    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const item = await tx.menuItem.findUnique({ where: { id: itemId } });
      if (!item) throw new NotFoundError('Menu item', itemId);

      const deleted = await tx.branchMenuOverride.deleteMany({
        where: { branchId, menuItemId: itemId },
      });

      if (deleted.count > 0) {
        await this.audit.recordIn(tx, {
          action: AuditAction.AVAILABILITY_CHANGE,
          entityType: 'BranchMenuOverride',
          entityId: itemId,
          tenantId: auth.tenantId,
          oldValues: { branchId, cleared: true },
          newValues: { branchId, price: null, availability: null },
        });

        // Back to the tenant-wide value for that branch.
        await this.emitAvailabilityChanged(tx, auth, itemId, branchId, item.availability);
      }

      return { cleared: deleted.count > 0 };
    });
  }

  // -------------------------------------------------------------------------
  // Variants
  // -------------------------------------------------------------------------

  async addVariant(auth: AuthContext, itemId: string, input: CreateVariantDto) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const item = await tx.menuItem.findUnique({ where: { id: itemId } });
      if (!item) throw new NotFoundError('Menu item', itemId);

      const duplicate = await tx.menuItemVariant.findFirst({
        where: { menuItemId: itemId, name: input.name },
      });
      if (duplicate) {
        throw new ConflictError(`This item already has a variant named "${input.name}"`);
      }

      if (input.isDefault) {
        await tx.menuItemVariant.updateMany({
          where: { menuItemId: itemId },
          data: { isDefault: false },
        });
      }

      const variant = await tx.menuItemVariant.create({
        data: {
          tenantId: auth.tenantId,
          menuItemId: itemId,
          name: input.name,
          price: input.price,
          isDefault: input.isDefault ?? false,
          sortOrder: input.sortOrder ?? 0,
        },
      });

      await this.audit.recordIn(tx, {
        action: AuditAction.CREATE,
        entityType: 'MenuItemVariant',
        entityId: variant.id,
        tenantId: auth.tenantId,
        newValues: { menuItemId: itemId, name: variant.name, price: toMoneyString(variant.price) },
      });

      return variant;
    });
  }

  async updateVariant(auth: AuthContext, variantId: string, input: UpdateVariantDto) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const existing = await tx.menuItemVariant.findUnique({ where: { id: variantId } });
      if (!existing) throw new NotFoundError('Variant', variantId);

      if (input.isDefault) {
        await tx.menuItemVariant.updateMany({
          where: { menuItemId: existing.menuItemId, id: { not: variantId } },
          data: { isDefault: false },
        });
      }

      const variant = await tx.menuItemVariant.update({
        where: { id: variantId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.price !== undefined ? { price: input.price } : {}),
          ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        },
      });

      const priceChanged = toMoneyString(existing.price) !== toMoneyString(variant.price);

      await this.audit.recordIn(tx, {
        action: priceChanged ? AuditAction.PRICE_CHANGE : AuditAction.UPDATE,
        entityType: 'MenuItemVariant',
        entityId: variantId,
        tenantId: auth.tenantId,
        oldValues: { name: existing.name, price: toMoneyString(existing.price) },
        newValues: { name: variant.name, price: toMoneyString(variant.price) },
      });

      return variant;
    });
  }

  async removeVariant(auth: AuthContext, variantId: string) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const existing = await tx.menuItemVariant.findUnique({ where: { id: variantId } });
      if (!existing) throw new NotFoundError('Variant', variantId);

      // Variants are safe to delete outright: order lines snapshot the name
      // and price they were bought at (spec 13), so history does not depend on
      // this row surviving.
      await tx.menuItemVariant.delete({ where: { id: variantId } });

      await this.audit.recordIn(tx, {
        action: AuditAction.DELETE,
        entityType: 'MenuItemVariant',
        entityId: variantId,
        tenantId: auth.tenantId,
        oldValues: { name: existing.name, price: toMoneyString(existing.price) },
      });

      return { deleted: true };
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async emitAvailabilityChanged(
    tx: TransactionClient,
    auth: AuthContext,
    menuItemId: string,
    branchId: string | null,
    availability: MenuItemAvailability,
  ): Promise<void> {
    await this.outbox.emit(tx, {
      eventType: DomainEventType.MENU_ITEM_AVAILABILITY_CHANGED,
      aggregateType: AggregateType.MENU_ITEM,
      aggregateId: menuItemId,
      tenantId: auth.tenantId,
      payload: {
        menuItemId,
        // null means the change applies to every branch.
        branchId,
        availability,
      },
    });
  }

  /**
   * Shapes an item for the wire, with the effective price and availability for
   * one branch already resolved.
   *
   * Resolution happens here rather than in the client so that every channel
   * gets the same answer, and so a client can never be handed a base price it
   * might display instead of the branch price.
   */
  private presentItem(
    item: {
      id: string;
      categoryId: string | null;
      name: string;
      nameLocalized: unknown;
      description: string | null;
      imageUrl: string | null;
      basePrice: Prisma.Decimal;
      currency: string;
      preparationTimeMinutes: number;
      availability: MenuItemAvailability;
      isActive: boolean;
      sortOrder: number;
      variants?: Array<{ id: string; name: string; price: Prisma.Decimal; isDefault: boolean }>;
      modifiers?: Array<{
        modifier: {
          id: string;
          name: string;
          selectionType: string;
          required: boolean;
          minSelections: number;
          maxSelections: number;
          isActive: boolean;
          options: Array<{
            id: string;
            name: string;
            priceDelta: Prisma.Decimal;
            isDefault: boolean;
            isAvailable: boolean;
          }>;
        };
      }>;
      overrides?: Array<{ price: Prisma.Decimal | null; availability: MenuItemAvailability | null }>;
    },
    branchId: string | null,
  ) {
    const itemLike = {
      id: item.id,
      basePrice: toMoneyString(item.basePrice),
      currency: item.currency,
      availability: item.availability,
      isActive: item.isActive,
    };

    const override = branchId
      ? (item.overrides?.[0] ?? null) && {
          price: item.overrides?.[0]?.price?.toString() ?? null,
          availability: item.overrides?.[0]?.availability ?? null,
        }
      : null;

    const effectiveAvailability = resolveAvailability(itemLike, override);
    const effectivePrice = resolvePrice(itemLike, override);

    return {
      id: item.id,
      categoryId: item.categoryId,
      name: item.name,
      nameLocalized: item.nameLocalized,
      description: item.description,
      imageUrl: item.imageUrl,
      currency: item.currency,
      preparationTimeMinutes: item.preparationTimeMinutes,
      sortOrder: item.sortOrder,
      isActive: item.isActive,

      /** Tenant-wide values, shown on management screens. */
      basePrice: toMoneyString(item.basePrice),
      baseAvailability: item.availability,

      /** What applies at the requested branch. Equal to the base with none. */
      price: effectivePrice.toDecimalString(),
      availability: effectiveAvailability,
      hasBranchOverride: Boolean(override),
      isVisible: isVisibleToCustomer(itemLike, override),

      variants:
        item.variants?.map((variant) => ({
          id: variant.id,
          name: variant.name,
          price: toMoneyString(variant.price),
          isDefault: variant.isDefault,
        })) ?? [],

      modifiers:
        item.modifiers
          ?.filter((link) => link.modifier.isActive)
          .map((link) => ({
            id: link.modifier.id,
            name: link.modifier.name,
            selectionType: link.modifier.selectionType,
            required: link.modifier.required,
            minSelections: link.modifier.minSelections,
            maxSelections: link.modifier.maxSelections,
            options: link.modifier.options.map((option) => ({
              id: option.id,
              name: option.name,
              priceDelta: toMoneyString(option.priceDelta),
              isDefault: option.isDefault,
              isAvailable: option.isAvailable,
            })),
          })) ?? [],
    };
  }
}
