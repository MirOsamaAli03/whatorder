import { Inject, Injectable, Logger } from '@nestjs/common';
import type { TransactionClient } from '@restaurant-os/database';
import { MessageDirection, NotificationStatus } from '@restaurant-os/types';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';

const PROVIDER = 'whatsapp';

/** One thing worth acting on, pulled out of a provider payload. */
interface ParsedItem {
  /** Stable per-provider id, for replay protection. */
  providerEventId: string;
  eventType: 'message' | 'status';
  phoneNumberId: string;
  /** The customer's number, as the provider gives it (no leading +). */
  contact: string;
  occurredAt: Date;
  /** Messages only. */
  messageId?: string;
  body?: string;
  /** Statuses only. */
  messageRef?: string;
  status?: string;
  error?: string;
  raw: Record<string, unknown>;
}

/**
 * Inbound WhatsApp webhooks (ENGINEERING_SPEC.md 68; plan 2.2).
 *
 * Phase 5's half of the channel: **delivery-status callbacks**, and recording
 * inbound messages. Conversational ordering — reading a message and replying
 * with a menu — is Phase 6 and deliberately not here.
 *
 * Recording inbound messages is not, however, optional at this stage. The
 * 24-hour customer service window is computed from the timestamp of a contact's
 * most recent inbound message, so without these rows every outbound message
 * would look as though the window were closed and would need an approved
 * template. The rows are the mechanism, not a log.
 *
 * ## Routing
 *
 * Meta's webhook is per-app, not per-tenant: every restaurant's callbacks
 * arrive here. The `phone_number_id` is the only thing identifying whose they
 * are, and resolving it necessarily crosses tenants — so it goes through the
 * `app_whatsapp_account_route` SECURITY DEFINER function, which returns routing
 * fields and nothing else. Everything after that runs in the resolved tenant's
 * RLS context.
 */
