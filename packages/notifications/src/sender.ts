import {
  Prisma,
  withTenantContext,
  type PrismaClient,
  type TransactionClient,
} from '@restaurant-os/database';
import {
  hasAttemptsLeft,
  nextRetryAt,
  notificationSpecByTemplateKey,
  renderMessageBody,
  resolveWhatsAppSendMode,
  templateVariables,
  type MessageVariables,
} from '@restaurant-os/domain';
import { ChannelSendError, type ChannelSendRequest } from './channel';
import type { NotificationChannelRegistry } from './registry';
import {
  ConsentStatus,
  Language,
  MessageDirection,
  NotificationChannel,
  NotificationStatus,
  WhatsAppSendMode,
  WhatsAppTemplateCategory,
} from '@restaurant-os/types';
import type { OutboundMessage, WhatsAppCredentials } from '@restaurant-os/whatsapp';
import type { Logger } from 'pino';

/** Provider language tags, from our enum. */
const LANGUAGE_TAGS: Record<string, string> = { EN: 'en', UR: 'ur', ROMAN_UR: 'en' };

/**
 * Sends the notifications the dispatcher queued (ENGINEERING_SPEC.md 32).
 *
 * The half of the notification pipeline that is allowed to fail. Everything it
 * touches has already been committed: the order exists, the event exists, the
 * notification row exists. So a provider being hard-down costs a delay and
 * nothing else, which is invariant 8 stated as a schedule rather than as a
 * promise.
 *
 * Retry is exponential with full jitter, capped, and bounded by a maximum
 * attempt count — all of it in @restaurant-os/domain, so the policy is unit
 * tested without a provider, a queue or a clock.
 *
 * ## Suppression is not failure
 *
 * A message that the rules forbid — a closed 24-hour window with no approved
 * template, or marketing without opt-in — is recorded as SUPPRESSED with a
 * reason, not as an error. Nothing broke; the policy said no, and a restaurant
 * looking at their dashboard needs to see *which* policy so they can fix it.
 */
