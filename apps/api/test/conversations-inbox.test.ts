import {
  ConversationChannel,
  ConversationState,
  MessageDirection,
  SystemRole,
} from '@restaurant-os/types';
import type { LogWhatsAppProvider } from '@restaurant-os/whatsapp';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WhatsAppSenderService } from '../src/whatsapp/whatsapp-sender.service';
import {
  authHeaders,
  cleanupTenants,
  createTenant,
  createTestContext,
  ensureReferenceData,
  login,
  type TestContext,
  type TestTenant,
} from './helpers/test-context';

/**
 * The staff inbox for handed-off WhatsApp conversations (backlog B-24).
 *
 * The bot tells a customer who asks for a person that "somebody will reply here
 * shortly" and then correctly falls silent. These tests are about the other
 * half of that sentence being true.
 */
describe('conversations inbox', () => {
  let context: TestContext;
  let tenant: TestTenant;
  let other: TestTenant;
  const created: TestTenant[] = [];

  let ownerToken: string;
  let otherToken: string;
  let kitchenToken: string;
  let branchId: string;
  let accountId: string;
  let provider: LogWhatsAppProvider;

  const contact = '+923005551234';
  const phoneNumberId = `pn-inbox-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    context = await createTestContext();
    await ensureReferenceData(context.admin);

    tenant = await createTenant(context.admin, {
      slug: 'inbox-kitchen',
      branchSlugs: ['main'],
      users: [
        { key: 'owner', role: SystemRole.OWNER },
        { key: 'kitchen', role: SystemRole.KITCHEN_STAFF, branches: [0] },
      ],
    });
    other = await createTenant(context.admin, {
      slug: 'inbox-rival',
      branchSlugs: ['main'],
      users: [{ key: 'owner', role: SystemRole.OWNER }],
    });
    created.push(tenant, other);

    ownerToken = await login(context.app, tenant.users.owner!.email);
    otherToken = await login(context.app, other.users.owner!.email);
    kitchenToken = await login(context.app, tenant.users.kitchen!.email);
    branchId = tenant.branchIds[0]!;

    const account = await context.app.inject({
      method: 'POST',
      url: '/api/v1/notifications/whatsapp/accounts',
      headers: authHeaders(ownerToken),
      payload: { phoneNumberId, displayNumber: '03001112233', branchId, provider: 'log' },
    });
    accountId = account.json().data.id;

    provider = context.app
      .get(WhatsAppSenderService)
      .providers()
      .get('log') as LogWhatsAppProvider;
  });

  afterAll(async () => {
    await context.admin.conversationSession.deleteMany({
      where: { tenantId: tenant.organizationId },
    });
    await cleanupTenants(context.admin, created);
    await context.close();
  });

  const get = (url: string, token = ownerToken) =>
    context.app.inject({ method: 'GET', url, headers: authHeaders(token) });
  const post = (url: string, payload: Record<string, unknown> = {}, token = ownerToken) =>
    context.app.inject({ method: 'POST', url, headers: authHeaders(token), payload });

  /**
   * Puts one conversation in HUMAN_HANDOFF with an inbound message.
   *
   * `inboundAgeMs` moves that message back in time, which is how the 24-hour
   * service window is exercised without waiting a day.
   */
  async function seedHandoff(inboundAgeMs = 60_000): Promise<string> {
    await context.admin.conversationSession.deleteMany({
      where: { tenantId: tenant.organizationId },
    });
    await context.admin.whatsAppMessage.deleteMany({
      where: { tenantId: tenant.organizationId },
    });

    const at = new Date(Date.now() - inboundAgeMs);

    const session = await context.admin.conversationSession.create({
      data: {
        tenantId: tenant.organizationId,
        branchId,
        channel: ConversationChannel.WHATSAPP,
        externalUserId: contact,
        state: ConversationState.HUMAN_HANDOFF,
        context: {},
        expiresAt: new Date(Date.now() + 86_400_000),
        lastInboundAt: at,
      },
    });

    await context.admin.whatsAppMessage.create({
      data: {
        tenantId: tenant.organizationId,
        accountId,
        contactNumber: contact,
        direction: MessageDirection.INBOUND,
        providerMessageId: `wamid-${randomUUID()}`,
        body: 'My order is late, can I speak to someone?',
        occurredAt: at,
      },
    });

    return session.id;
  }

  beforeEach(() => provider.reset());

  describe('the list', () => {
    it('shows who is waiting, and for how long', async () => {
      await seedHandoff(120_000);

      const response = await get(`/api/v1/conversations?branchId=${branchId}`);
      expect(response.statusCode).toBe(200);

      const [row] = response.json().data as Array<{
        contactNumber: string;
        waitingSeconds: number;
        canReply: boolean;
        lastMessage: { body: string } | null;
      }>;

      expect(row!.contactNumber).toBe(contact);
      // The number the screen sorts and colours on.
      expect(row!.waitingSeconds).toBeGreaterThanOrEqual(110);
      expect(row!.lastMessage?.body).toContain('speak to someone');
      expect(row!.canReply).toBe(true);
    });

    it('defaults to the ones needing a person, not to everything', async () => {
      await seedHandoff();
      await context.admin.conversationSession.create({
        data: {
          tenantId: tenant.organizationId,
          branchId,
          channel: ConversationChannel.WHATSAPP,
          externalUserId: '+923007770000',
          state: ConversationState.IDLE,
          context: {},
          expiresAt: new Date(Date.now() + 86_400_000),
          lastInboundAt: new Date(),
        },
      });

      // A screen that opens on five hundred finished conversations does not
      // answer "who is waiting for us".
      const waiting = await get('/api/v1/conversations');
      expect(waiting.json().data).toHaveLength(1);

      const all = await get('/api/v1/conversations?state=ALL');
      expect(all.json().data).toHaveLength(2);
    });

    it('counts the waiting, for the navigation badge', async () => {
      await seedHandoff();

      const response = await get('/api/v1/conversations/waiting');
      expect(response.json().data.waiting).toBe(1);
    });

    it('says a reply is impossible once the 24-hour window has closed', async () => {
      // 25 hours. Meta permits only an approved template after 24 (plan 2.2).
      await seedHandoff(25 * 60 * 60 * 1000);

      const response = await get('/api/v1/conversations');
      expect(response.json().data[0].canReply).toBe(false);
    });

    it('hides one tenant’s conversations from another', async () => {
      await seedHandoff();
      const response = await get('/api/v1/conversations?state=ALL', otherToken);
      expect(response.json().data).toEqual([]);
    });

    it('refuses a role that may not see customer data', async () => {
      // A thread is a phone number and everything the customer said, which is
      // exactly what kitchen staff deliberately do not hold (spec 11).
      const response = await get('/api/v1/conversations', kitchenToken);
      expect(response.statusCode).toBe(403);
    });
  });

  describe('the thread', () => {
    it('returns the messages in the order they were said', async () => {
      const id = await seedHandoff();

      await context.admin.whatsAppMessage.create({
        data: {
          tenantId: tenant.organizationId,
          accountId,
          contactNumber: contact,
          direction: MessageDirection.OUTBOUND,
          providerMessageId: `wamid-${randomUUID()}`,
          body: 'I have passed this to the team.',
          occurredAt: new Date(),
        },
      });

      const response = await get(`/api/v1/conversations/${id}`);
      const thread = response.json().data;

      expect(thread.messages).toHaveLength(2);
      expect(thread.messages[0].direction).toBe(MessageDirection.INBOUND);
      expect(thread.messages[1].direction).toBe(MessageDirection.OUTBOUND);
      expect(thread.state).toBe(ConversationState.HUMAN_HANDOFF);
    });
  });

  describe('replying', () => {
    it('sends over the same number the bot uses', async () => {
      const id = await seedHandoff();

      const response = await post(`/api/v1/conversations/${id}/reply`, {
        body: 'Sorry about that — your order is on its way now.',
      });

      expect(response.statusCode).toBe(201);

      // One continuous conversation, not a message from a second number.
      const sent = provider.lastMessage();
      expect(sent?.message.to).toBe(contact);
      expect(sent?.phoneNumberId).toBe(phoneNumberId);

      // And the thread stays complete.
      const thread = response.json().data;
      expect(thread.messages.at(-1).body).toContain('on its way');
    });

    it('records who replied', async () => {
      const id = await seedHandoff();
      await post(`/api/v1/conversations/${id}/reply`, { body: 'On its way.' });

      const audit = await context.admin.auditLog.findFirst({
        where: { tenantId: tenant.organizationId, entityType: 'ConversationSession', entityId: id },
        orderBy: { createdAt: 'desc' },
      });

      // The thread shows what was said; the audit row shows which person said
      // it, which the thread cannot.
      expect(audit?.actorId).toBe(tenant.users.owner!.userId);
    });

    it('refuses a reply the provider would reject', async () => {
      await seedHandoff(25 * 60 * 60 * 1000);
      const id = (await get('/api/v1/conversations?state=ALL')).json().data[0].id;

      const response = await post(`/api/v1/conversations/${id}/reply`, { body: 'Still there?' });

      // Refused here, with an explanation, rather than at the provider as an
      // opaque failure after the fact.
      expect(response.statusCode).toBe(409);
      expect(response.json().error.message).toContain('24 hours');
      expect(provider.messages()).toHaveLength(0);
    });

    it('refuses a role that may not update customers', async () => {
      const id = await seedHandoff();
      const response = await post(
        `/api/v1/conversations/${id}/reply`,
        { body: 'hello' },
        kitchenToken,
      );
      expect(response.statusCode).toBe(403);
    });
  });

  describe('handing back to the bot', () => {
    it('returns the conversation to IDLE', async () => {
      const id = await seedHandoff();

      const response = await post(`/api/v1/conversations/${id}/resolve`);
      expect(response.statusCode).toBe(201);
      expect(response.json().data.state).toBe(ConversationState.IDLE);

      const stored = await context.admin.conversationSession.findUniqueOrThrow({ where: { id } });
      expect(stored.state).toBe(ConversationState.IDLE);
      // The half-built context is cleared: the person has dealt with whatever
      // it was, and resuming a stale cart afterwards would be worse.
      expect(stored.context).toEqual({});
    });

    it('is the only exit from a handoff, and only a person can take it', async () => {
      const id = await seedHandoff();
      await post(`/api/v1/conversations/${id}/resolve`);

      // Already handed back: nothing to resolve.
      const again = await post(`/api/v1/conversations/${id}/resolve`);
      expect(again.statusCode).toBe(409);
    });

    it('lets the bot answer again once a person has handed it back', async () => {
      const id = await seedHandoff();
      await post(`/api/v1/conversations/${id}/resolve`);
      provider.reset();

      const response = await context.app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/whatsapp',
        payload: {
          entry: [
            {
              changes: [
                {
                  value: {
                    metadata: { phone_number_id: phoneNumberId },
                    messages: [
                      {
                        id: `wamid-${randomUUID()}`,
                        from: contact.slice(1),
                        timestamp: String(Math.floor(Date.now() / 1000)),
                        type: 'text',
                        text: { body: 'hello again' },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      });

      expect(response.statusCode).toBe(201);
      // Silent while handed off, talking again afterwards.
      expect(provider.messages().length).toBeGreaterThan(0);
    });
  });
});
