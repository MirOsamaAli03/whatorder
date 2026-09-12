import { PrismaClient } from '@prisma/client';
import { createPrismaClient } from '@restaurant-os/database';
import { MAX_NOTIFICATION_ATTEMPTS } from '@restaurant-os/domain';
import {
  NotificationChannelRegistry,
  NotificationDispatcher,
  NotificationSender,
  createDefaultChannelRegistry,
} from '@restaurant-os/notifications';
import {
  MessageDirection,
  NotificationChannel,
  NotificationStatus,
  OrderStatus,
  PaymentMethod,
  RecipientType,
  SystemRole,
  WhatsAppTemplateCategory,
  WhatsAppTemplateStatus,
} from '@restaurant-os/types';
import { LogWhatsAppProvider, WhatsAppProviderRegistry } from '@restaurant-os/whatsapp';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
 * The notification delivery pipeline (ENGINEERING_SPEC.md 30, 32, 58; plan
 * Phase 5).
 *
 * The dispatcher and the sender run in-process here, against the real database,
 * the real worker role and the real dev provider. Nothing is mocked: the
 * provider is the one the development worker actually uses, taken down and
 * brought back with its own switch. A mock would have proved the mock behaves.
 *
 * This file contains the plan's stated exit criterion for Phase 5:
 *
 *   "order creation succeeds while the WhatsApp provider is hard-down
 *    (invariant 8), and the notification retries and eventually delivers when
 *    it recovers"
 */
