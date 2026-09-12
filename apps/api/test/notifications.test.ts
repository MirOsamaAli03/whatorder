import {
  ConsentStatus,
  NotificationChannel,
  NotificationStatus,
  RecipientType,
  SystemRole,
  WhatsAppTemplateCategory,
  WhatsAppTemplateStatus,
} from '@restaurant-os/types';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
 * Notification settings, consent, and the inbound WhatsApp webhook
 * (ENGINEERING_SPEC.md 30, 31, 51, 68; plan 2.2, 2.4).
 *
 * The delivery pipeline itself — dispatcher, sender, retry, and the plan's exit
 * criterion — is in notifications-pipeline.test.ts.
 */
describe('notification settings and whatsapp webhook', () => {
  let context: TestContext;
  let tenant: TestTenant;
  let other: TestTenant;
  const created: TestTenant[] = [];

  let ownerToken: string;
  let otherToken: string;
  let branchId: string;
  let accountId: string;
  const phoneNumberId = `pn-${randomUUID().slice(0, 12)}`;

  beforeAll(async () => {
    context = await createTestContext();
    await ensureReferenceData(context.admin);

    tenant = await createTenant(context.admin, {
      slug: 'notify-chain',
      branchSlugs: ['dha', 'clifton'],
      users: [
        { key: 'owner', role: SystemRole.OWNER },
        { key: 'kitchen', role: SystemRole.KITCHEN_STAFF, branches: [0] },
      ],
    });

    other = await createTenant(context.admin, {
      slug: 'notify-rival',
      branchSlugs: ['main'],
      users: [{ key: 'owner', role: SystemRole.OWNER }],
    });

    created.push(tenant, other);
    ownerToken = await login(context.app, tenant.users.owner!.email);
    otherToken = await login(context.app, other.users.owner!.email);
    branchId = tenant.branchIds[0]!;
  });

  afterAll(async () => {
    await cleanupTenants(context.admin, created);
    await context.close();
  });

  const get = (url: string, token = ownerToken) =>
    context.app.inject({ method: 'GET', url, headers: authHeaders(token) });
  const post = (url: string, payload: Record<string, unknown>, token = ownerToken) =>
    context.app.inject({ method: 'POST', url, headers: authHeaders(token), payload });
  const patch = (url: string, payload: Record<string, unknown>, token = ownerToken) =>
    context.app.inject({ method: 'PATCH', url, headers: authHeaders(token), payload });
  const put = (url: string, payload: Record<string, unknown>, token = ownerToken) =>
    context.app.inject({ method: 'PUT', url, headers: authHeaders(token), payload });

  describe('preferences', () => {
    it('reports every channel as enabled before anything is configured', async () => {
      // Absence means "default on": a tenant who has never opened the settings
      // page still gets their order notifications.
      const response = await get('/api/v1/notifications/preferences');
      expect(response.statusCode).toBe(200);

      const preferences = response.json().data as Array<{ enabled: boolean }>;
      expect(preferences).toHaveLength(
        Object.keys(RecipientType).length * Object.keys(NotificationChannel).length,
      );
      expect(preferences.every((preference) => preference.enabled)).toBe(true);
    });

    it('saves a choice and leaves the rest alone', async () => {
      const response = await put('/api/v1/notifications/preferences', {
        preferences: [
          {
            recipientType: RecipientType.CUSTOMER,
            channel: NotificationChannel.SMS,
            enabled: false,
          },
        ],
      });

      expect(response.statusCode).toBe(200);
      const preferences = response.json().data as Array<{
        recipientType: string;
        channel: string;
        enabled: boolean;
      }>;

      const sms = preferences.find(
        (preference) =>
          preference.recipientType === RecipientType.CUSTOMER &&
          preference.channel === NotificationChannel.SMS,
      );
      const whatsapp = preferences.find(
        (preference) =>
          preference.recipientType === RecipientType.CUSTOMER &&
          preference.channel === NotificationChannel.WHATSAPP,
      );

      expect(sms?.enabled).toBe(false);
      expect(whatsapp?.enabled).toBe(true);
    });
  });

  describe('whatsapp accounts (plan 2.4)', () => {
    it('connects a number without ever handing the credentials back', async () => {
      const response = await post('/api/v1/notifications/whatsapp/accounts', {
        phoneNumberId,
        displayNumber: '03001112222',
        branchId,
        provider: 'log',
        credentials: { accessToken: 'super-secret-token' },
      });

      expect(response.statusCode).toBe(201);
      const account = response.json().data;
      accountId = account.id;

      expect(account.displayNumber).toBe('+923001112222');
      // A settings page that displays a provider access token is one
      // screenshot away from leaking it.
      expect(account.hasCredentials).toBe(true);
      expect(JSON.stringify(account)).not.toContain('super-secret-token');
    });

    it('refuses a number that another organization already uses', async () => {
      // phone_number_id is how an inbound webhook is routed. Two tenants
      // claiming one number would send one restaurant's orders to the other.
      const response = await post(
        '/api/v1/notifications/whatsapp/accounts',
        { phoneNumberId, displayNumber: '03009998888', provider: 'log' },
        otherToken,
      );

      expect(response.statusCode).toBe(409);
    });

    it('hides one tenant’s numbers from another', async () => {
      const response = await get('/api/v1/notifications/whatsapp/accounts', otherToken);
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual([]);
    });

    it('requires organization.manage to connect a number', async () => {
      const kitchenToken = await login(context.app, tenant.users.kitchen!.email);
      const response = await post(
        '/api/v1/notifications/whatsapp/accounts',
        { phoneNumberId: `pn-${randomUUID().slice(0, 8)}`, displayNumber: '03001234567' },
        kitchenToken,
      );
      expect(response.statusCode).toBe(403);
    });
  });

  describe('whatsapp templates (plan 2.2)', () => {
    let templateId: string;

    it('creates a template as DRAFT, whatever the caller wants', async () => {
      const response = await post('/api/v1/notifications/whatsapp/templates', {
        accountId,
        templateKey: 'order_confirmed',
        providerName: 'order_confirmed_v1',
        category: WhatsAppTemplateCategory.UTILITY,
        body: 'Hi {{1}}, order {{2}} at {{3}} is confirmed.',
      });

      expect(response.statusCode).toBe(201);
      const template = response.json().data;
      templateId = template.id;

      // Only Meta can approve a template. One we marked approved ourselves
      // would be attempted and rejected at send time — once per retry.
      expect(template.status).toBe(WhatsAppTemplateStatus.DRAFT);
      expect(template.approvedAt).toBeNull();
    });

    it('records an approval', async () => {
      const response = await patch(`/api/v1/notifications/whatsapp/templates/${templateId}`, {
        status: WhatsAppTemplateStatus.APPROVED,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.status).toBe(WhatsAppTemplateStatus.APPROVED);
      expect(response.json().data.approvedAt).not.toBeNull();
    });

    it('records a rejection with the reason the restaurant has to act on', async () => {
      const response = await patch(`/api/v1/notifications/whatsapp/templates/${templateId}`, {
        status: WhatsAppTemplateStatus.REJECTED,
        rejectionReason: 'Template contains promotional content in a utility category',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.rejectionReason).toContain('promotional content');
    });

    it('restores it for the pipeline tests', async () => {
      await patch(`/api/v1/notifications/whatsapp/templates/${templateId}`, {
        status: WhatsAppTemplateStatus.APPROVED,
        rejectionReason: null,
      });
    });
  });

  describe('customer consent (plan 2.4)', () => {
    let customerId: string;

    beforeAll(async () => {
      const response = await post('/api/v1/customers', {
        phone: '03007654321',
        name: 'Ayesha',
      });
      customerId = response.json().data.id;
    });

    it('records opt-in with when and how, not merely a boolean', async () => {
      const response = await post(`/api/v1/customers/${customerId}/consents`, {
        channel: NotificationChannel.WHATSAPP,
        status: ConsentStatus.GRANTED,
        source: 'WHATSAPP_REPLY',
        evidence: 'Customer replied START on 12 September',
      });

      expect(response.statusCode).toBe(201);
      const consent = response.json().data;
      expect(consent.status).toBe(ConsentStatus.GRANTED);
      expect(consent.grantedAt).not.toBeNull();
      expect(consent.evidence).toContain('START');
    });

    it('keeps both timestamps when consent is withdrawn', async () => {
      // The useful question is usually "were we allowed to send that, at the
      // time we sent it", which a single mutable boolean cannot answer.
      const response = await post(`/api/v1/customers/${customerId}/consents`, {
        channel: NotificationChannel.WHATSAPP,
        status: ConsentStatus.REVOKED,
        source: 'WHATSAPP_REPLY',
      });

      const consent = response.json().data;
      expect(consent.status).toBe(ConsentStatus.REVOKED);
      expect(consent.revokedAt).not.toBeNull();
      expect(consent.grantedAt).not.toBeNull();

      const all = await get(`/api/v1/customers/${customerId}/consents`);
      expect(all.json().data).toHaveLength(1);
    });

    it('refuses to read another tenant’s customer', async () => {
      const response = await get(`/api/v1/customers/${customerId}/consents`, otherToken);
      expect(response.statusCode).toBe(404);
    });
  });

  describe('the inbound webhook (spec 68)', () => {
    const contact = '923007654321';

    const deliver = (payload: Record<string, unknown>) =>
      context.app.inject({ method: 'POST', url: '/api/v1/webhooks/whatsapp', payload });

    function messagePayload(messageId: string, targetPhoneNumberId = phoneNumberId) {
      return {
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: targetPhoneNumberId },
                  messages: [
                    {
                      id: messageId,
                      from: contact,
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: 'text',
                      text: { body: 'Kya aaj biryani hai?' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
    }

    it('records an inbound message, which is what opens the 24-hour window', async () => {
      const messageId = `wamid-${randomUUID()}`;
      const response = await deliver(messagePayload(messageId));

      expect(response.statusCode).toBe(201);
      expect(response.json().data.accepted).toBe(1);

      const stored = await context.admin.whatsAppMessage.findFirst({
        where: { providerMessageId: messageId },
      });

      expect(stored).toBeTruthy();
      expect(stored!.direction).toBe('INBOUND');
      expect(stored!.contactNumber).toBe('+923007654321');
      // Linked to the customer created above, by number.
      expect(stored!.customerId).not.toBeNull();
    });

    it('ignores a replayed delivery', async () => {
      const messageId = `wamid-${randomUUID()}`;
      await deliver(messagePayload(messageId));
      const replay = await deliver(messagePayload(messageId));

      expect(replay.json().data.accepted).toBe(0);

      const count = await context.admin.whatsAppMessage.count({
        where: { providerMessageId: messageId },
      });
      expect(count).toBe(1);
    });

    it('records a callback for an unknown number instead of dropping it', async () => {
      // An onboarding mistake that silently discards traffic is
      // indistinguishable from a quiet day.
      const unknown = `pn-unknown-${randomUUID().slice(0, 8)}`;
      const messageId = `wamid-${randomUUID()}`;

      const response = await deliver(messagePayload(messageId, unknown));
      expect(response.statusCode).toBe(201);
      expect(response.json().data.ignored).toBe(1);

      const recorded = await context.admin.inboundWebhookEvent.findFirst({
        where: { providerEventId: `msg:${messageId}` },
      });

      expect(recorded).toBeTruthy();
      expect(recorded!.tenantId).toBeNull();
      expect(recorded!.error).toContain(unknown);

      await context.admin.inboundWebhookEvent.deleteMany({ where: { id: recorded!.id } });
    });

    it('marks a notification delivered when the receipt arrives', async () => {
      const providerMessageId = `wamid-${randomUUID()}`;

      const notification = await context.admin.notification.create({
        data: {
          tenantId: tenant.organizationId,
          branchId,
          eventId: randomUUID(),
          eventType: 'OrderStatusChanged',
          recipientType: RecipientType.CUSTOMER,
          recipientId: randomUUID(),
          destination: '+923007654321',
          channel: NotificationChannel.WHATSAPP,
          templateKey: 'order_confirmed',
          status: NotificationStatus.SENT,
          providerMessageId,
          sentAt: new Date(),
        },
      });

      const response = await deliver({
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: phoneNumberId },
                  statuses: [
                    {
                      id: providerMessageId,
                      status: 'delivered',
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      recipient_id: contact,
                    },
                  ],
                },
              },
            ],
          },
        ],
      });

      expect(response.json().data.accepted).toBe(1);

      const updated = await context.admin.notification.findUniqueOrThrow({
        where: { id: notification.id },
      });

      // "Sent" and "reached the customer's phone" stay distinguishable.
      expect(updated.status).toBe(NotificationStatus.DELIVERED);
      expect(updated.deliveredAt).not.toBeNull();
    });

    it('returns a failed message to the retry ladder', async () => {
      const providerMessageId = `wamid-${randomUUID()}`;

      const notification = await context.admin.notification.create({
        data: {
          tenantId: tenant.organizationId,
          branchId,
          eventId: randomUUID(),
          eventType: 'OrderStatusChanged',
          recipientType: RecipientType.CUSTOMER,
          recipientId: randomUUID(),
          destination: '+923007654321',
          channel: NotificationChannel.WHATSAPP,
          templateKey: 'order_ready',
          status: NotificationStatus.SENT,
          providerMessageId,
          sentAt: new Date(),
        },
      });

      await deliver({
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: phoneNumberId },
                  statuses: [
                    {
                      id: providerMessageId,
                      status: 'failed',
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      recipient_id: contact,
                      errors: [{ title: 'Message undeliverable' }],
                    },
                  ],
                },
              },
            ],
          },
        ],
      });

      const updated = await context.admin.notification.findUniqueOrThrow({
        where: { id: notification.id },
      });

      expect(updated.status).toBe(NotificationStatus.PENDING);
      expect(updated.lastError).toContain('undeliverable');
      // The id belonged to the attempt that failed; leaving it would make a
      // later receipt update the wrong row.
      expect(updated.providerMessageId).toBeNull();
    });

    it('survives a payload it cannot parse', async () => {
      // Anything but a 200 earns the same unparseable payload again, forever.
      const response = await deliver({ object: 'something_else', entry: 'not an array' });
      expect(response.statusCode).toBe(201);
      expect(response.json().data.accepted).toBe(0);
    });

    it('echoes the handshake challenge bare, without this API’s envelope', async () => {
      // Meta compares the response body to the challenge it sent. Wrapped in
      // the standard success envelope it is not a match, and the webhook simply
      // cannot be registered — a failure at onboarding, long before a message
      // is involved.
      const response = await context.app.inject({
        method: 'GET',
        url: '/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=CHALLENGE123',
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('CHALLENGE123');
    });

    it('rejects the subscription handshake without the verify token', async () => {
      const response = await context.app.inject({
        method: 'GET',
        url: '/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1',
      });
      expect(response.statusCode).toBe(403);
    });
  });
});