export class NotificationSender {
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    /** Worker role: may read only the three scheduling columns (migration 0800). */
    private readonly workerPrisma: PrismaClient,
    /** Application role: everything else, under RLS. */
    private readonly appPrisma: PrismaClient,
    private readonly channels: NotificationChannelRegistry,
    private readonly logger: Logger,
    private readonly options: { pollMs: number; batchSize: number; staleClaimMs: number },
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(0);
    this.logger.info({ pollMs: this.options.pollMs }, 'Notification sender started');
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      const sent = await this.sendOnce();
      this.scheduleNext(sent >= this.options.batchSize ? 0 : this.options.pollMs);
    } catch (error) {
      this.logger.error({ err: error }, 'Notification send pass failed; retrying');
      this.scheduleNext(this.options.pollMs);
    }
  }

  /** One pass over every tenant that has work. Returns notifications attempted. */
  async sendOnce(): Promise<number> {
    const tenantIds = await this.tenantsWithWork();
    if (tenantIds.length === 0) return 0;

    let attempted = 0;
    for (const tenantId of tenantIds) {
      attempted += await this.sendForTenant(tenantId);
    }
    return attempted;
  }

  /**
   * Which tenants have a notification due.
   *
   * A raw query against three columns, because those three are all the worker
   * role is granted — `SELECT destination FROM notifications` is refused to it
   * at the database (migration 20260901000800). So the background process
   * learns that tenant X has work without ever being able to read what the
   * message says or who it is for.
   */
  private async tenantsWithWork(): Promise<string[]> {
    const now = new Date();
    const stale = new Date(now.getTime() - this.options.staleClaimMs);

    const rows = await this.workerPrisma.$queryRaw<Array<{ tenant_id: string }>>`
      SELECT DISTINCT tenant_id
      FROM notifications
      WHERE (status = 'PENDING' AND next_attempt_at <= ${now})
         OR (status = 'PROCESSING' AND next_attempt_at <= ${stale})
      LIMIT 100
    `;

    return rows.map((row) => row.tenant_id);
  }

  private async sendForTenant(tenantId: string): Promise<number> {
    const due = await withTenantContext(this.appPrisma, tenantId, (tx) =>
      tx.notification.findMany({
        where: {
          OR: [
            { status: NotificationStatus.PENDING, nextAttemptAt: { lte: new Date() } },
            {
              // Reclaim a row whose worker died mid-send. Without this it would
              // sit in PROCESSING forever, which looks exactly like a message
              // that is about to arrive and never does.
              status: NotificationStatus.PROCESSING,
              nextAttemptAt: { lte: new Date(Date.now() - this.options.staleClaimMs) },
            },
          ],
        },
        orderBy: { nextAttemptAt: 'asc' },
        take: this.options.batchSize,
        select: { id: true, status: true },
      }),
    );

    let attempted = 0;
    for (const candidate of due) {
      const claimed = await this.claim(tenantId, candidate.id, candidate.status);
      if (!claimed) continue;
      await this.deliver(tenantId, candidate.id);
      attempted += 1;
    }
    return attempted;
  }

  /**
   * Takes exclusive ownership of one notification.
   *
   * A conditional update whose row count is the answer, the same unique-claim
   * technique the idempotency middleware uses: two workers racing for the same
   * row both issue the update, exactly one changes a row, and the loser sees
   * zero and moves on. No lock, no lease table.
   */
  private async claim(tenantId: string, id: string, fromStatus: string): Promise<boolean> {
    const result = await withTenantContext(this.appPrisma, tenantId, (tx) =>
      tx.notification.updateMany({
        where: { id, status: fromStatus as NotificationStatus },
        data: { status: NotificationStatus.PROCESSING, attempts: { increment: 1 } },
      }),
    );
    return result.count === 1;
  }

  private async deliver(tenantId: string, id: string): Promise<void> {
    try {
      await withTenantContext(
        this.appPrisma,
        tenantId,
        async (tx) => {
          const notification = await tx.notification.findUnique({ where: { id } });
          if (!notification) return;

          const variables = readVariables(notification.payload);
          const body = renderMessageBody(notification.templateKey, variables);

          const request: ChannelSendRequest = {
            destination: notification.destination ?? '',
            body,
            templateKey: notification.templateKey,
          };

          const adapter = this.channels.get(notification.channel);
          if (!adapter) {
            await this.suppress(
              tx,
              notification.id,
              notification,
              `No adapter is configured for the ${notification.channel} channel`,
            );
            return;
          }

          if (notification.channel === NotificationChannel.WHATSAPP) {
            const resolved = await this.resolveWhatsApp(tx, tenantId, notification, body, variables);
            if ('suppressed' in resolved) {
              await this.suppress(tx, notification.id, notification, resolved.suppressed);
              return;
            }
            request.whatsapp = resolved.whatsapp;
          }

          if (!request.destination) {
            await this.suppress(
              tx,
              notification.id,
              notification,
              'No destination on record for this recipient',
            );
            return;
          }

          const result = await adapter.send(request);

          await tx.notification.update({
            where: { id: notification.id },
            data: {
              status: NotificationStatus.SENT,
              sentAt: new Date(),
              nextAttemptAt: null,
              lastError: null,
              providerMessageId: result.providerMessageId ?? null,
            },
          });

          if (notification.channel === NotificationChannel.WHATSAPP && request.whatsapp) {
            await this.recordOutboundMessage(tx, tenantId, notification, request, result.providerMessageId ?? null, body);
          }
        },
        // A provider call happens inside this transaction, so it needs longer
        // than the default. The alternative — sending outside a transaction —
        // would mean a crash after the send but before the update retries a
        // message the customer already received.
        { timeout: 30_000 },
      );
    } catch (error) {
      await this.recordFailure(tenantId, id, error);
    }
  }

  /**
   * Works out how this WhatsApp message may be sent, if at all.
   *
   * All of the actual policy lives in @restaurant-os/domain; this only gathers
   * the four facts that policy needs — is a number connected, when did this
   * contact last message us, is there an approved template, and is there
   * marketing consent — and then carries out the verdict.
   */
  private async resolveWhatsApp(
    tx: TransactionClient,
    tenantId: string,
    notification: {
      id: string;
      branchId: string | null;
      destination: string | null;
      templateKey: string;
      recipientId: string;
      recipientType: string;
    },
    body: string,
    variables: MessageVariables,
  ): Promise<
    | { whatsapp: NonNullable<ChannelSendRequest['whatsapp']> }
    | { suppressed: string }
  > {
    const accounts = await tx.whatsAppAccount.findMany({
      where: { tenantId, isActive: true },
    });

    // A branch's own number wins over the tenant-wide one, so a chain that runs
    // a number per outlet has customers replying to the outlet they ordered
    // from.
    const account =
      accounts.find((row) => row.branchId === notification.branchId) ??
      accounts.find((row) => row.branchId === null) ??
      null;

    if (!account) {
      return {
        suppressed:
          'No WhatsApp Business number is connected for this branch. Connect one in Settings.',
      };
    }

    const destination = notification.destination ?? '';
    const spec = notificationSpecByTemplateKey(notification.templateKey);
    const category = spec?.category ?? WhatsAppTemplateCategory.UTILITY;

    const language = await this.recipientLanguage(tx, notification);

    const template = await tx.whatsAppTemplate.findFirst({
      where: { accountId: account.id, templateKey: notification.templateKey, language },
    });

    const lastInbound = await tx.whatsAppMessage.findFirst({
      where: { tenantId, contactNumber: destination, direction: MessageDirection.INBOUND },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    });

    const consent =
      category === WhatsAppTemplateCategory.MARKETING
        ? await tx.customerConsent.findFirst({
            where: {
              customerId: notification.recipientId,
              channel: NotificationChannel.WHATSAPP,
              purpose: 'MARKETING',
            },
            select: { status: true },
          })
        : null;

    const decision = resolveWhatsAppSendMode({
      now: new Date(),
      lastInboundAt: lastInbound?.occurredAt ?? null,
      category,
      templateStatus: template?.status ?? null,
      marketingConsent: (consent?.status as ConsentStatus | undefined) ?? null,
    });

    if (decision.mode === null) return { suppressed: decision.reason };

    const message: OutboundMessage =
      decision.mode === WhatsAppSendMode.SESSION
        ? { mode: WhatsAppSendMode.SESSION, kind: 'text', to: destination, body }
        : {
            mode: WhatsAppSendMode.TEMPLATE,
            kind: 'template',
            to: destination,
            templateName: template!.providerName,
            language: LANGUAGE_TAGS[language] ?? 'en',
            variables: templateVariables(notification.templateKey, variables),
            renderedBody: body,
          };

    return {
      whatsapp: {
        providerName: account.provider,
        message,
        credentials: {
          ...(account.credentials as Record<string, unknown>),
          phoneNumberId: account.phoneNumberId,
        } as WhatsAppCredentials,
      },
    };
  }

  /** A customer's chosen language; staff alerts stay in English. */
  private async recipientLanguage(
    tx: TransactionClient,
    notification: { recipientType: string; recipientId: string },
  ): Promise<Language> {
    if (notification.recipientType !== 'CUSTOMER') return Language.EN;
    const customer = await tx.customer.findUnique({
      where: { id: notification.recipientId },
      select: { preferredLanguage: true },
    });
    return (customer?.preferredLanguage as Language | undefined) ?? Language.EN;
  }

  /**
   * Logs what was sent against the conversation.
   *
   * Not bookkeeping. These rows are what make the 24-hour service window
   * computable, and what a delivery callback matches on when it arrives quoting
   * a provider message id.
   */
  private async recordOutboundMessage(
    tx: TransactionClient,
    tenantId: string,
    notification: { recipientType: string; recipientId: string; templateKey: string; destination: string | null },
    request: ChannelSendRequest,
    providerMessageId: string | null,
    body: string,
  ): Promise<void> {
    const whatsapp = request.whatsapp!;
    const account = await tx.whatsAppAccount.findFirst({
      where: { phoneNumberId: whatsapp.credentials.phoneNumberId },
      select: { id: true },
    });
    if (!account) return;

    await tx.whatsAppMessage.createMany({
      data: [
        {
          tenantId,
          accountId: account.id,
          customerId: notification.recipientType === 'CUSTOMER' ? notification.recipientId : null,
          contactNumber: notification.destination ?? '',
          direction: MessageDirection.OUTBOUND,
          sendMode: whatsapp.message.mode,
          providerMessageId,
          templateKey: notification.templateKey,
          body,
          status: 'accepted',
        },
      ],
      skipDuplicates: true,
    });
  }

  /**
   * Records a notification the rules would not allow, and tries the next
   * channel.
   *
   * The promotion matters. A spec like `order_ready` lists WhatsApp first and
   * SMS after it, and if WhatsApp is unusable — no number connected, or a
   * closed window with no approved template — then stopping here would mean the
   * customer simply never hears. So the next channel in the spec gets a row of
   * its own. The unique constraint makes that safe to repeat.
   */
  private async suppress(
    tx: TransactionClient,
    id: string,
    notification: {
      tenantId: string;
      branchId: string | null;
      eventId: string;
      eventType: string;
      recipientType: string;
      recipientId: string;
      channel: string;
      templateKey: string;
      destination: string | null;
      payload: Prisma.JsonValue;
    },
    reason: string,
  ): Promise<void> {
    await tx.notification.update({
      where: { id },
      data: {
        status: NotificationStatus.SUPPRESSED,
        suppressedReason: reason,
        nextAttemptAt: null,
      },
    });

    const spec = notificationSpecByTemplateKey(notification.templateKey);
    if (!spec || spec.deliveryMode !== 'first-available') return;

    const index = spec.channels.indexOf(notification.channel as NotificationChannel);
    const next = index >= 0 ? spec.channels[index + 1] : undefined;
    if (!next) return;

    const adapter = this.channels.get(next);
    if (!adapter) return;

    await tx.notification.createMany({
      data: [
        {
          tenantId: notification.tenantId,
          branchId: notification.branchId,
          eventId: notification.eventId,
          eventType: notification.eventType,
          recipientType: notification.recipientType as never,
          recipientId: notification.recipientId,
          // The fallback channel uses the plain phone number: whatsappNumber is
          // specific to WhatsApp and may not receive SMS.
          destination: await this.fallbackDestination(tx, notification),
          channel: next,
          templateKey: notification.templateKey,
          payload: notification.payload as Prisma.InputJsonValue,
          status: NotificationStatus.PENDING,
          nextAttemptAt: new Date(),
        },
      ],
      skipDuplicates: true,
    });

    this.logger.info(
      { notificationId: id, from: notification.channel, to: next, reason },
      'Notification suppressed; promoted to the next channel',
    );
  }

  private async fallbackDestination(
    tx: TransactionClient,
    notification: { recipientType: string; recipientId: string; destination: string | null },
  ): Promise<string | null> {
    if (notification.recipientType !== 'CUSTOMER') return notification.destination;
    const customer = await tx.customer.findUnique({
      where: { id: notification.recipientId },
      select: { phone: true },
    });
    return customer?.phone ?? notification.destination;
  }

  /**
   * Applies the outcome of a failed attempt.
   *
   * Runs in its own transaction because the one that failed may already be
   * rolled back. `attempts` was incremented at claim time, so a crash between
   * claiming and here still counts against the budget rather than letting a
   * consistently-crashing notification retry forever.
   */
  private async recordFailure(tenantId: string, id: string, error: unknown): Promise<void> {
    const retryable = error instanceof ChannelSendError ? error.retryable : true;
    const message = error instanceof Error ? error.message : String(error);

    try {
      await withTenantContext(this.appPrisma, tenantId, async (tx) => {
        const notification = await tx.notification.findUnique({
          where: { id },
          select: { attempts: true },
        });
        if (!notification) return;

        const retryAt = retryable ? nextRetryAt(notification.attempts, new Date()) : null;
        const givingUp = retryAt === null;

        await tx.notification.update({
          where: { id },
          data: {
            status: givingUp ? NotificationStatus.FAILED : NotificationStatus.PENDING,
            nextAttemptAt: retryAt,
            lastError: message.slice(0, 500),
            ...(givingUp ? { failedAt: new Date() } : {}),
          },
        });

        this.logger[givingUp ? 'error' : 'warn'](
          {
            notificationId: id,
            attempts: notification.attempts,
            retryable,
            retryAt,
            attemptsLeft: hasAttemptsLeft(notification.attempts),
          },
          givingUp ? 'Notification failed permanently' : 'Notification failed; will retry',
        );
      });
    } catch (updateError) {
      this.logger.error(
        { err: updateError, notificationId: id },
        'Could not record a notification failure',
      );
    }
  }
}

/** The variables the dispatcher stored, which are untyped JSON on the way back. */
function readVariables(payload: Prisma.JsonValue): MessageVariables {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { orderNumber: '', restaurantName: '' };
  }
  const variables = (payload as Record<string, unknown>).variables;
  if (typeof variables !== 'object' || variables === null) {
    return { orderNumber: '', restaurantName: '' };
  }
  return variables as MessageVariables;
}
