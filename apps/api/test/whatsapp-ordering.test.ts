import {
  ConversationState,
  OrderSource,
  OrderStatus,
  OrderType,
  SystemRole,
} from '@restaurant-os/types';
import type { LogWhatsAppProvider, OutboundMessage } from '@restaurant-os/whatsapp';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
 * WhatsApp inbound ordering (ENGINEERING_SPEC.md 21, 22, 23; plan Phase 6).
 *
 * Driven entirely through the webhook, exactly as Meta would: every customer
 * message is an HTTP POST carrying a provider payload, and every reply is read
 * back from the provider the application actually sent it to. Nothing is
 * stubbed between the two — not the conversation engine, not the cart, not the
 * order service, not the database.
 *
 * This file contains the plan's Phase 6 exit criterion, the §71 end-to-end:
 *
 *   WhatsApp order → kitchen → delivery → completion
 */
describe('whatsapp ordering', () => {
  let context: TestContext;
  let tenant: TestTenant;
  const created: TestTenant[] = [];

  let ownerToken: string;
  let branchId: string;
  let burgerId: string;
  let friesId: string;
  let provider: LogWhatsAppProvider;

  const phoneNumberId = `pn-order-${randomUUID().slice(0, 8)}`;
  /** As WhatsApp reports it: no leading plus. */
  const customer = '923009998877';
  const customerE164 = '+923009998877';

  beforeAll(async () => {
    context = await createTestContext();
    await ensureReferenceData(context.admin);

    tenant = await createTenant(context.admin, {
      slug: 'whatsapp-kitchen',
      branchSlugs: ['main'],
      users: [{ key: 'owner', role: SystemRole.OWNER }],
    });
    created.push(tenant);

    ownerToken = await login(context.app, tenant.users.owner!.email);
    branchId = tenant.branchIds[0]!;

    await context.admin.organization.update({
      where: { id: tenant.organizationId },
      data: { name: 'Karachi Grill', settings: { taxPercent: 0, deliveryFee: '150.00' } },
    });

    const category = await post('/api/v1/menu/categories', { name: 'Burgers' });
    const categoryId = category.json().data.id;

    burgerId = (
      await post('/api/v1/menu/items', {
        name: 'Chicken Burger',
        basePrice: '450.00',
        categoryId,
      })
    ).json().data.id;

    friesId = (
      await post('/api/v1/menu/items', { name: 'Fries', basePrice: '250.00', categoryId })
    ).json().data.id;

    await post('/api/v1/notifications/whatsapp/accounts', {
      phoneNumberId,
      displayNumber: '03001112233',
      branchId,
      provider: 'log',
    });

    // The provider the application itself sends through — not a substitute
    // wired in for the test.
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

  function post(url: string, payload: Record<string, unknown>, token = ownerToken) {
    return context.app.inject({ method: 'POST', url, headers: authHeaders(token), payload });
  }

  /** One customer message, delivered the way Meta delivers it. */
  async function say(text: string): Promise<OutboundMessage[]> {
    return deliver({
      id: `wamid-${randomUUID()}`,
      from: customer,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'text',
      text: { body: text },
    });
  }

  /** One tap on a list row or a reply button. */
  async function tap(id: string, title = 'tapped'): Promise<OutboundMessage[]> {
    return deliver({
      id: `wamid-${randomUUID()}`,
      from: customer,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'interactive',
      interactive: { type: 'list_reply', list_reply: { id, title } },
    });
  }

  async function deliver(message: Record<string, unknown>): Promise<OutboundMessage[]> {
    const before = provider.messages().length;

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/whatsapp',
      payload: {
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: { metadata: { phone_number_id: phoneNumberId }, messages: [message] },
              },
            ],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    return provider.messages().slice(before).map((logged) => logged.message);
  }

  /** Every row id offered across a list message's sections. */
  function rowIds(message: OutboundMessage): string[] {
    if (message.kind !== 'list') return [];
    return message.sections.flatMap((section) => section.rows.map((row) => row.id));
  }

  function bodies(messages: OutboundMessage[]): string {
    return messages
      .map((message) => (message.kind === 'template' ? message.renderedBody : message.body))
      .join('\n');
  }

  function session() {
    return context.admin.conversationSession.findFirstOrThrow({
      where: { tenantId: tenant.organizationId, externalUserId: customerE164 },
    });
  }

  describe('the deterministic flow (plan 2.2)', () => {
    it('greets a first-time customer by name of the restaurant, with buttons', async () => {
      const replies = await say('Assalam o Alaikum');

      expect(bodies(replies)).toContain('Karachi Grill');
      // Affordances, not a command line: a conversational interface with no
      // visible options is a manual nobody was given.
      const buttons = replies.find((message) => message.kind === 'buttons');
      expect(buttons?.kind).toBe('buttons');
      expect(buttons && buttons.kind === 'buttons' ? buttons.buttons.map((b) => b.title) : []).toEqual(
        ['Browse menu', 'Track order', 'Talk to us'],
      );
    });

    it('records the inbound message, which is what opens the service window', async () => {
      const inbound = await context.admin.whatsAppMessage.findFirst({
        where: { tenantId: tenant.organizationId, direction: 'INBOUND' },
        orderBy: { occurredAt: 'desc' },
      });

      expect(inbound?.contactNumber).toBe(customerE164);
    });

    it('shows the menu as a tappable list, priced by the server', async () => {
      const replies = await say('menu dikhao');
      const list = replies.find((message) => message.kind === 'list');

      expect(list).toBeTruthy();
      // A single category is skipped: making somebody tap through a list of one
      // reads as a bot written by somebody who never used it.
      expect(rowIds(list!)).toContain(`item:${burgerId}`);
      expect(bodies(replies)).not.toContain('undefined');

      const stored = await session();
      expect(stored.state).toBe(ConversationState.BROWSING_MENU);
    });

    it('asks how many when a dish is tapped', async () => {
      const replies = await tap(`item:${burgerId}`, 'Chicken Burger');

      expect(bodies(replies)).toContain('Chicken Burger');
      const buttons = replies.find((message) => message.kind === 'buttons');
      expect(
        buttons && buttons.kind === 'buttons' ? buttons.buttons.map((b) => b.id) : [],
      ).toEqual(['qty:1', 'qty:2', 'qty:3']);
    });

    it('adds the dish and shows a total it computed itself', async () => {
      const replies = await tap('qty:2', '2');
      const text = bodies(replies);

      expect(text).toContain('2 x Chicken Burger');
      // 2 x 450.00, priced by the pricing engine. The conversation never sent
      // a price and could not have (invariant 4, spec 27).
      expect(text).toContain('900.00');

      const stored = await session();
      expect(stored.state).toBe(ConversationState.BUILDING_CART);
      expect((stored.context as { cartId?: string }).cartId).toBeTruthy();
    });

    it('understands a typed quantity exactly as a tapped one', async () => {
      await tap(`item:${friesId}`, 'Fries');
      const replies = await say('1');

      expect(bodies(replies)).toContain('1 x Fries');
      expect(bodies(replies)).toContain('1150.00');
    });

    it('offers only the order types the branch actually supports', async () => {
      await context.admin.branch.update({
        where: { id: branchId },
        data: { dineInEnabled: false, deliveryEnabled: true, pickupEnabled: true },
      });

      const replies = await tap('checkout', 'Checkout');
      const buttons = replies.find((message) => message.kind === 'buttons');
      const titles =
        buttons && buttons.kind === 'buttons' ? buttons.buttons.map((b) => b.title) : [];

      // Offering dine-in at a branch that does not do it wastes a tap and then
      // has to be refused.
      expect(titles).toEqual(['Delivery', 'Pickup']);
      expect((await session()).state).toBe(ConversationState.SELECTING_ORDER_TYPE);
    });

    it('asks for an address when the order is a delivery', async () => {
      const replies = await tap(`type:${OrderType.DELIVERY}`, 'Delivery');

      expect(bodies(replies)).toContain('address');
      expect((await session()).state).toBe(ConversationState.ASKING_ADDRESS);
    });

    it('refuses an address too short to send a rider to', async () => {
      const replies = await say('dha');

      expect(bodies(replies)).toContain('short');
      // Still waiting, rather than accepting it and failing at the door.
      expect((await session()).state).toBe(ConversationState.ASKING_ADDRESS);
    });

    it('confirms with the delivery fee the server added', async () => {
      const replies = await say('House 12, Street 4, Phase 6, DHA, Karachi');
      const text = bodies(replies);

      expect(text).toContain('Delivery');
      expect(text).toContain('cash on delivery');
      // 1150.00 of food plus the tenant's 150.00 delivery fee. Neither number
      // came from the conversation.
      expect(text).toContain('1300.00');
      expect((await session()).state).toBe(ConversationState.CONFIRMING_ORDER);
    });
  });

  /**
   * The plan's Phase 6 exit criterion, stated as a test.
   */
  describe('the end-to-end (spec 71)', () => {
    let orderId: string;
    let orderNumber: string;

    it('places the order through the same service the POS uses', async () => {
      const replies = await tap('confirm', 'Place order');
      const text = bodies(replies);

      const order = await context.admin.order.findFirstOrThrow({
        where: { tenantId: tenant.organizationId },
        orderBy: { createdAt: 'desc' },
      });

      orderId = order.id;
      orderNumber = order.orderNumber;

      expect(text).toContain(order.orderNumber);
      expect(order.source).toBe(OrderSource.WHATSAPP);
      expect(order.orderType).toBe(OrderType.DELIVERY);
      // A cash order is CONFIRMED on placement, which is what starts the
      // acknowledgement clock (spec 33).
      expect(order.status).toBe(OrderStatus.CONFIRMED);
      expect(order.total.toFixed(2)).toBe('1300.00');

      // The customer was created from the number they messaged from.
      const customerRow = await context.admin.customer.findFirstOrThrow({
        where: { id: order.customerId! },
      });
      expect(customerRow.phone).toBe(customerE164);

      expect((await session()).state).toBe(ConversationState.TRACKING_ORDER);
    });

    it('puts the order in front of the kitchen', async () => {
      const snapshot = await context.app.inject({
        method: 'GET',
        url: `/api/v1/kds/branches/${branchId}/snapshot`,
        headers: authHeaders(ownerToken),
      });

      const card = snapshot
        .json()
        .data.columns.NEW.find((entry: { id: string }) => entry.id === orderId);

      expect(card).toBeTruthy();
      expect(card.items.map((item: { name: string }) => item.name).sort()).toEqual([
        'Chicken Burger',
        'Fries',
      ]);
      // A cook needs the dish and the clock, not the money or the number (§11).
      expect(JSON.stringify(card)).not.toContain(customerE164);
    });

    it('tells the customer where the order is, in words', async () => {
      const replies = await say('mera order kahan hai');

      expect(bodies(replies)).toContain(orderNumber);
      expect(bodies(replies)).toContain('awaiting the kitchen');
      // Never the raw status: "CONFIRMED" means nothing to somebody waiting.
      expect(bodies(replies)).not.toContain('CONFIRMED');
    });

    it('runs through the kitchen to delivery', async () => {
      const transition = (status: OrderStatus) =>
        post(`/api/v1/orders/${orderId}/transition`, { status });

      for (const status of [
        OrderStatus.ACCEPTED,
        OrderStatus.PREPARING,
        OrderStatus.READY,
        OrderStatus.OUT_FOR_DELIVERY,
        OrderStatus.DELIVERED,
      ]) {
        const response = await transition(status);
        expect(response.statusCode, status).toBe(200);
      }

      const order = await context.admin.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe(OrderStatus.DELIVERED);

      // DELIVERED is terminal for a delivery order — that IS its completion.
      // COMPLETED is where pickup and dine-in end, and the state machine
      // refuses to move an already-delivered order anywhere at all.
      const beyond = await transition(OrderStatus.COMPLETED);
      expect(beyond.statusCode).toBe(409);
    });

    it('reports the finished order back to the customer', async () => {
      const replies = await say('track');
      expect(bodies(replies)).toContain('delivered');
    });

    it('queued the customer notifications the whole way through', async () => {
      // The bot does not send order updates itself — Phase 5's pipeline does,
      // from the outbox. The channel adapter and the notification pipeline meet
      // here, and neither knows about the other.
      const events = await context.admin.outboxEvent.findMany({
        where: { tenantId: tenant.organizationId, aggregateId: orderId },
      });

      const statuses = events
        .map((event) => (event.payload as { toStatus?: string }).toStatus)
        .filter(Boolean);

      expect(statuses).toEqual(
        expect.arrayContaining([
          OrderStatus.CONFIRMED,
          OrderStatus.READY,
          OrderStatus.OUT_FOR_DELIVERY,
          OrderStatus.DELIVERED,
        ]),
      );
    });
  });

  describe('the boundaries', () => {
    it('goes quiet once a person takes over', async () => {
      const handoff = await say('I want to talk to a human');
      expect(bodies(handoff)).toContain('team');
      expect((await session()).state).toBe(ConversationState.HUMAN_HANDOFF);

      // The bot must not reply over the top of the person now dealing with it.
      const afterwards = await say('hello? menu?');
      expect(afterwards).toEqual([]);

      // But the customer's message is still recorded, so the person sees it.
      const stored = await session();
      expect(stored.lastInboundAt).not.toBeNull();
      expect(stored.state).toBe(ConversationState.HUMAN_HANDOFF);
    });

    it('says what it can do rather than guessing', async () => {
      // Reset out of the handoff, as a person ending it would.
      await context.admin.conversationSession.updateMany({
        where: { tenantId: tenant.organizationId, externalUserId: customerE164 },
        data: { state: ConversationState.IDLE, context: {} },
      });

      const replies = await say('%%%');
      expect(bodies(replies)).toContain('menu');
    });

    it('keeps one conversation per customer, not one per message', async () => {
      const sessions = await context.admin.conversationSession.findMany({
        where: { tenantId: tenant.organizationId, externalUserId: customerE164 },
      });

      // Two would mean two half-built carts and replies landing in whichever
      // the code happened to load.
      expect(sessions).toHaveLength(1);
    });

    it('answers a replayed message exactly once', async () => {
      const message = {
        id: `wamid-${randomUUID()}`,
        from: customer,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'text',
        text: { body: 'menu' },
      };

      const first = await deliver(message);
      const second = await deliver(message);

      expect(first.length).toBeGreaterThan(0);
      // Replay protection means the second delivery produces no reply at all —
      // a customer must not be answered twice for one thing they said.
      expect(second).toEqual([]);
    });
  });

  describe('the channel principal', () => {
    it('acts as a real, narrowly-scoped member of the organization', async () => {
      const order = await context.admin.order.findFirstOrThrow({
        where: { tenantId: tenant.organizationId },
        orderBy: { createdAt: 'desc' },
      });

      const audit = await context.admin.auditLog.findFirst({
        where: { tenantId: tenant.organizationId, entityType: 'Order', entityId: order.id },
      });

      expect(audit?.actorId).toBeTruthy();

      const membership = await context.admin.membership.findFirstOrThrow({
        where: { tenantId: tenant.organizationId, userId: audit!.actorId! },
        include: { roles: { include: { role: true } }, branches: true },
      });

      expect(membership.roles.map((link) => link.role.name)).toEqual([SystemRole.CHANNEL_BOT]);
      // Confined to the branch whose number the customer messaged, so a routing
      // mistake is refused rather than silently obeyed.
      expect(membership.branches.map((branch) => branch.branchId)).toEqual([branchId]);
    });

    it('cannot move an order through the kitchen', async () => {
      const role = await context.admin.role.findFirstOrThrow({
        where: { tenantId: null, name: SystemRole.CHANNEL_BOT },
        include: { permissions: { include: { permission: true } } },
      });

      const granted = role.permissions.map((link) => link.permission.key);

      // A message from a customer must never advance an order, or the kitchen
      // display becomes a suggestion.
      expect(granted).not.toContain('orders.update');
      expect(granted).not.toContain('orders.cancel');
      expect(granted).not.toContain('payments.refund');
      expect(granted).toContain('orders.create');
    });
  });
});
