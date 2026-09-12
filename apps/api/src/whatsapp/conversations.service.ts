import { Injectable } from '@nestjs/common';
import { ConflictError, NotFoundError, isServiceWindowOpen } from '@restaurant-os/domain';
import {
  AuditAction,
  ConversationChannel,
  ConversationState,
  MessageDirection,
  type AuthContext,
} from '@restaurant-os/types';
import { textMessage } from '@restaurant-os/whatsapp';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ListConversationsDto, ReplyDto } from './conversations.dto';
import { WhatsAppSenderService } from './whatsapp-sender.service';

/** How many messages of history a thread returns. */
const THREAD_LIMIT = 100;

/**
 * The staff side of a WhatsApp conversation.
 *
 * The bot tells a customer who asks for help that "somebody will reply here
 * shortly" and then correctly falls silent (ENGINEERING_SPEC.md 22). Without
 * this, that sentence is a promise the software does not keep — the
 * conversation sits in HUMAN_HANDOFF and nothing surfaces it to anyone. It
 * fires precisely when a customer is already frustrated enough to ask for a
 * person, which makes it the worst moment to go quiet.
 *
 * So: a list of conversations waiting, the thread behind each one, a reply, and
 * a way to hand the conversation back to the bot.
 */
@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: WhatsAppSenderService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Conversations, most urgent first.
   *
   * Defaults to the ones waiting on a person rather than to everything: the
   * list exists to answer "who is waiting for us", and a screen that opens on
   * five hundred finished conversations does not answer it.
   */
  async findAll(auth: AuthContext, query: ListConversationsDto) {
    const state = query.state ?? ConversationState.HUMAN_HANDOFF;

    const sessions = await this.prisma.forTenant(auth.tenantId, (tx) =>
      tx.conversationSession.findMany({
        where: {
          ...(state === 'ALL' ? {} : { state }),
          ...(query.branchId ? { branchId: query.branchId } : {}),
        },
        orderBy: { lastInboundAt: 'asc' },
        take: query.limit ?? 50,
        skip: query.offset ?? 0,
      }),
    );

    if (sessions.length === 0) return [];

    const numbers = sessions.map((session) => session.externalUserId);

    // The last thing said on each thread, so the list reads as an inbox rather
    // than as a table of phone numbers.
    const [messages, customers] = await Promise.all([
      this.prisma.forTenant(auth.tenantId, (tx) =>
        tx.whatsAppMessage.findMany({
          where: { contactNumber: { in: numbers } },
          orderBy: { occurredAt: 'desc' },
          take: numbers.length * 10,
          select: {
            contactNumber: true,
            direction: true,
            body: true,
            occurredAt: true,
          },
        }),
      ),
      this.prisma.forTenant(auth.tenantId, (tx) =>
        tx.customer.findMany({
          where: { OR: [{ phone: { in: numbers } }, { whatsappNumber: { in: numbers } }] },
          select: { id: true, name: true, phone: true, whatsappNumber: true },
        }),
      ),
    ]);

    const now = Date.now();

    return sessions.map((session) => {
      const last = messages.find(
        (message) => message.contactNumber === session.externalUserId,
      );
      const customer = customers.find(
        (row) =>
          row.phone === session.externalUserId ||
          row.whatsappNumber === session.externalUserId,
      );

      return {
        id: session.id,
        branchId: session.branchId,
        contactNumber: session.externalUserId,
        customerId: customer?.id ?? null,
        customerName: customer?.name ?? null,
        state: session.state,
        lastInboundAt: session.lastInboundAt,
        lastMessage: last ? { body: last.body, direction: last.direction, at: last.occurredAt } : null,
        /**
         * How long the customer has been waiting.
         *
         * The number the screen sorts and colours on: an inbox that does not
         * make waiting visible is a list nobody triages.
         */
        waitingSeconds:
          session.state === ConversationState.HUMAN_HANDOFF && session.lastInboundAt
            ? Math.max(0, Math.floor((now - session.lastInboundAt.getTime()) / 1000))
            : null,
        /**
         * Whether a free-form reply is still possible (plan 2.2).
         *
         * Outside WhatsApp's 24-hour window only an approved template may be
         * sent, and a staff reply is by definition free-form. Saying so in the
         * list is better than letting somebody type a paragraph and watching it
         * be refused.
         */
        canReply: this.windowOpen(session.externalUserId, messages, now),
      };
    });
  }

  /** One conversation and the messages behind it. */
  async findOne(auth: AuthContext, id: string) {
    return this.prisma.forTenant(auth.tenantId, async (tx) => {
      const session = await tx.conversationSession.findUnique({ where: { id } });
      if (!session) throw new NotFoundError('Conversation', id);

      const messages = await tx.whatsAppMessage.findMany({
        where: { contactNumber: session.externalUserId },
        orderBy: { occurredAt: 'asc' },
        take: THREAD_LIMIT,
        select: {
          id: true,
          direction: true,
          body: true,
          templateKey: true,
          status: true,
          occurredAt: true,
          deliveredAt: true,
          readAt: true,
        },
      });

      const customer = await tx.customer.findFirst({
        where: {
          OR: [
            { phone: session.externalUserId },
            { whatsappNumber: session.externalUserId },
          ],
        },
        select: { id: true, name: true, phone: true },
      });

      const lastInbound = [...messages]
        .reverse()
        .find((message) => message.direction === MessageDirection.INBOUND);

      return {
        id: session.id,
        branchId: session.branchId,
        contactNumber: session.externalUserId,
        state: session.state,
        lastInboundAt: session.lastInboundAt,
        customer,
        canReply: isServiceWindowOpen(lastInbound?.occurredAt ?? null, new Date()),
        messages,
      };
    });
  }

  /**
   * Sends a person's reply.
   *
   * Goes out over the same account the bot uses, so the customer sees one
   * continuous conversation rather than a message from a second number — and
   * it is logged like any other, so the thread stays complete.
   */
  async reply(auth: AuthContext, id: string, body: ReplyDto) {
    const conversation = await this.findOne(auth, id);

    if (!conversation.canReply) {
      // Refused here rather than at the provider, where it would be an opaque
      // failure after the fact. Meta permits only approved templates outside
      // the 24-hour window (plan 2.2).
      throw new ConflictError(
        'This customer last messaged over 24 hours ago, so WhatsApp will not accept a ' +
          'free-form reply. They need to message again first.',
      );
    }

    const account = await this.accountFor(auth, conversation.branchId);
    if (!account) {
      throw new ConflictError(
        'No WhatsApp number is connected for this branch, so there is nothing to reply from.',
      );
    }

    await this.sender.send(auth.tenantId, account.id, conversation.contactNumber, [
      textMessage(conversation.contactNumber, body.body),
    ]);

    await this.audit.record({
      action: AuditAction.UPDATE,
      entityType: 'ConversationSession',
      entityId: id,
      tenantId: auth.tenantId,
      // The message itself is in whatsapp_messages; the audit row records that
      // a named person replied, which is the part the thread cannot show.
      newValues: { repliedTo: conversation.contactNumber },
    });

    return this.findOne(auth, id);
  }

  /**
   * Ends a handoff and gives the conversation back to the bot.
   *
   * The only exit from HUMAN_HANDOFF, and deliberately a person's decision: the
   * bot cannot decide it has finished helping, because it never knew what the
   * customer wanted.
   */
  async resolve(auth: AuthContext, id: string) {
    await this.prisma.forTenant(auth.tenantId, async (tx) => {
      const session = await tx.conversationSession.findUnique({ where: { id } });
      if (!session) throw new NotFoundError('Conversation', id);

      if (session.state !== ConversationState.HUMAN_HANDOFF) {
        throw new ConflictError('This conversation is not waiting for a person');
      }

      await tx.conversationSession.updateMany({
        where: { id },
        data: { state: ConversationState.IDLE, context: {} },
      });

      await this.audit.recordIn(tx, {
        action: AuditAction.UPDATE,
        entityType: 'ConversationSession',
        entityId: id,
        tenantId: auth.tenantId,
        oldValues: { state: ConversationState.HUMAN_HANDOFF },
        newValues: { state: ConversationState.IDLE },
      });
    });

    return this.findOne(auth, id);
  }

  /** How many people are waiting, for the navigation badge. */
  async waitingCount(auth: AuthContext, branchId?: string): Promise<{ waiting: number }> {
    const waiting = await this.prisma.forTenant(auth.tenantId, (tx) =>
      tx.conversationSession.count({
        where: {
          state: ConversationState.HUMAN_HANDOFF,
          ...(branchId ? { branchId } : {}),
        },
      }),
    );

    return { waiting };
  }

  private async accountFor(auth: AuthContext, branchId: string | null) {
    const accounts = await this.prisma.forTenant(auth.tenantId, (tx) =>
      tx.whatsAppAccount.findMany({ where: { isActive: true } }),
    );

    return (
      accounts.find((account) => account.branchId === branchId) ??
      accounts.find((account) => account.branchId === null) ??
      null
    );
  }

  private windowOpen(
    contactNumber: string,
    messages: Array<{ contactNumber: string; direction: string; occurredAt: Date }>,
    now: number,
  ): boolean {
    const lastInbound = messages.find(
      (message) =>
        message.contactNumber === contactNumber &&
        message.direction === MessageDirection.INBOUND,
    );

    return isServiceWindowOpen(lastInbound?.occurredAt ?? null, new Date(now));
  }
}

/** Re-exported so the controller's channel filter reads plainly. */
export const CONVERSATION_CHANNEL = ConversationChannel.WHATSAPP;
