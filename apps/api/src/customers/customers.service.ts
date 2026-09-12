import { Injectable } from '@nestjs/common';
import type { TransactionClient } from '@restaurant-os/database';
import { ConflictError, NotFoundError } from '@restaurant-os/domain';
import { AuditAction, type AuthContext, type Language } from '@restaurant-os/types';
import { AuditService } from '../audit/audit.service';
import { normalizePhone } from '../common/phone';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateAddressDto,
  CreateCustomerDto,
  ListCustomersDto,
  UpdateAddressDto,
  UpdateCustomerDto,
} from './customers.dto';

/**
 * Customer records and their addresses (ENGINEERING_SPEC.md 11, 50, 60).
 *
 * Customers are tenant-scoped: a person who orders from two restaurants on the
 * platform is two customer rows. That is intentional — one restaurant must not
 * be able to see that a number also orders from a competitor, and merging them
 * would make that leak inevitable.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findAll(auth: AuthContext, query: ListCustomersDto) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const where = query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { phone: { contains: query.search.replace(/\D/g, '') } },
            ],
          }
        : {};

      const [customers, total] = await Promise.all([
        tx.customer.findMany({
          where,
          orderBy: { lastOrderAt: { sort: 'desc', nulls: 'last' } },
          take: query.limit ?? 50,
          skip: query.offset ?? 0,
          include: { addresses: { orderBy: { isDefault: 'desc' } } },
        }),
        tx.customer.count({ where }),
      ]);

      return { customers: customers.map((customer) => this.present(customer)), total };
    });
  }

  async findOne(auth: AuthContext, customerId: string) {
    const customer = await this.prisma.forTenant(auth.tenantId, (tx) =>
      tx.customer.findUnique({
        where: { id: customerId },
        include: { addresses: { orderBy: { isDefault: 'desc' } } },
      }),
    );

    if (!customer) throw new NotFoundError('Customer', customerId);
    return this.present(customer);
  }

  async create(auth: AuthContext, input: CreateCustomerDto) {
    const phone = normalizePhone(input.phone);

    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const duplicate = await tx.customer.findFirst({ where: { phone } });
      if (duplicate) {
        throw new ConflictError('A customer with that phone number already exists');
      }

      const customer = await tx.customer.create({
        data: {
          tenantId: auth.tenantId,
          name: input.name ?? null,
          phone,
          whatsappNumber: input.whatsappNumber ? normalizePhone(input.whatsappNumber) : phone,
          email: input.email ?? null,
          preferredLanguage: (input.preferredLanguage ?? 'EN') as Language,
          notes: input.notes ?? null,
        },
        include: { addresses: true },
      });

      await this.audit.recordIn(tx, {
        action: AuditAction.CREATE,
        entityType: 'Customer',
        entityId: customer.id,
        tenantId: auth.tenantId,
        newValues: { phone: customer.phone, name: customer.name },
      });

      return this.present(customer);
    });
  }

  async update(auth: AuthContext, customerId: string, input: UpdateCustomerDto) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const existing = await tx.customer.findUnique({ where: { id: customerId } });
      if (!existing) throw new NotFoundError('Customer', customerId);

      // The phone number is the identity key, so a change has to stay unique.
      const phone = input.phone ? normalizePhone(input.phone) : undefined;
      if (phone && phone !== existing.phone) {
        const duplicate = await tx.customer.findFirst({
          where: { phone, id: { not: customerId } },
        });
        if (duplicate) {
          throw new ConflictError('Another customer already uses that phone number');
        }
      }

      const customer = await tx.customer.update({
        where: { id: customerId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(phone !== undefined ? { phone } : {}),
          ...(input.whatsappNumber !== undefined
            ? { whatsappNumber: input.whatsappNumber ? normalizePhone(input.whatsappNumber) : null }
            : {}),
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.preferredLanguage !== undefined
            ? { preferredLanguage: input.preferredLanguage }
            : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.isBlocked !== undefined ? { isBlocked: input.isBlocked } : {}),
        },
        include: { addresses: { orderBy: { isDefault: 'desc' } } },
      });

      await this.audit.recordIn(tx, {
        action: AuditAction.UPDATE,
        entityType: 'Customer',
        entityId: customerId,
        tenantId: auth.tenantId,
        oldValues: { name: existing.name, phone: existing.phone, isBlocked: existing.isBlocked },
        newValues: { name: customer.name, phone: customer.phone, isBlocked: customer.isBlocked },
      });

      return this.present(customer);
    });
  }

  /**
   * Finds a customer by phone, creating one if this is their first order.
   *
   * Shared by every ordering channel, which is what keeps a WhatsApp customer
   * and a POS walk-in from becoming two records for one phone number. Runs
   * inside the caller's transaction so the customer and their order commit
   * together.
   */
  async findOrCreateInTransaction(
    tx: TransactionClient,
    tenantId: string,
    input: { phone: string; name?: string | null; preferredLanguage?: Language },
  ) {
    const phone = normalizePhone(input.phone);

    const existing = await tx.customer.findFirst({ where: { phone } });
    if (existing) {
      // Fill in a name we did not have before, but never overwrite one the
      // customer or staff already set.
      if (!existing.name && input.name) {
        return tx.customer.update({ where: { id: existing.id }, data: { name: input.name } });
      }
      return existing;
    }

    return tx.customer.create({
      data: {
        tenantId,
        phone,
        whatsappNumber: phone,
        name: input.name ?? null,
        ...(input.preferredLanguage ? { preferredLanguage: input.preferredLanguage } : {}),
      },
    });
  }

  // --- addresses ------------------------------------------------------------

  async addAddress(auth: AuthContext, customerId: string, input: CreateAddressDto) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id: customerId } });
      if (!customer) throw new NotFoundError('Customer', customerId);

      if (input.isDefault) {
        await tx.customerAddress.updateMany({ where: { customerId }, data: { isDefault: false } });
      }

      const existingCount = await tx.customerAddress.count({ where: { customerId } });

      return tx.customerAddress.create({
        data: {
          tenantId: auth.tenantId,
          customerId,
          label: input.label ?? null,
          address: input.address,
          city: input.city ?? null,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          notes: input.notes ?? null,
          // The first address a customer gives is their default, without
          // anyone having to say so.
          isDefault: input.isDefault ?? existingCount === 0,
        },
      });
    });
  }

  async updateAddress(auth: AuthContext, addressId: string, input: UpdateAddressDto) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const existing = await tx.customerAddress.findUnique({ where: { id: addressId } });
      if (!existing) throw new NotFoundError('Address', addressId);

      if (input.isDefault) {
        await tx.customerAddress.updateMany({
          where: { customerId: existing.customerId, id: { not: addressId } },
          data: { isDefault: false },
        });
      }

      return tx.customerAddress.update({
        where: { id: addressId },
        data: {
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.address !== undefined ? { address: input.address } : {}),
          ...(input.city !== undefined ? { city: input.city } : {}),
          ...(input.latitude !== undefined ? { latitude: input.latitude } : {}),
          ...(input.longitude !== undefined ? { longitude: input.longitude } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
        },
      });
    });
  }

  async removeAddress(auth: AuthContext, addressId: string) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const existing = await tx.customerAddress.findUnique({ where: { id: addressId } });
      if (!existing) throw new NotFoundError('Address', addressId);

      // Past orders keep their own snapshotted address text, so removing this
      // row does not disturb them (the FK is ON DELETE SET NULL).
      await tx.customerAddress.delete({ where: { id: addressId } });
      return { deleted: true };
    });
  }

  /** Orders placed by one customer, newest first. */
  async findOrders(auth: AuthContext, customerId: string, limit = 20) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id: customerId } });
      if (!customer) throw new NotFoundError('Customer', customerId);

      return tx.order.findMany({
        where: {
          customerId,
          // A branch-scoped user sees only their own branch's orders (spec 7).
          ...(auth.branchIds === null ? {} : { branchId: { in: auth.branchIds } }),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          paymentStatus: true,
          orderType: true,
          total: true,
          currency: true,
          createdAt: true,
        },
      });
    });
  }

  private present(customer: {
    id: string;
    name: string | null;
    phone: string;
    whatsappNumber: string | null;
    email: string | null;
    preferredLanguage: string;
    totalOrders: number;
    totalSpend: { toString: () => string };
    firstOrderAt: Date | null;
    lastOrderAt: Date | null;
    isBlocked: boolean;
    notes: string | null;
    addresses?: unknown[];
  }) {
    return {
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      whatsappNumber: customer.whatsappNumber,
      email: customer.email,
      preferredLanguage: customer.preferredLanguage,
      totalOrders: customer.totalOrders,
      totalSpend: customer.totalSpend.toString(),
      firstOrderAt: customer.firstOrderAt,
      lastOrderAt: customer.lastOrderAt,
      isBlocked: customer.isBlocked,
      notes: customer.notes,
      addresses: customer.addresses ?? [],
    };
  }
}
