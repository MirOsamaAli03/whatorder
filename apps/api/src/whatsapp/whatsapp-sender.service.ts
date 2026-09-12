import { Injectable, Logger } from '@nestjs/common';
import { MessageDirection } from '@restaurant-os/types';
import {
  WhatsAppSendError,
  createDefaultRegistry,
  type OutboundMessage,
  type WhatsAppCredentials,
  type WhatsAppProviderRegistry,
} from '@restaurant-os/whatsapp';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Sends a conversational reply, immediately.
 *
 * Deliberately NOT the notification pipeline. A notification is something the
 * restaurant owes the customer, which may be delayed, retried for an hour and
 * still be useful; a reply is half of a conversation the customer is having
 * right now, and one that arrives ten minutes later is worse than none. So
 * these go straight to the provider and are not queued.
 *
 * The consequence is that a provider outage costs replies. That is the correct
 * trade — invariant 8 protects the *order*, and there is no order at this point
 * — but it is why a failed reply is logged loudly rather than swallowed.
 */
@Injectable()
export class WhatsAppSenderService {
  private readonly logger = new Logger(WhatsAppSenderService.name);
  private readonly registry: WhatsAppProviderRegistry;

  constructor(private readonly prisma: PrismaService) {
    this.registry = createDefaultRegistry((message, detail) => this.logger.debug(detail, message));
  }

  /** Exposed so tests and a future BSP adapter can register a provider. */
  providers(): WhatsAppProviderRegistry {
    return this.registry;
  }

  /**
   * Sends every message in order, and records each against the conversation.
   *
   * Sequential rather than parallel on purpose: these are the turns of a
   * conversation, and a cart summary arriving after the question about it reads
   * as a broken bot.
   */
  async send(
    tenantId: string,
    accountId: string,
    contactNumber: string,
    messages: readonly OutboundMessage[],
  ): Promise<void> {
    if (messages.length === 0) return;

    const account = await this.prisma.forTenant(tenantId, (tx) =>
      tx.whatsAppAccount.findUnique({ where: { id: accountId } }),
    );

    if (!account) {
      this.logger.error({ tenantId, accountId }, 'Cannot reply: the WhatsApp account is gone');
      return;
    }

    const credentials = {
      ...(account.credentials as Record<string, unknown>),
      phoneNumberId: account.phoneNumberId,
    } as WhatsAppCredentials;

    for (const message of messages) {
      try {
        const provider = this.registry.get(account.provider);
        const result = await provider.send(message, credentials);

        await this.record(tenantId, accountId, contactNumber, message, result.providerMessageId);
      } catch (error) {
        const retryable = error instanceof WhatsAppSendError ? error.retryable : false;

        // Loud, because nothing else will notice: the customer simply stops
        // hearing back, and there is no queue holding evidence.
        this.logger.error(
          { err: error, tenantId, contactNumber, retryable },
          'Failed to send a WhatsApp reply',
        );

        // Stop rather than carry on: the rest of this turn's messages only make
        // sense after the one that failed.
        return;
      }
    }
  }

  /**
   * Logs the outbound message.
   *
   * Conversational replies are logged like any other, which matters twice over:
   * support can read the whole exchange in order, and the 24-hour window
   * calculation sees a complete picture of the conversation.
   */
  private async record(
    tenantId: string,
    accountId: string,
    contactNumber: string,
    message: OutboundMessage,
    providerMessageId: string,
  ): Promise<void> {
    const body =
      message.kind === 'template'
        ? message.renderedBody
        : message.body;

    await this.prisma.forTenant(tenantId, (tx) =>
      tx.whatsAppMessage.createMany({
        data: [
          {
            tenantId,
            accountId,
            contactNumber,
            direction: MessageDirection.OUTBOUND,
            sendMode: message.mode,
            providerMessageId,
            body,
            raw: { kind: message.kind } as never,
            status: 'accepted',
          },
        ],
        skipDuplicates: true,
      }),
    );
  }
}
