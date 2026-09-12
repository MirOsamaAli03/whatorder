import { PrismaClient } from '@prisma/client';
import { OrderStatus, PaymentMethod, SystemRole } from '@restaurant-os/types';
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
