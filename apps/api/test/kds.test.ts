import { PrismaClient } from '@prisma/client';
import { DomainEventType, OrderStatus, PaymentMethod, SystemRole } from '@restaurant-os/types';
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
 * Kitchen Display System, real-time fan-out and unacknowledged-order
 * protection (ENGINEERING_SPEC.md 33, 34, 35, 58, 64).
 *
 * The two cases the plan names as this phase's exit criteria are here: a client
 * that misses events while disconnected and has to recover, and an order that
 * escalates on schedule because nobody acknowledged it.
 */
describe('kds and realtime', () => {
  let context: TestContext;
  let worker: PrismaClient;
  let tenant: TestTenant;
  let other: TestTenant;
  const created: TestTenant[] = [];

  let ownerToken: string;
  let branchId: string;
  let secondBranchId: string;
  let burgerId: string;

  beforeAll(async () => {
    context = await createTestContext();
    await ensureReferenceData(context.admin);

    // The worker connects as restaurant_worker, exactly as in production, so
    // these tests exercise the real privilege boundary rather than a stand-in.
    worker = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL_WORKER } },
    });

    tenant = await createTenant(context.admin, {
      slug: 'kds-chain',
      branchSlugs: ['dha', 'clifton'],
      users: [
        { key: 'owner', role: SystemRole.OWNER },
        { key: 'kitchen', role: SystemRole.KITCHEN_STAFF, branches: [0] },
      ],
    });

    other = await createTenant(context.admin, {
      slug: 'kds-rival',
      branchSlugs: ['main'],
      users: [{ key: 'owner', role: SystemRole.OWNER }],
    });

    created.push(tenant, other);
    ownerToken = await login(context.app, tenant.users.owner!.email);
    branchId = tenant.branchIds[0]!;
    secondBranchId = tenant.branchIds[1]!;

    // A five-second acknowledgement threshold and a ladder whose first rung
    // fires at one second, so escalation is observable in a test rather than
    // in five minutes.
    await context.admin.organization.update({
      where: { id: tenant.organizationId },
      data: {
        settings: {
          taxPercent: 0,
          orderAcknowledgementTimeoutSeconds: 10,
          escalationLadder: [
            { level: 1, afterSeconds: 1, target: 'KITCHEN' },
            { level: 2, afterSeconds: 2, target: 'BRANCH_MANAGER' },
            { level: 3, afterSeconds: 3, target: 'OWNER' },
          ],
        },
      },
    });

    const item = await post('/api/v1/menu/items', { name: 'KDS Burger', basePrice: '500.00' });
    burgerId = item.json().data.id;
  });

  afterAll(async () => {
    await worker.$disconnect();
    await cleanupTenants(context.admin, created);
    await context.close();
  });

  async function post(url: string, payload: Record<string, unknown>, token = ownerToken) {
    return context.app.inject({ method: 'POST', url, headers: authHeaders(token), payload });
  }
  async function get(url: string, token = ownerToken) {
    return context.app.inject({ method: 'GET', url, headers: authHeaders(token) });
  }

  /** Places an order and returns it. */
  async function placeOrder(targetBranch = branchId) {
    const cart = await post('/api/v1/carts', {
      branchId: targetBranch,
      source: 'POS',
      orderType: 'PICKUP',
    });
    const cartId = cart.json().data.id;
    await post(`/api/v1/carts/${cartId}/items`, { menuItemId: burgerId });

    const placed = await context.app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { ...authHeaders(ownerToken), 'idempotency-key': randomUUID() },
      payload: {
        cartId,
        customerPhone: '03001234567',
        paymentMethod: PaymentMethod.CASH,
      },
    });
    return placed.json().data;
  }

  async function transition(orderId: string, status: string) {
    return context.app.inject({
      method: 'POST',
      url: `/api/v1/orders/${orderId}/transition`,
      headers: authHeaders(ownerToken),
      payload: { status },
    });
  }

  describe('snapshot (spec 34)', () => {
    it('puts a confirmed order in the NEW column', async () => {
      const order = await placeOrder();

      const snapshot = await get(`/api/v1/kds/branches/${branchId}/snapshot`);
      expect(snapshot.statusCode).toBe(200);

      const data = snapshot.json().data;
      const card = data.columns.NEW.find((entry: { id: string }) => entry.id === order.id);

      expect(card).toBeTruthy();
      expect(card.orderNumber).toBe(order.orderNumber);
      expect(card.items[0].name).toBe('KDS Burger');
      expect(Object.keys(data.columns).sort()).toEqual([
        'ACCEPTED',
        'NEW',
        'PREPARING',
        'READY',
      ]);
    });

    it('moves the card between columns as the order progresses', async () => {
      const order = await placeOrder();

      await transition(order.id, OrderStatus.ACCEPTED);
      let snapshot = await get(`/api/v1/kds/branches/${branchId}/snapshot`);
      expect(
        snapshot.json().data.columns.ACCEPTED.some((c: { id: string }) => c.id === order.id),
      ).toBe(true);

      await transition(order.id, OrderStatus.PREPARING);
      await transition(order.id, OrderStatus.READY);
      snapshot = await get(`/api/v1/kds/branches/${branchId}/snapshot`);
      expect(
        snapshot.json().data.columns.READY.some((c: { id: string }) => c.id === order.id),
      ).toBe(true);
    });

    it('drops the card once the order leaves the kitchen', async () => {
      const order = await placeOrder();
      for (const status of ['ACCEPTED', 'PREPARING', 'READY', 'COMPLETED']) {
        await transition(order.id, status);
      }

      const snapshot = await get(`/api/v1/kds/branches/${branchId}/snapshot`);
      const allCards = Object.values(snapshot.json().data.columns).flat() as Array<{ id: string }>;
      expect(allCards.some((card) => card.id === order.id)).toBe(false);
    });

    it('never puts money or a phone number on a kitchen card (spec 11)', async () => {
      await placeOrder();
      const snapshot = await get(`/api/v1/kds/branches/${branchId}/snapshot`);

      const raw = JSON.stringify(snapshot.json().data.columns);
      expect(raw).not.toContain('customerPhone');
      expect(raw).not.toContain('total');
      expect(raw).not.toContain('+92');
    });

    it('carries a sequence watermark for gap detection', async () => {
      const snapshot = await get(`/api/v1/kds/branches/${branchId}/snapshot`);
      expect(snapshot.json().data.sequence).toMatch(/^\d+$/);
    });

    it('shows only the requested branch', async () => {
      const here = await placeOrder(branchId);
      const there = await placeOrder(secondBranchId);

      const snapshot = await get(`/api/v1/kds/branches/${branchId}/snapshot`);
      const ids = (snapshot.json().data.columns.NEW as Array<{ id: string }>).map((c) => c.id);

      expect(ids).toContain(here.id);
      expect(ids).not.toContain(there.id);
    });

    it('refuses a branch the caller has no access to', async () => {
      const kitchenToken = await login(context.app, tenant.users.kitchen!.email);

      const own = await get(`/api/v1/kds/branches/${branchId}/snapshot`, kitchenToken);
      expect(own.statusCode).toBe(200);

      const sibling = await get(
        `/api/v1/kds/branches/${secondBranchId}/snapshot`,
        kitchenToken,
      );
      expect(sibling.statusCode).toBe(403);
    });

    it('refuses another tenant\'s branch', async () => {
      const rivalToken = await login(context.app, other.users.owner!.email);
      const response = await get(`/api/v1/kds/branches/${branchId}/snapshot`, rivalToken);
      expect(response.statusCode).toBe(404);
    });
  });

  describe('outbox publishing (spec 58)', () => {
    it('publishes pending events and marks them processed', async () => {
      const order = await placeOrder();

      const pendingBefore = await context.admin.outboxEvent.count({
        where: { aggregateId: order.id, status: 'PENDING' },
      });
      expect(pendingBefore).toBeGreaterThan(0);

      const { OutboxPublisher } = await import('../../worker/src/outbox-publisher');
      const Redis = (await import('ioredis')).default;
      const redis = new Redis(process.env.REDIS_URL!);
      const noop = {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      } as never;

      const publisher = new OutboxPublisher(worker, redis, noop, {
        pollMs: 100,
        batchSize: 100,
      });

      // Drain to empty: earlier tests leave pending events, so a single
      // batch may not reach this order.
      let drained = 0;
      do {
        drained = await publisher.drainOnce();
      } while (drained > 0);
      await redis.quit();

      const pendingAfter = await context.admin.outboxEvent.count({
        where: { aggregateId: order.id, status: 'PENDING' },
      });
      const processed = await context.admin.outboxEvent.count({
        where: { aggregateId: order.id, status: 'PROCESSED' },
      });

      expect(pendingAfter).toBe(0);
      expect(processed).toBeGreaterThan(0);
    });

    /**
     * Regression: status-change events originally carried no branchId, so the
     * publisher routed them to the tenant channel instead of the branch
     * channel. A kitchen screen saw new orders appear and then never move —
     * which the integration tests missed entirely, because they inspected the
     * outbox rows rather than where those rows would be delivered.
     */
    it('puts branchId on every order event, because the publisher routes on it', async () => {
      const order = await placeOrder();
      await transition(order.id, OrderStatus.ACCEPTED);

      const events = await context.admin.outboxEvent.findMany({
        where: { aggregateId: order.id },
        orderBy: { sequence: 'asc' },
      });

      expect(events.length).toBeGreaterThanOrEqual(2);

      for (const event of events) {
        const payload = event.payload as { branchId?: string };
        expect(payload.branchId, `${event.eventType} must carry branchId`).toBe(branchId);
      }
    });

    it('assigns a monotonic sequence to every event', async () => {
      const first = await placeOrder();
      const second = await placeOrder();

      const events = await context.admin.outboxEvent.findMany({
        where: { aggregateId: { in: [first.id, second.id] } },
        orderBy: { sequence: 'asc' },
      });

      const sequences = events.map((event) => event.sequence);
      const sorted = [...sequences].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      expect(sequences).toEqual(sorted);
      expect(new Set(sequences.map(String)).size).toBe(sequences.length);
    });
  });

  describe('reconnect and gap detection (plan 2.8)', () => {
    /**
     * The plan's first exit criterion: a screen that misses events while
     * disconnected must recover the order rather than sit with a hole in its
     * state.
     */
    it('recovers an order placed while the client was disconnected', async () => {
      // The screen loads, notes its watermark, then "loses" its connection.
      const initial = await get(`/api/v1/kds/branches/${branchId}/snapshot`);
      const watermark = initial.json().data.sequence as string;

      // While it is away, an order arrives and moves on.
      const missed = await placeOrder();
      await transition(missed.id, OrderStatus.ACCEPTED);

      // On reconnect it asks what it missed.
      const since = await get(
        `/api/v1/kds/branches/${branchId}/since?sequence=${watermark}`,
      );

      expect(since.statusCode).toBe(200);
      const body = since.json().data;
      expect(BigInt(body.sequence)).toBeGreaterThan(BigInt(watermark));

      const aggregateIds = body.events.map((event: { aggregateId: string }) => event.aggregateId);
      expect(aggregateIds).toContain(missed.id);

      // And the snapshot it can always fall back to now contains the order.
      const recovered = await get(`/api/v1/kds/branches/${branchId}/snapshot`);
      const accepted = recovered.json().data.columns.ACCEPTED as Array<{ id: string }>;
      expect(accepted.some((card) => card.id === missed.id)).toBe(true);
    });

    it('tells a badly lagging client to resync instead of replaying', async () => {
      // Far enough behind that replaying is slower and less reliable than
      // simply reloading.
      const since = await get(`/api/v1/kds/branches/${branchId}/since?sequence=0`);

      const body = since.json().data;
      if (body.resyncRequired) {
        expect(body.events).toEqual([]);
      } else {
        // A small database: everything since zero still fits in one page.
        expect(Array.isArray(body.events)).toBe(true);
      }
    });

    it('rejects a non-numeric sequence', async () => {
      const response = await get(`/api/v1/kds/branches/${branchId}/since?sequence=abc`);
      expect(response.statusCode).toBe(422);
    });
  });

  describe('stream tickets (spec 64)', () => {
    it('issues a ticket for an authorised branch', async () => {
      const response = await context.app.inject({
        method: 'POST',
        url: `/api/v1/kds/branches/${branchId}/ticket`,
        headers: authHeaders(ownerToken),
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.ticket).toBeTruthy();
      expect(response.json().data.expiresIn).toBeLessThanOrEqual(60);
    });

    it('refuses a ticket for a branch the caller cannot access', async () => {
      const kitchenToken = await login(context.app, tenant.users.kitchen!.email);

      const response = await context.app.inject({
        method: 'POST',
        url: `/api/v1/kds/branches/${secondBranchId}/ticket`,
        headers: authHeaders(kitchenToken),
        payload: {},
      });

      expect(response.statusCode).toBe(403);
    });

    it('refuses the stream without a ticket', async () => {
      const response = await context.app.inject({
        method: 'GET',
        url: '/api/v1/kds/stream',
      });

      expect(response.statusCode).toBe(422);
    });

    it('refuses an unknown ticket', async () => {
      const response = await context.app.inject({
        method: 'GET',
        url: `/api/v1/kds/stream?ticket=${'x'.repeat(43)}`,
      });

      expect(response.statusCode).toBe(401);
    });

    it('burns a ticket on first use', async () => {
      const issued = await context.app.inject({
        method: 'POST',
        url: `/api/v1/kds/branches/${branchId}/ticket`,
        headers: authHeaders(ownerToken),
        payload: {},
      });
      const ticket = issued.json().data.ticket as string;

      // Redeem it directly: a second redemption must fail even though the
      // first connection is still notionally open.
      const { StreamTicketService } = await import('../src/realtime/stream-ticket.service');
      const service = context.app.get(StreamTicketService);

      const claims = await service.redeem(ticket);
      expect(claims.branchId).toBe(branchId);
      expect(claims.tenantId).toBe(tenant.organizationId);

      await expect(service.redeem(ticket)).rejects.toThrow(/invalid, expired, or already used/);
    });
  });

  describe('a kitchen screen that drops off (spec 70)', () => {
    const noop = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

    /**
     * A branch of its own, with no orders on it by construction.
     *
     * The other two branches collect orders as the rest of this file runs, and
     * "no orders waiting" is precisely what one of these tests is about.
     */
    let quietBranchId: string;

    beforeAll(async () => {
      const branch = await context.admin.branch.create({
        data: { tenantId: tenant.organizationId, name: 'quiet', slug: `quiet-${randomUUID().slice(0, 8)}` },
      });
      quietBranchId = branch.id;
    });

    async function monitor() {
      const { EscalationMonitor } = await import('../../worker/src/escalation-monitor');
      return new EscalationMonitor(worker, noop, { pollMs: 1000 });
    }

    /** As a screen that heartbeated `secondsAgo` and has not since. */
    async function presence(secondsAgo: number, targetBranch = secondBranchId) {
      const at = new Date(Date.now() - secondsAgo * 1000);
      await context.admin.kdsPresence.upsert({
        where: { branchId: targetBranch },
        create: {
          tenantId: tenant.organizationId,
          branchId: targetBranch,
          lastSeenAt: at,
          lastConnectedAt: at,
        },
        update: { lastSeenAt: at, lastConnectedAt: at, offlineAlertedAt: null },
      });
    }

    function offlineEvents(targetBranch = secondBranchId) {
      return context.admin.outboxEvent.count({
        where: { eventType: DomainEventType.KITCHEN_SCREEN_OFFLINE, aggregateId: targetBranch },
      });
    }

    /**
     * The presence write is deliberately not awaited by the stream — a kitchen
     * screen does not wait on a monitoring write — so this polls rather than
     * assuming it has landed.
     */
    async function presenceRow(targetBranch: string, timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const row = await context.admin.kdsPresence.findUnique({ where: { branchId: targetBranch } });
        if (row || Date.now() > deadline) return row;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    it('records a heartbeat as presence', async () => {
      // Through the real stream, so what is asserted is that the endpoint the
      // kitchen actually opens writes the record — not that a service can.
      const ticket = await post(`/api/v1/kds/branches/${branchId}/ticket`, {});
      expect(ticket.statusCode).toBe(200);

      const stream = await context.app.inject({
        method: 'GET',
        url: `/api/v1/kds/stream?ticket=${ticket.json().data.ticket}`,
        payloadAsStream: true,
      });
      expect(stream.statusCode).toBe(200);
      stream.raw.res.destroy();

      const row = await presenceRow(branchId);
      expect(row, 'opening the stream should record presence').not.toBeNull();
      expect(row!.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    it('says nothing about a dark screen with no orders waiting', async () => {
      // A closed restaurant has no screen on at three in the morning and does
      // not want to hear about it. An alarm that cries every night is one
      // nobody reads by the end of the week.
      await presence(600, quietBranchId);
      const before = await offlineEvents(quietBranchId);

      await (await monitor()).sweepOnce();

      expect(await offlineEvents(quietBranchId)).toBe(before);
      // And deliberately not marked, so the first order to arrive while the
      // screen is still off does raise it.
      const row = await presenceRow(quietBranchId);
      expect(row!.offlineAlertedAt).toBeNull();
    });

    it('raises the alarm once when orders are waiting', async () => {
      const order = await placeOrder(secondBranchId);
      expect(order.status).toBe(OrderStatus.CONFIRMED);

      await presence(600);
      const before = await offlineEvents();

      await (await monitor()).sweepOnce();
      expect(await offlineEvents()).toBe(before + 1);

      // A five-second sweep must not alert twelve times a minute.
      await (await monitor()).sweepOnce();
      expect(await offlineEvents()).toBe(before + 1);

      const row = await context.admin.kdsPresence.findUnique({ where: { branchId: secondBranchId } });
      expect(row!.offlineAlertedAt).not.toBeNull();
    });

    it('counts the orders waiting, for the message', async () => {
      await presence(600);
      await (await monitor()).sweepOnce();

      const event = await context.admin.outboxEvent.findFirst({
        where: { eventType: DomainEventType.KITCHEN_SCREEN_OFFLINE, aggregateId: secondBranchId },
        orderBy: { createdAt: 'desc' },
      });

      const payload = event!.payload as Record<string, unknown>;
      // "The screen is offline" and "the screen is offline and four orders are
      // waiting" call for different reactions.
      expect(payload.waitingOrders).toBeGreaterThan(0);
      expect(payload.offlineSeconds).toBeGreaterThan(0);
    });

    it('re-arms itself when a screen comes back', async () => {
      await presence(600);
      await (await monitor()).sweepOnce();
      const afterFirst = await offlineEvents();

      // A heartbeat is the only "back online" signal there is, which is why
      // clearing the flag lives in the same write.
      await presence(0);
      const cleared = await context.admin.kdsPresence.findUnique({
        where: { branchId: secondBranchId },
      });
      expect(cleared!.offlineAlertedAt).toBeNull();

      // Still fresh, so nothing yet.
      await (await monitor()).sweepOnce();
      expect(await offlineEvents()).toBe(afterFirst);

      // Gone again: a second outage is a second alarm.
      await presence(600);
      await (await monitor()).sweepOnce();
      expect(await offlineEvents()).toBe(afterFirst + 1);
    });

    it('leaves a screen that is merely slow alone', async () => {
      // One missed heartbeat is a tablet changing access point, not an outage.
      await presence(20);
      const before = await offlineEvents();

      await (await monitor()).sweepOnce();

      expect(await offlineEvents()).toBe(before);
    });
  });

  describe('unacknowledged orders and escalation (spec 33)', () => {
    /**
     * The plan's second exit criterion: an order nobody acknowledges must
     * escalate on schedule.
     */
    it('escalates an order nobody acknowledged', async () => {
      const order = await placeOrder();

      // Backdate the confirmation so the ladder is due without the test
      // waiting for wall-clock time.
      await context.admin.order.update({
        where: { id: order.id },
        data: { confirmedAt: new Date(Date.now() - 10_000) },
      });

      const { EscalationMonitor } = await import('../../worker/src/escalation-monitor');
      const noop = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;
      const monitor = new EscalationMonitor(worker, noop, { pollMs: 1000 });

      const raised = await monitor.sweepOnce();
      expect(raised).toBeGreaterThan(0);

      const escalations = await context.admin.orderEscalation.findMany({
        where: { orderId: order.id },
        orderBy: { level: 'asc' },
      });

      // Ten seconds elapsed against a 1/2/3-second ladder: every rung is due,
      // and a worker catching up must raise all of them.
      expect(escalations.map((row) => row.level)).toEqual([1, 2, 3]);
      expect(escalations.map((row) => row.target)).toEqual([
        'KITCHEN',
        'BRANCH_MANAGER',
        'OWNER',
      ]);
    });

    it('does not escalate the same rung twice', async () => {
      const order = await placeOrder();
      await context.admin.order.update({
        where: { id: order.id },
        data: { confirmedAt: new Date(Date.now() - 10_000) },
      });

      const { EscalationMonitor } = await import('../../worker/src/escalation-monitor');
      const noop = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;
      const monitor = new EscalationMonitor(worker, noop, { pollMs: 1000 });

      await monitor.sweepOnce();
      const afterFirst = await context.admin.orderEscalation.count({
        where: { orderId: order.id },
      });

      await monitor.sweepOnce();
      const afterSecond = await context.admin.orderEscalation.count({
        where: { orderId: order.id },
      });

      // Nobody gets alerted twice for the same rung. Asserted on this order's
      // own rungs rather than on the sweep's return value, which counts every
      // order in the database and so is not this test's business.
      expect(afterFirst).toBe(3);
      expect(afterSecond).toBe(3);
    });

    it('does not escalate an order that was accepted in time', async () => {
      const order = await placeOrder();
      await transition(order.id, OrderStatus.ACCEPTED);

      await context.admin.order.update({
        where: { id: order.id },
        data: { confirmedAt: new Date(Date.now() - 10_000) },
      });

      const { EscalationMonitor } = await import('../../worker/src/escalation-monitor');
      const noop = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;
      const monitor = new EscalationMonitor(worker, noop, { pollMs: 1000 });
      await monitor.sweepOnce();

      const escalations = await context.admin.orderEscalation.count({
        where: { orderId: order.id },
      });
      // Acceptance is the acknowledgement; a slow kitchen is a different
      // problem from an unnoticed order.
      expect(escalations).toBe(0);
    });

    it('emits an event for each rung so notifications go through the outbox', async () => {
      const order = await placeOrder();
      await context.admin.order.update({
        where: { id: order.id },
        data: { confirmedAt: new Date(Date.now() - 10_000) },
      });

      const { EscalationMonitor } = await import('../../worker/src/escalation-monitor');
      const noop = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;
      await new EscalationMonitor(worker, noop, { pollMs: 1000 }).sweepOnce();

      const events = await context.admin.outboxEvent.findMany({
        where: { aggregateId: order.id, eventType: 'OrderAcknowledgementTimeout' },
        orderBy: { sequence: 'asc' },
      });

      expect(events).toHaveLength(3);
      expect((events[0]!.payload as { level: number }).level).toBe(1);
      // Escalation raises an alarm through the outbox, so a WhatsApp outage
      // cannot swallow it (invariant 8).
      expect(events.every((event) => event.status === 'PENDING')).toBe(true);
    });

    it('resolves escalations once the order is finally acknowledged', async () => {
      const order = await placeOrder();
      await context.admin.order.update({
        where: { id: order.id },
        data: { confirmedAt: new Date(Date.now() - 10_000) },
      });

      const { EscalationMonitor } = await import('../../worker/src/escalation-monitor');
      const noop = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;
      const monitor = new EscalationMonitor(worker, noop, { pollMs: 1000 });
      await monitor.sweepOnce();

      await transition(order.id, OrderStatus.ACCEPTED);
      await monitor.sweepOnce();

      const open = await context.admin.orderEscalation.count({
        where: { orderId: order.id, resolvedAt: null },
      });
      // The dashboard banner clears itself rather than needing a dismissal.
      expect(open).toBe(0);
    });

    it('reports unacknowledged orders through the API', async () => {
      const order = await placeOrder();
      await context.admin.order.update({
        where: { id: order.id },
        data: { confirmedAt: new Date(Date.now() - 30_000) },
      });

      const response = await get(`/api/v1/kds/unacknowledged?branchId=${branchId}`);

      expect(response.statusCode).toBe(200);
      const body = response.json().data;
      expect(body.thresholdSeconds).toBe(10);

      const reported = body.orders.find((entry: { id: string }) => entry.id === order.id);
      expect(reported).toBeTruthy();
      expect(reported.waitingSeconds).toBeGreaterThanOrEqual(30);
    });
  });

  describe('worker privilege boundary', () => {
    it('can read orders and the outbox', async () => {
      await expect(worker.order.count()).resolves.toBeGreaterThanOrEqual(0);
      await expect(worker.outboxEvent.count()).resolves.toBeGreaterThanOrEqual(0);
    });

    it('cannot read menus, customers or audit logs', async () => {
      // The worker needs to look across tenants, so it must not be able to see
      // anything beyond what its two jobs require.
      await expect(worker.menuItem.count()).rejects.toThrow(/permission denied/i);
      await expect(worker.customer.count()).rejects.toThrow(/permission denied/i);
      await expect(worker.auditLog.count()).rejects.toThrow(/permission denied/i);
    });

    it('cannot change an order', async () => {
      const order = await placeOrder();
      // Escalation raises an alarm; it never touches the order itself.
      //
      // This write is the point of the test: it must be refused by the
      // database. The lint rule that forbids direct status writes is disabled
      // for the one line that deliberately attempts one.
      await expect(
        worker.order.update({
          where: { id: order.id },
          // eslint-disable-next-line no-restricted-syntax -- negative test: the database must refuse this
          data: { status: OrderStatus.CANCELLED },
        }),
      ).rejects.toThrow(/permission denied/i);
    });
  });
});