@Injectable()
export class WhatsAppWebhookService {
  private readonly logger = new Logger(WhatsAppWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Verifies Meta's `X-Hub-Signature-256` over the raw body.
   *
   * The raw bytes matter: re-serialising the parsed JSON would produce a
   * different byte sequence and a signature that never matches.
   *
   * A forged callback could mark a message delivered that was never sent, or —
   * once Phase 6 lands — inject a message that appears to come from a customer.
   * So an unverifiable request is rejected. With no secret configured the check
   * is skipped, which is the development default and is logged as a warning so
   * it cannot pass unnoticed into a deployment.
   */
  verifySignature(rawBody: Buffer | string | undefined, header: string | undefined): boolean {
    const secret = this.env.WHATSAPP_WEBHOOK_SECRET;

    if (!secret) {
      this.logger.warn(
        'WHATSAPP_WEBHOOK_SECRET is not set; accepting an unverified WhatsApp webhook. ' +
          'Set it before connecting a real number.',
      );
      return true;
    }

    if (!rawBody || !header) return false;

    const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    const received = Buffer.from(header);
    const computed = Buffer.from(expected);

    // Length check first: timingSafeEqual throws on a mismatch rather than
    // returning false.
    if (received.length !== computed.length) return false;
    return timingSafeEqual(received, computed);
  }

  /** Meta's one-time subscription handshake. */
  verifyChallenge(mode: string | undefined, token: string | undefined): boolean {
    const expected = this.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    return mode === 'subscribe' && Boolean(expected) && token === expected;
  }

  /**
   * Handles one webhook body.
   *
   * Always resolves. A provider that receives anything but a 200 will retry,
   * and retrying a payload we could not parse the first time does not help —
   * it is recorded instead, with its error, where somebody can look at it.
   */
  async handle(payload: unknown): Promise<{ accepted: number; ignored: number }> {
    const items = parseWebhook(payload);
    let accepted = 0;
    let ignored = 0;

    for (const item of items) {
      try {
        const handled = await this.handleItem(item);
        if (handled) accepted += 1;
        else ignored += 1;
      } catch (error) {
        this.logger.error(
          { err: error, providerEventId: item.providerEventId },
          'Failed to handle a WhatsApp webhook item',
        );
        ignored += 1;
      }
    }

    return { accepted, ignored };
  }

  private async handleItem(item: ParsedItem): Promise<boolean> {
    const route = await this.resolveRoute(item.phoneNumberId);

    if (!route) {
      // An unroutable callback still gets recorded. An onboarding mistake that
      // silently drops traffic is indistinguishable from a quiet day, which is
      // the failure this platform exists to prevent.
      await this.recordUnrouted(item);
      this.logger.warn(
        { phoneNumberId: item.phoneNumberId },
        'WhatsApp webhook for an unknown phone_number_id',
      );
      return false;
    }

    return this.prisma.forTenant(route.tenant_id, async (tx) => {
      // Replay protection (spec 68). A unique insert, so a duplicate delivery
      // loses the race and changes nothing — rather than a read-then-write,
      // which two concurrent deliveries would both pass.
      const claimed = await tx.inboundWebhookEvent.createMany({
        data: [
          {
            tenantId: route.tenant_id,
            provider: PROVIDER,
            providerEventId: item.providerEventId,
            eventType: item.eventType,
            payload: item.raw as never,
          },
        ],
        skipDuplicates: true,
      });

      if (claimed.count === 0) {
        this.logger.debug(
          { providerEventId: item.providerEventId },
          'Duplicate WhatsApp webhook ignored',
        );
        return false;
      }

      if (item.eventType === 'message') {
        await this.recordInbound(tx, route, item);
      } else {
        await this.recordStatus(tx, route.tenant_id, item);
      }

      await tx.inboundWebhookEvent.updateMany({
        where: { provider: PROVIDER, providerEventId: item.providerEventId },
        data: { processedAt: new Date() },
      });

      return true;
    });
  }

  private async resolveRoute(
    phoneNumberId: string,
  ): Promise<{ account_id: string; tenant_id: string; branch_id: string | null } | null> {
    const rows = await this.prisma.withoutTenant((tx) =>
      tx.$queryRaw<Array<{ account_id: string; tenant_id: string; branch_id: string | null }>>`
        SELECT account_id, tenant_id, branch_id
        FROM app_whatsapp_account_route(${phoneNumberId})
      `,
    );
    return rows[0] ?? null;
  }

  /**
   * An inbound message: the row that opens the 24-hour window.
   *
   * Linked to a customer when the number is already known. A first-time sender
   * has no customer record yet and the row carries only the number, which is
   * enough — the window is computed from the contact number, not from an
   * identity we may not have established.
   */
  private async recordInbound(
    tx: TransactionClient,
    route: { account_id: string; tenant_id: string },
    item: ParsedItem,
  ): Promise<void> {
    const contactNumber = toE164(item.contact);

    const customer = await tx.customer.findFirst({
      where: { OR: [{ phone: contactNumber }, { whatsappNumber: contactNumber }] },
      select: { id: true },
    });

    await tx.whatsAppMessage.createMany({
      data: [
        {
          tenantId: route.tenant_id,
          accountId: route.account_id,
          customerId: customer?.id ?? null,
          contactNumber,
          direction: MessageDirection.INBOUND,
          providerMessageId: item.messageId ?? null,
          body: item.body ?? null,
          raw: item.raw as never,
          occurredAt: item.occurredAt,
        },
      ],
      skipDuplicates: true,
    });
  }

  /**
   * A delivery receipt.
   *
   * Applied to the message log and, when it corresponds to a notification we
   * sent, to the notification itself — so "sent" and "actually reached the
   * customer's phone" stay distinguishable. A `failed` receipt returns the
   * notification to the retry ladder rather than leaving it looking successful.
   */
  private async recordStatus(
    tx: TransactionClient,
    tenantId: string,
    item: ParsedItem,
  ): Promise<void> {
    const providerMessageId = item.messageRef;
    if (!providerMessageId) return;

    const status = item.status ?? 'unknown';
    const delivered = status === 'delivered' || status === 'read';

    await tx.whatsAppMessage.updateMany({
      where: { tenantId, providerMessageId },
      data: {
        status,
        error: item.error ?? null,
        ...(status === 'delivered' ? { deliveredAt: item.occurredAt } : {}),
        ...(status === 'read' ? { readAt: item.occurredAt } : {}),
      },
    });

    if (delivered) {
      await tx.notification.updateMany({
        where: { tenantId, providerMessageId },
        data: { status: NotificationStatus.DELIVERED, deliveredAt: item.occurredAt },
      });
      return;
    }

    if (status === 'failed') {
      await tx.notification.updateMany({
        where: { tenantId, providerMessageId, status: NotificationStatus.SENT },
        data: {
          status: NotificationStatus.PENDING,
          nextAttemptAt: new Date(),
          lastError: (item.error ?? 'Provider reported delivery failure').slice(0, 500),
          // The provider id belonged to the attempt that failed; a retry gets
          // its own, and leaving this one would make a later receipt update the
          // wrong row.
          providerMessageId: null,
        },
      });
    }
  }

  /** A callback whose number belongs to no account. Kept for support. */
  private async recordUnrouted(item: ParsedItem): Promise<void> {
    await this.prisma.withoutTenant(async (tx) => {
      // createMany, not create: INSERT ... RETURNING re-checks the SELECT
      // policy, and the unrouted lane has no SELECT branch for a tenant-scoped
      // connection. See migration 20260901000700.
      await tx.inboundWebhookEvent.createMany({
        data: [
          {
            tenantId: null,
            provider: PROVIDER,
            providerEventId: item.providerEventId,
            eventType: item.eventType,
            payload: item.raw as never,
            error: `No active WhatsApp account for phone_number_id ${item.phoneNumberId}`,
          },
        ],
        skipDuplicates: true,
      });
    });
  }
}

/**
 * Pulls the interesting items out of a provider payload.
 *
 * Written defensively and without a schema validator on purpose: a shape we did
 * not expect must produce zero items rather than an exception, because throwing
 * here would return a non-200 and make the provider redeliver the same
 * unparseable payload indefinitely.
 */
function parseWebhook(payload: unknown): ParsedItem[] {
  const items: ParsedItem[] = [];
  const entries = asArray(asRecord(payload)?.entry);

  for (const entry of entries) {
    for (const change of asArray(asRecord(entry)?.changes)) {
      const value = asRecord(asRecord(change)?.value);
      if (!value) continue;

      const phoneNumberId = asString(asRecord(value.metadata)?.phone_number_id);
      if (!phoneNumberId) continue;

      for (const message of asArray(value.messages)) {
        const record = asRecord(message);
        const id = asString(record?.id);
        const from = asString(record?.from);
        if (!id || !from) continue;

        items.push({
          providerEventId: `msg:${id}`,
          eventType: 'message',
          phoneNumberId,
          contact: from,
          occurredAt: toDate(record?.timestamp),
          messageId: id,
          body: asString(asRecord(record?.text)?.body) ?? undefined,
          raw: record ?? {},
        });
      }

      for (const status of asArray(value.statuses)) {
        const record = asRecord(status);
        const id = asString(record?.id);
        const state = asString(record?.status);
        if (!id || !state) continue;

        items.push({
          // The status is part of the id: `sent`, `delivered` and `read` all
          // arrive for one message and each is a distinct event.
          providerEventId: `status:${id}:${state}`,
          eventType: 'status',
          phoneNumberId,
          contact: asString(record?.recipient_id) ?? '',
          occurredAt: toDate(record?.timestamp),
          messageRef: id,
          status: state,
          error: asString(asRecord(asArray(record?.errors)[0])?.title) ?? undefined,
          raw: record ?? {},
        });
      }
    }
  }

  return items;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Provider timestamps are seconds as a string. */
function toDate(value: unknown): Date {
  const seconds = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date();
}

/** WhatsApp reports numbers without a plus; everything here stores E.164. */
function toE164(contact: string): string {
  return contact.startsWith('+') ? contact : `+${contact}`;
}
