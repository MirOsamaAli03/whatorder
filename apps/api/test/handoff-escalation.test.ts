import { PrismaClient } from '@prisma/client';
import { createPrismaClient } from '@restaurant-os/database';
import {
  NotificationChannelRegistry,
  NotificationDispatcher,
  createDefaultChannelRegistry,
} from '@restaurant-os/notifications';
import {
  ConversationChannel,
  ConversationState,
  MessageDirection,
  NotificationChannel,
  RecipientType,
  SystemRole,
} from '@restaurant-os/types';
import { LogWhatsAppProvider, WhatsAppProviderRegistry } from '@restaurant-os/whatsapp';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EscalationMonitor } from '../../worker/src/escalation-monitor';
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
 * An unanswered handoff reaches somebody (backlog B-28).
 *
 * The bot tells a customer who asks for a person that "somebody will reply
 * here shortly" and goes silent. The inbox makes that visible to anyone
 * looking at the dashboard — but it still depended on somebody looking. An
 * unacknowledged *order* escalated; an unanswered *customer* did not.
 *
 * Driven through the real escalation monitor running as the real worker role,
 * and the real dispatcher on an application connection, so the privilege split
 * between the two is exercised rather than described.
 */
describe('unanswered handoff escalation', () => {
  let context: TestContext;
  let workerPrisma: PrismaClient;
  let appPrisma: ReturnType<typeof createPrismaClient>;
  let monitor: EscalationMonitor;
  let dispatcher: NotificationDispatcher;
  let channels: NotificationChannelRegistry;

  let tenant: TestTenant;
  const created: TestTenant[] = [];

  let ownerToken: string;
  let branchId: string;
  let accountId: string;

  const logger = pino({ level: 'silent' });
  const contact = '+923008881122';
  const phoneNumberId = `pn-handoff-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    context = await createTestContext();
    await ensureReferenceData(context.admin);

    workerPrisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL_WORKER } },
    });
    appPrisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL! });

    monitor = new EscalationMonitor(workerPrisma, logger, { pollMs: 60_000 });
    dispatcher = new NotificationDispatcher(workerPrisma, appPrisma, logger, {
      pollMs: 60_000,
      batchSize: 500,
    });
    channels = createDefaultChannelRegistry(
      new WhatsAppProviderRegistry([new LogWhatsAppProvider()]),
    );
    expect(channels.get(NotificationChannel.DASHBOARD)).toBeDefined();

    tenant = await createTenant(context.admin, {
      slug: 'handoff-kitchen',
      branchSlugs: ['main'],
      users: [{ key: 'owner', role: SystemRole.OWNER }],
    });
    created.push(tenant);

    ownerToken = await login(context.app, tenant.users.owner!.email);
    branchId = tenant.branchIds[0]!;

    // A two-second threshold, so the wait is observable in a test rather than
    // in five minutes.
    await context.admin.organization.update({
      where: { id: tenant.organizationId },
      data: { settings: { taxPercent: 0, handoffResponseTimeoutSeconds: 2 } },
    });

    // Staff need a number, or only the dashboard channel applies.
    await context.admin.user.update({
      where: { id: tenant.users.owner!.userId },
      data: { phone: '+923005550000' },
    });

    const account = await context.app.inject({
      method: 'POST',
      url: '/api/v1/notifications/whatsapp/accounts',
      headers: authHeaders(ownerToken),
      payload: { phoneNumberId, displayNumber: '03001112233', branchId, provider: 'log' },
    });
    accountId = account.json().data.id;
  });

  afterAll(async () => {
    await workerPrisma.$disconnect();
    await appPrisma.$disconnect();
    await context.admin.conversationSession.deleteMany({
      where: { tenantId: tenant.organizationId },
    });
    await cleanupTenants(context.admin, created);
    await context.close();
  });

  /** A conversation sitting in a handoff, last heard from `agoMs` ago. */
  async function waitingHandoff(agoMs: number): Promise<string> {
    await context.admin.conversationSession.deleteMany({
      where: { tenantId: tenant.organizationId },
    });

    const at = new Date(Date.now() - agoMs);

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
        body: 'Is anyone there?',
        occurredAt: at,
      },
    });

    return session.id;
  }

  /** Parks the dispatcher at the end of the outbox, as its own suite does. */
  async function parkCursor(): Promise<void> {
    const latest = await context.admin.outboxEvent.findFirst({
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    await context.admin.outboxCursor.upsert({
      where: { consumer: 'notifications' },
      create: { consumer: 'notifications', lastSequence: latest?.sequence ?? 0n },
      update: { lastSequence: latest?.sequence ?? 0n },
    });
  }

  function handoffNotifications() {
    return context.admin.notification.findMany({
      where: { tenantId: tenant.organizationId, templateKey: 'conversation_unanswered' },
    });
  }

  it('leaves a customer who has only just asked alone', async () => {
    const id = await waitingHandoff(0);
    await monitor.sweepOnce();

    // Asserted on this conversation rather than on the sweep's total, which
    // also counts unacknowledged orders left behind by other suites.
    const session = await context.admin.conversationSession.findUniqueOrThrow({ where: { id } });
    expect(session.handoffEscalatedAt).toBeNull();
  });

  it('raises the alarm once the threshold passes', async () => {
    const id = await waitingHandoff(5_000);
    await parkCursor();

    const raised = await monitor.sweepOnce();
    expect(raised).toBeGreaterThan(0);

    const session = await context.admin.conversationSession.findUniqueOrThrow({ where: { id } });
    expect(session.handoffEscalatedAt).not.toBeNull();

    const event = await context.admin.outboxEvent.findFirst({
      where: { tenantId: tenant.organizationId, aggregateId: id },
      orderBy: { createdAt: 'desc' },
    });
    expect(event?.eventType).toBe('ConversationHandoffUnanswered');
  });

  it('does not wake anybody twice for one customer', async () => {
    const id = await waitingHandoff(5_000);
    await monitor.sweepOnce();
    const before = await context.admin.outboxEvent.count({
      where: { tenantId: tenant.organizationId, aggregateId: id },
    });

    await monitor.sweepOnce();
    const after = await context.admin.outboxEvent.count({
      where: { tenantId: tenant.organizationId, aggregateId: id },
    });

    expect(after).toBe(before);
  });

  it('turns the alarm into staff notifications on every channel', async () => {
    await context.admin.notification.deleteMany({ where: { tenantId: tenant.organizationId } });
    await waitingHandoff(5_000);
    await parkCursor();

    await monitor.sweepOnce();
    await dispatcher.dispatchOnce();

    const rows = await handoffNotifications();
    expect(rows.length).toBeGreaterThan(0);

    // Staff only: telling the customer the restaurant has not noticed them
    // would be worse than useless.
    expect(rows.every((row) => row.recipientType === RecipientType.STAFF)).toBe(true);

    // Every channel at once — the inbox being unwatched is what raised this.
    expect([...new Set(rows.map((row) => row.channel))].sort()).toEqual([
      NotificationChannel.DASHBOARD,
      NotificationChannel.SMS,
      NotificationChannel.WHATSAPP,
    ]);

    // The message names who is waiting and where to go.
    const body = JSON.stringify(rows[0]!.payload);
    expect(body).toContain(contact);
  });

  it('says nothing if a colleague answered in the meantime', async () => {
    // Waking somebody about a conversation already handled is how an alarm
    // earns the right to be ignored.
    await context.admin.notification.deleteMany({ where: { tenantId: tenant.organizationId } });
    const id = await waitingHandoff(5_000);
    await parkCursor();

    await monitor.sweepOnce();

    await context.admin.conversationSession.update({
      where: { id },
      data: { state: ConversationState.IDLE },
    });

    await dispatcher.dispatchOnce();
    expect(await handoffNotifications()).toHaveLength(0);
  });

  it('starts a fresh clock when a person hands the conversation back', async () => {
    const id = await waitingHandoff(5_000);
    await monitor.sweepOnce();

    const resolved = await context.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${id}/resolve`,
      headers: authHeaders(ownerToken),
      payload: {},
    });
    expect(resolved.statusCode).toBe(201);

    const session = await context.admin.conversationSession.findUniqueOrThrow({ where: { id } });
    expect(session.state).toBe(ConversationState.IDLE);
    // Otherwise this customer's next handoff would never raise the alarm.
    expect(session.handoffEscalatedAt).toBeNull();
  });

  it('re-arms when a person replies but the customer is left waiting again', async () => {
    const id = await waitingHandoff(5_000);
    await monitor.sweepOnce();

    const replied = await context.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${id}/reply`,
      headers: authHeaders(ownerToken),
      payload: { body: 'Looking into it now.' },
    });
    expect(replied.statusCode).toBe(201);

    const session = await context.admin.conversationSession.findUniqueOrThrow({ where: { id } });
    // Still handed off, but answered — so a second silence can raise it again
    // rather than the conversation escalating once and never more.
    expect(session.state).toBe(ConversationState.HUMAN_HANDOFF);
    expect(session.handoffEscalatedAt).toBeNull();
  });

  it('keeps the customer out of the worker role’s reach', async () => {
    // The sweep is cross-tenant, so it runs as the worker — which must not be
    // able to read who the customer is or what is in their cart.
    await expect(
      workerPrisma.$queryRawUnsafe('SELECT external_user_id FROM conversation_sessions LIMIT 1'),
    ).rejects.toThrow();

    await expect(
      workerPrisma.$queryRawUnsafe('SELECT context FROM conversation_sessions LIMIT 1'),
    ).rejects.toThrow();

    // But it can see what it needs to schedule the sweep.
    await expect(
      workerPrisma.$queryRawUnsafe(
        'SELECT id, state, last_inbound_at FROM conversation_sessions LIMIT 1',
      ),
    ).resolves.toBeDefined();
  });
});
