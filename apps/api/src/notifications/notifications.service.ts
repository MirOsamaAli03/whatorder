import { Injectable } from '@nestjs/common';
import { Prisma, type TransactionClient } from '@restaurant-os/database';
import { ConflictError, NotFoundError } from '@restaurant-os/domain';
import {
  AuditAction,
  ConsentStatus,
  NotificationChannel,
  RecipientType,
  WhatsAppTemplateStatus,
  type AuthContext,
} from '@restaurant-os/types';
import { AuditService } from '../audit/audit.service';
import { normalizePhone } from '../common/phone';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateWhatsAppAccountDto,
  CreateWhatsAppTemplateDto,
  ListNotificationsDto,
  RecordConsentDto,
  UpdatePreferencesDto,
  UpdateWhatsAppAccountDto,
  UpdateWhatsAppTemplateDto,
} from './notifications.dto';

/**
 * Notification settings and history (ENGINEERING_SPEC.md 30, 31; plan 2.2).
 *
 * The API's half of Phase 5. Everything here is configuration and
 * visibility — what a restaurant sets up, and what they can see afterwards.
 * Nothing here sends anything: that is the worker's job, on its own schedule,
 * for the reason invariant 8 exists.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  /**
   * What was sent, to whom, and what happened.
   *
   * The support view. A SUPPRESSED row with its reason is the most useful thing
   * on it: "the 24-hour window is closed and your template is still PENDING" is
   * an answer a restaurant can act on, where silence is not.
   */
  async findAll(auth: AuthContext, query: ListNotificationsDto) {
    const rows = await this.prisma.forTenant(auth.tenantId, (tx) =>
      tx.notification.findMany({
        where: {
          ...(query.status ? { status: query.status } : {}),
          ...(query.channel ? { channel: query.channel } : {}),
          ...(query.branchId ? { branchId: query.branchId } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: query.limit ?? 50,
        skip: query.offset ?? 0,
      }),
    );

    return rows.map((row) => ({
      id: row.id,
      branchId: row.branchId,
      eventType: row.eventType,
      recipientType: row.recipientType,
      recipientId: row.recipientId,
      destination: row.destination,
      channel: row.channel,
      templateKey: row.templateKey,
      status: row.status,
      attempts: row.attempts,
      nextAttemptAt: row.nextAttemptAt,
      lastError: row.lastError,
      suppressedReason: row.suppressedReason,
      createdAt: row.createdAt,
      sentAt: row.sentAt,
      deliveredAt: row.deliveredAt,
      failedAt: row.failedAt,
    }));
  }

  // -------------------------------------------------------------------------
  // Preferences
  // -------------------------------------------------------------------------

  /**
   * Every channel, with the tenant's choice applied.
   *
   * Absent rows are returned as enabled rather than omitted, because a settings
   * screen has to render the whole grid and "no row" and "enabled" mean the
   * same thing to the dispatcher.
   */
  async findPreferences(auth: AuthContext) {
    const stored = await this.prisma.forTenant(auth.tenantId, (tx) =>
      tx.notificationPreference.findMany(),
    );

    const result: Array<{
      recipientType: RecipientType;
      channel: NotificationChannel;
      enabled: boolean;
    }> = [];

    for (const recipientType of Object.values(RecipientType)) {
      for (const channel of Object.values(NotificationChannel)) {
        const row = stored.find(
          (preference) =>
            preference.recipientType === recipientType && preference.channel === channel,
        );
        result.push({ recipientType, channel, enabled: row?.enabled ?? true });
      }
    }

    return result;
  }

  async updatePreferences(auth: AuthContext, body: UpdatePreferencesDto) {
    await this.prisma.forTenant(auth.tenantId, async (tx) => {
      for (const preference of body.preferences) {
        await tx.notificationPreference.upsert({
          where: {
            tenantId_recipientType_channel: {
              tenantId: auth.tenantId,
              recipientType: preference.recipientType,
              channel: preference.channel,
            },
          },
          create: { tenantId: auth.tenantId, ...preference },
          update: { enabled: preference.enabled },
        });
      }

      await this.audit.recordIn(tx, {
        action: AuditAction.UPDATE,
        entityType: 'NotificationPreference',
        entityId: auth.tenantId,
        tenantId: auth.tenantId,
        newValues: { preferences: body.preferences },
      });
    });

    return this.findPreferences(auth);
  }

  // -------------------------------------------------------------------------
  // WhatsApp accounts
  // -------------------------------------------------------------------------

  async findAccounts(auth: AuthContext) {
    const accounts = await this.prisma.forTenant(auth.tenantId, (tx) =>
      tx.whatsAppAccount.findMany({ orderBy: { createdAt: 'asc' } }),
    );
    return accounts.map((account) => this.presentAccount(account));
  }

  async createAccount(auth: AuthContext, body: CreateWhatsAppAccountDto) {
    const account = await this.prisma.forTenant(auth.tenantId, async (tx) => {
      if (body.branchId) await this.assertBranch(tx, body.branchId);

      /**
       * `phone_number_id` is globally unique, because routing an inbound
       * webhook depends on exactly one tenant owning it: two tenants claiming
       * one number would send one restaurant's orders to the other.
       *
       * Enforced by catching the constraint rather than by checking first.
       * A check could not see the conflicting row anyway — RLS correctly hides
       * another tenant's account from this connection — so the only place the
       * truth exists is the unique index. That also makes it race-free, where a
       * read-then-write would not be.
       */
      const created = await tx.whatsAppAccount
        .create({
          data: {
            tenantId: auth.tenantId,
            branchId: body.branchId ?? null,
            phoneNumberId: body.phoneNumberId,
            displayNumber: normalizePhone(body.displayNumber),
            wabaId: body.wabaId ?? null,
            provider: body.provider,
            credentials: (body.credentials ?? {}) as never,
          },
        })
        .catch((error: unknown) => {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          ) {
            throw new ConflictError(
              'That WhatsApp number is already connected to an organization',
            );
          }
          throw error;
        });

      await this.audit.recordIn(tx, {
        action: AuditAction.CREATE,
        entityType: 'WhatsAppAccount',
        entityId: created.id,
        tenantId: auth.tenantId,
        // Credentials are deliberately absent: an audit log that records a
        // provider access token is a credential store nobody meant to build.
        newValues: {
          phoneNumberId: created.phoneNumberId,
          displayNumber: created.displayNumber,
          provider: created.provider,
        },
      });

      return created;
    });

    return this.presentAccount(account);
  }

  async updateAccount(auth: AuthContext, id: string, body: UpdateWhatsAppAccountDto) {
    const account = await this.prisma.forTenant(auth.tenantId, async (tx) => {
      const current = await tx.whatsAppAccount.findUnique({ where: { id } });
      if (!current) throw new NotFoundError('WhatsApp account not found');
      if (body.branchId) await this.assertBranch(tx, body.branchId);

      const updated = await tx.whatsAppAccount.update({
        where: { id },
        data: {
          ...(body.displayNumber ? { displayNumber: normalizePhone(body.displayNumber) } : {}),
          ...(body.wabaId !== undefined ? { wabaId: body.wabaId } : {}),
          ...(body.branchId !== undefined ? { branchId: body.branchId } : {}),
          ...(body.provider ? { provider: body.provider } : {}),
          ...(body.credentials ? { credentials: body.credentials as never } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        },
      });

      await this.audit.recordIn(tx, {
        action: AuditAction.UPDATE,
        entityType: 'WhatsAppAccount',
        entityId: id,
        tenantId: auth.tenantId,
        oldValues: { provider: current.provider, isActive: current.isActive },
        newValues: { provider: updated.provider, isActive: updated.isActive },
      });

      return updated;
    });

    return this.presentAccount(account);
  }

  // -------------------------------------------------------------------------
  // WhatsApp templates
  // -------------------------------------------------------------------------

  async findTemplates(auth: AuthContext) {
    const templates = await this.prisma.forTenant(auth.tenantId, (tx) =>
      tx.whatsAppTemplate.findMany({ orderBy: [{ templateKey: 'asc' }, { language: 'asc' }] }),
    );
    return templates;
  }

  async createTemplate(auth: AuthContext, body: CreateWhatsAppTemplateDto) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const account = await tx.whatsAppAccount.findUnique({ where: { id: body.accountId } });
      if (!account) throw new NotFoundError('WhatsApp account not found');

      const template = await tx.whatsAppTemplate.create({
        data: {
          tenantId: auth.tenantId,
          accountId: body.accountId,
          templateKey: body.templateKey,
          providerName: body.providerName,
          language: body.language,
          category: body.category,
          body: body.body,
          // DRAFT, not APPROVED. Only the provider can approve a template, and
          // a template we marked approved ourselves would be attempted and
          // rejected at send time — once per retry.
          status: WhatsAppTemplateStatus.DRAFT,
        },
      });

      await this.audit.recordIn(tx, {
        action: AuditAction.CREATE,
        entityType: 'WhatsAppTemplate',
        entityId: template.id,
        tenantId: auth.tenantId,
        newValues: { templateKey: template.templateKey, language: template.language },
      });

      return template;
    });
  }

  async updateTemplate(auth: AuthContext, id: string, body: UpdateWhatsAppTemplateDto) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const current = await tx.whatsAppTemplate.findUnique({ where: { id } });
      if (!current) throw new NotFoundError('WhatsApp template not found');

      const updated = await tx.whatsAppTemplate.update({
        where: { id },
        data: {
          ...(body.status ? { status: body.status } : {}),
          ...(body.rejectionReason !== undefined
            ? { rejectionReason: body.rejectionReason }
            : {}),
          ...(body.providerName ? { providerName: body.providerName } : {}),
          ...(body.body ? { body: body.body } : {}),
          ...(body.status === WhatsAppTemplateStatus.APPROVED ? { approvedAt: new Date() } : {}),
        },
      });

      await this.audit.recordIn(tx, {
        action: AuditAction.UPDATE,
        entityType: 'WhatsAppTemplate',
        entityId: id,
        tenantId: auth.tenantId,
        oldValues: { status: current.status },
        newValues: { status: updated.status, rejectionReason: updated.rejectionReason },
      });

      return updated;
    });
  }

  // -------------------------------------------------------------------------
  // Consent
  // -------------------------------------------------------------------------

  async findConsents(auth: AuthContext, customerId: string) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id: customerId } });
      if (!customer) throw new NotFoundError('Customer not found');
      return tx.customerConsent.findMany({ where: { customerId } });
    });
  }

  /**
   * Records consent, or its withdrawal.
   *
   * Both timestamps are kept rather than overwritten, because the useful
   * question is usually "were we allowed to send that, at the time we sent it"
   * and a single mutable boolean cannot answer it.
   */
  async recordConsent(auth: AuthContext, customerId: string, body: RecordConsentDto) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id: customerId } });
      if (!customer) throw new NotFoundError('Customer not found');

      const now = new Date();
      const granted = body.status === ConsentStatus.GRANTED;

      const consent = await tx.customerConsent.upsert({
        where: {
          customerId_channel_purpose: {
            customerId,
            channel: body.channel,
            purpose: body.purpose,
          },
        },
        create: {
          tenantId: auth.tenantId,
          customerId,
          channel: body.channel,
          purpose: body.purpose,
          status: body.status,
          source: body.source,
          evidence: body.evidence ?? null,
          grantedAt: granted ? now : null,
          revokedAt: granted ? null : now,
        },
        update: {
          status: body.status,
          source: body.source,
          evidence: body.evidence ?? null,
          ...(granted ? { grantedAt: now } : { revokedAt: now }),
        },
      });

      await this.audit.recordIn(tx, {
        action: AuditAction.UPDATE,
        entityType: 'CustomerConsent',
        entityId: consent.id,
        tenantId: auth.tenantId,
        newValues: {
          customerId,
          channel: consent.channel,
          purpose: consent.purpose,
          status: consent.status,
          source: consent.source,
        },
      });

      return consent;
    });
  }

  // -------------------------------------------------------------------------

  private async assertBranch(tx: TransactionClient, branchId: string): Promise<void> {
    const branch = await tx.branch.findUnique({ where: { id: branchId } });
    if (!branch) throw new NotFoundError('Branch not found');
  }

  /**
   * Everything about an account except its credentials.
   *
   * They are never returned by any read endpoint. A settings page that displays
   * a provider access token is one screenshot away from leaking it, and nothing
   * in the UI needs the value — only whether one has been set.
   */
  private presentAccount(account: {
    id: string;
    branchId: string | null;
    phoneNumberId: string;
    displayNumber: string;
    wabaId: string | null;
    provider: string;
    credentials: unknown;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
  }) {
    const credentials = (account.credentials ?? {}) as Record<string, unknown>;

    return {
      id: account.id,
      branchId: account.branchId,
      phoneNumberId: account.phoneNumberId,
      displayNumber: account.displayNumber,
      wabaId: account.wabaId,
      provider: account.provider,
      hasCredentials: Object.keys(credentials).length > 0,
      isActive: account.isActive,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }
}