describe('notification pipeline', () => {
  let context: TestContext;
  let workerPrisma: PrismaClient;
  let appPrisma: ReturnType<typeof createPrismaClient>;
  let provider: LogWhatsAppProvider;
  let channels: NotificationChannelRegistry;
  let dispatcher: NotificationDispatcher;
  let sender: NotificationSender;

  let tenant: TestTenant;
  const created: TestTenant[] = [];

  let ownerToken: string;
  let branchId: string;
  let burgerId: string;
  let accountId: string;

  const logger = pino({ level: 'silent' });
  const phoneNumberId = `pn-pipeline-${randomUUID().slice(0, 8)}`;
  const customerPhone = '03008887777';
  const customerE164 = '+923008887777';

  beforeAll(async () => {
    context = await createTestContext();
    await ensureReferenceData(context.admin);

    // The same two roles the worker process uses in production, so the
    // privilege boundary under test is the real one.
    workerPrisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL_WORKER } },
    });
    appPrisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL! });

    provider = new LogWhatsAppProvider();
    channels = createDefaultChannelRegistry(new WhatsAppProviderRegistry([provider]));

    dispatcher = new NotificationDispatcher(workerPrisma, appPrisma, logger, {
      pollMs: 1_000,
      batchSize: 500,
    });
    sender = new NotificationSender(workerPrisma, appPrisma, channels, logger, {
      pollMs: 1_000,
      batchSize: 50,
      staleClaimMs: 120_000,
    });

    tenant = await createTenant(context.admin, {
      slug: 'pipeline-kitchen',
      branchSlugs: ['main'],
      users: [{ key: 'owner', role: SystemRole.OWNER }],
    });
    created.push(tenant);

    ownerToken = await login(context.app, tenant.users.owner!.email);
    branchId = tenant.branchIds[0]!;

    await context.admin.organization.update({
      where: { id: tenant.organizationId },
      data: { settings: { taxPercent: 0 } },
    });

    const item = await post('/api/v1/menu/items', {
      name: 'Pipeline Burger',
      basePrice: '600.00',
    });
    burgerId = item.json().data.id;

    const account = await post('/api/v1/notifications/whatsapp/accounts', {
      phoneNumberId,
      displayNumber: '03001112233',
      provider: 'log',
    });
    accountId = account.json().data.id;
  });

  afterAll(async () => {
    await workerPrisma.$disconnect();
    await appPrisma.$disconnect();
    await cleanupTenants(context.admin, created);
    await context.close();
  });

  /**
   * Parks the dispatcher's watermark at the current end of the outbox.
   *
   * The cursor is shared by the whole platform — one consumer over one queue —
   * so without this a test would also process every event the rest of the suite
   * happened to leave behind, and its assertions would depend on which files
   * ran first.
   */
  beforeEach(async () => {
    const latest = await context.admin.outboxEvent.findFirst({
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    await context.admin.outboxCursor.upsert({
      where: { consumer: 'notifications' },
      create: { consumer: 'notifications', lastSequence: latest?.sequence ?? 0n },
      update: { lastSequence: latest?.sequence ?? 0n },
    });

    provider.reset();
    await context.admin.notification.deleteMany({ where: { tenantId: tenant.organizationId } });
  });

  function post(url: string, payload: Record<string, unknown>, token = ownerToken) {
    return context.app.inject({ method: 'POST', url, headers: authHeaders(token), payload });
  }

  /** Places a cash order, which is CONFIRMED the moment it is created. */
  async function placeOrder(): Promise<{ id: string; orderNumber: string; status: string }> {
    const cart = await post('/api/v1/carts', {
      branchId,
      source: 'POS',
      orderType: 'PICKUP',
    });
    const cartId = cart.json().data.id;
    await post(`/api/v1/carts/${cartId}/items`, { menuItemId: burgerId });

    const placed = await context.app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { ...authHeaders(ownerToken), 'idempotency-key': randomUUID() },
      payload: { cartId, customerPhone, paymentMethod: PaymentMethod.CASH },
    });

    expect(placed.statusCode).toBe(201);
    return placed.json().data;
  }

  function notifications(where: Record<string, unknown> = {}) {
    return context.admin.notification.findMany({
      where: { tenantId: tenant.organizationId, ...where },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Opens the 24-hour service window by recording an inbound message. */
  async function openServiceWindow(): Promise<void> {
    await context.admin.whatsAppMessage.create({
      data: {
        tenantId: tenant.organizationId,
        accountId,
        contactNumber: customerE164,
        direction: MessageDirection.INBOUND,
        providerMessageId: `wamid-in-${randomUUID()}`,
        body: 'Order please',
        occurredAt: new Date(),
      },
    });
  }

  async function closeServiceWindow(): Promise<void> {
    await context.admin.whatsAppMessage.deleteMany({
      where: { tenantId: tenant.organizationId, direction: MessageDirection.INBOUND },
    });
  }

  describe('dispatch', () => {
    it('turns a confirmed order into a WhatsApp notification for the customer', async () => {
      const order = await placeOrder();
      await dispatcher.dispatchOnce();

      const rows = await notifications({ recipientType: RecipientType.CUSTOMER });
      expect(rows).toHaveLength(1);

      const row = rows[0]!;
      expect(row.templateKey).toBe('order_confirmed');
      expect(row.channel).toBe(NotificationChannel.WHATSAPP);
      expect(row.destination).toBe(customerE164);
      expect(row.status).toBe(NotificationStatus.PENDING);
      expect(row.branchId).toBe(branchId);
      expect((row.payload as { variables: { orderNumber: string } }).variables.orderNumber).toBe(
        order.orderNumber,
      );
    });

    it('sends one message per event, not one per channel', async () => {
      // Telling a customer the same news by WhatsApp and SMS is noise they did
      // not ask for and a bill the restaurant did not need.
      await placeOrder();
      await dispatcher.dispatchOnce();

      const rows = await notifications({ recipientType: RecipientType.CUSTOMER });
      expect(rows.map((row) => row.channel)).toEqual([NotificationChannel.WHATSAPP]);
    });

    it('is idempotent: replaying the same events creates nothing new', async () => {
      await placeOrder();
      await dispatcher.dispatchOnce();
      const first = await notifications();

      // Rewind the cursor, exactly as a crash before the watermark advanced
      // would leave it.
      const oldest = first[0]!;
      const event = await context.admin.outboxEvent.findUniqueOrThrow({
        where: { id: oldest.eventId },
      });
      await context.admin.outboxCursor.update({
        where: { consumer: 'notifications' },
        data: { lastSequence: event.sequence - 1n },
      });

      await dispatcher.dispatchOnce();

      const second = await notifications();
      expect(second).toHaveLength(first.length);
    });

    it('stays quiet about a kitchen-internal step', async () => {
      const order = await placeOrder();
      await dispatcher.dispatchOnce();
      const before = await notifications();

      await post(`/api/v1/orders/${order.id}/transition`, { status: OrderStatus.ACCEPTED });
      await post(`/api/v1/orders/${order.id}/transition`, { status: OrderStatus.PREPARING });
      await dispatcher.dispatchOnce();

      const after = await notifications();
      const added = after.filter(
        (row) => !before.some((existing) => existing.id === row.id),
      );

      // ACCEPTED notifies; PREPARING deliberately does not.
      expect(added.map((row) => row.templateKey)).toEqual(['order_accepted']);
    });

    it('alerts staff on every channel when an order goes unacknowledged', async () => {
      // Plan 2.8: an alert on a screen nobody is looking at is not an alert,
      // and the dashboard being ignored is what raised this in the first place.
      const order = await placeOrder();
      await context.admin.user.update({
        where: { id: tenant.users.owner!.userId },
        data: { phone: '+923005554444' },
      });

      await context.admin.outboxEvent.create({
        data: {
          id: randomUUID(),
          tenantId: tenant.organizationId,
          eventType: 'OrderAcknowledgementTimeout',
          aggregateType: 'Order',
          aggregateId: order.id,
          actor: 'SYSTEM',
          payload: {
            orderId: order.id,
            orderNumber: order.orderNumber,
            branchId,
            level: 1,
            target: 'KITCHEN',
            elapsedSeconds: 300,
          },
        },
      });

      await dispatcher.dispatchOnce();

      const staff = await notifications({
        recipientType: RecipientType.STAFF,
        templateKey: 'order_unacknowledged',
      });

      expect(staff.map((row) => row.channel).sort()).toEqual([
        NotificationChannel.DASHBOARD,
        NotificationChannel.SMS,
        NotificationChannel.WHATSAPP,
      ]);
      // The customer is never told that the restaurant has not noticed them.
      expect(
        staff.every((row) => row.recipientType === RecipientType.STAFF),
      ).toBe(true);
    });

    it('respects a channel the tenant has switched off', async () => {
      await context.app.inject({
        method: 'PUT',
        url: '/api/v1/notifications/preferences',
        headers: authHeaders(ownerToken),
        payload: {
          preferences: [
            {
              recipientType: RecipientType.CUSTOMER,
              channel: NotificationChannel.WHATSAPP,
              enabled: false,
            },
          ],
        },
      });

      await placeOrder();
      await dispatcher.dispatchOnce();

      const rows = await notifications({ recipientType: RecipientType.CUSTOMER });
      // Falls through to the next channel in the spec rather than going silent.
      expect(rows.map((row) => row.channel)).toEqual([NotificationChannel.SMS]);

      await context.app.inject({
        method: 'PUT',
        url: '/api/v1/notifications/preferences',
        headers: authHeaders(ownerToken),
        payload: {
          preferences: [
            {
              recipientType: RecipientType.CUSTOMER,
              channel: NotificationChannel.WHATSAPP,
              enabled: true,
            },
          ],
        },
      });
    });
  });

  describe('send', () => {
    it('sends a free session message inside the 24-hour window', async () => {
      await openServiceWindow();
      await placeOrder();
      await dispatcher.dispatchOnce();
      await sender.sendOnce();

      const rows = await notifications({ channel: NotificationChannel.WHATSAPP });
      const row = rows[0]!;

      expect(row.status).toBe(NotificationStatus.SENT);
      expect(row.providerMessageId).toBeTruthy();
      expect(row.nextAttemptAt).toBeNull();

      const message = provider.lastMessage()!;
      expect(message.message.mode).toBe('SESSION');
      expect(message.message.to).toBe(customerE164);

      // The outbound row is what a delivery receipt will later match on.
      const logged = await context.admin.whatsAppMessage.findFirst({
        where: { tenantId: tenant.organizationId, providerMessageId: row.providerMessageId! },
      });
      expect(logged?.direction).toBe(MessageDirection.OUTBOUND);

      await closeServiceWindow();
    });

    it('falls back to an approved template once the window has closed', async () => {
      await closeServiceWindow();
      await context.admin.whatsAppTemplate.deleteMany({
        where: { tenantId: tenant.organizationId },
      });
      await context.admin.whatsAppTemplate.create({
        data: {
          tenantId: tenant.organizationId,
          accountId,
          templateKey: 'order_confirmed',
          providerName: 'order_confirmed_v1',
          category: WhatsAppTemplateCategory.UTILITY,
          status: WhatsAppTemplateStatus.APPROVED,
          body: 'Hi {{1}}, order {{2}} at {{3}} is confirmed.',
          approvedAt: new Date(),
        },
      });

      await placeOrder();
      await dispatcher.dispatchOnce();
      await sender.sendOnce();

      const message = provider.lastMessage()!;
      expect(message.message.mode).toBe('TEMPLATE');
      expect(message.message).toMatchObject({ templateName: 'order_confirmed_v1' });
    });

    it('suppresses with a reason, and promotes to the next channel, when no template is approved', async () => {
      await closeServiceWindow();
      await context.admin.whatsAppTemplate.updateMany({
        where: { tenantId: tenant.organizationId },
        data: { status: WhatsAppTemplateStatus.PENDING },
      });

      await placeOrder();
      await dispatcher.dispatchOnce();
      await sender.sendOnce();

      const whatsapp = await notifications({
        channel: NotificationChannel.WHATSAPP,
        recipientType: RecipientType.CUSTOMER,
      });
      expect(whatsapp[0]!.status).toBe(NotificationStatus.SUPPRESSED);
      // The reason is the useful part: a restaurant can act on "your template
      // is still PENDING" where silence tells them nothing.
      expect(whatsapp[0]!.suppressedReason).toContain('PENDING');

      // Stopping there would mean the customer simply never hears.
      const sms = await notifications({
        channel: NotificationChannel.SMS,
        recipientType: RecipientType.CUSTOMER,
      });
      expect(sms).toHaveLength(1);
      expect(sms[0]!.destination).toBe(customerE164);

      await context.admin.whatsAppTemplate.updateMany({
        where: { tenantId: tenant.organizationId },
        data: { status: WhatsAppTemplateStatus.APPROVED },
      });
    });
  });

  /**
   * The plan's Phase 5 exit criterion, stated as a test.
   */
  describe('a hard-down provider (invariant 8)', () => {
    it('takes the order anyway, retries, and delivers once the provider recovers', async () => {
      await openServiceWindow();
      provider.setAvailable(false);

      // 1. The order is placed while WhatsApp is completely unavailable.
      const order = await placeOrder();
      expect(order.status).toBe(OrderStatus.CONFIRMED);

      // 2. The notification is queued, not attempted, by the checkout path.
      await dispatcher.dispatchOnce();
      let row = (await notifications({ channel: NotificationChannel.WHATSAPP }))[0]!;
      expect(row.status).toBe(NotificationStatus.PENDING);
      expect(row.attempts).toBe(0);

      // 3. The first send fails and schedules a retry rather than giving up.
      await sender.sendOnce();
      row = await context.admin.notification.findUniqueOrThrow({ where: { id: row.id } });

      expect(row.status).toBe(NotificationStatus.PENDING);
      expect(row.attempts).toBe(1);
      expect(row.lastError).toContain('unavailable');
      expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

      // 4. And the order is untouched by any of it.
      const stored = await context.admin.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(stored.status).toBe(OrderStatus.CONFIRMED);

      // 5. The backoff holds: nothing is attempted before the retry is due.
      await sender.sendOnce();
      row = await context.admin.notification.findUniqueOrThrow({ where: { id: row.id } });
      expect(row.attempts).toBe(1);

      // 6. The provider comes back and the retry comes due.
      provider.setAvailable(true);
      await context.admin.notification.update({
        where: { id: row.id },
        data: { nextAttemptAt: new Date(Date.now() - 1_000) },
      });

      await sender.sendOnce();
      row = await context.admin.notification.findUniqueOrThrow({ where: { id: row.id } });

      expect(row.status).toBe(NotificationStatus.SENT);
      expect(row.attempts).toBe(2);
      expect(row.providerMessageId).toBeTruthy();
      expect(provider.messages()).toHaveLength(1);

      await closeServiceWindow();
    });

    it('gives up after the maximum attempts instead of retrying forever', async () => {
      await openServiceWindow();
      provider.setAvailable(false);

      await placeOrder();
      await dispatcher.dispatchOnce();
      const queued = (await notifications({ channel: NotificationChannel.WHATSAPP }))[0]!;

      for (let attempt = 0; attempt < MAX_NOTIFICATION_ATTEMPTS; attempt += 1) {
        await context.admin.notification.updateMany({
          where: { id: queued.id },
          data: { nextAttemptAt: new Date(Date.now() - 1_000) },
        });
        await sender.sendOnce();
      }

      const row = await context.admin.notification.findUniqueOrThrow({
        where: { id: queued.id },
      });

      expect(row.status).toBe(NotificationStatus.FAILED);
      expect(row.attempts).toBe(MAX_NOTIFICATION_ATTEMPTS);
      expect(row.failedAt).not.toBeNull();
      // Finished, one way or another: nothing left for the sender to pick up.
      expect(row.nextAttemptAt).toBeNull();

      provider.setAvailable(true);
      await closeServiceWindow();
    });
  });

  describe('the worker role', () => {
    it('can schedule notifications without being able to read them', async () => {
      await placeOrder();
      await dispatcher.dispatchOnce();

      // It learns that this tenant has work...
      const scheduling = await workerPrisma.$queryRawUnsafe<Array<{ tenant_id: string }>>(
        'SELECT DISTINCT tenant_id FROM notifications',
      );
      expect(scheduling.length).toBeGreaterThan(0);

      // ...and is refused the message and the recipient, at the database.
      await expect(
        workerPrisma.$queryRawUnsafe('SELECT destination FROM notifications LIMIT 1'),
      ).rejects.toThrow();
      await expect(
        workerPrisma.$queryRawUnsafe('SELECT payload FROM notifications LIMIT 1'),
      ).rejects.toThrow();
      await expect(
        workerPrisma.$queryRawUnsafe('SELECT phone FROM customers LIMIT 1'),
      ).rejects.toThrow();
    });
  });
});
