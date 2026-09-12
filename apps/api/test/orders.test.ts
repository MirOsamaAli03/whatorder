import { OrderStatus, PaymentMethod, PaymentStatus, SystemRole } from '@restaurant-os/types';
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
 * Orders (ENGINEERING_SPEC.md 12–17, 28; invariants 3, 5, 6, 7).
 *
 * The cases that matter most here are the ones spec v1 gets wrong or leaves
 * open: a cash order that never enters PENDING_PAYMENT, totals that ignore
 * anything a client sends, a snapshot that survives a menu price change, and a
 * retried checkout that produces one order rather than two.
 */
describe('orders', () => {
  let context: TestContext;
  let tenant: TestTenant;
  let other: TestTenant;
  const created: TestTenant[] = [];

  let ownerToken: string;
  let branchId: string;
  let secondBranchId: string;
  let burgerId: string;
  let sauceModifierId: string;
  let chilliOptionId: string;

  beforeAll(async () => {
    context = await createTestContext();
    await ensureReferenceData(context.admin);

    tenant = await createTenant(context.admin, {
      slug: 'orders-chain',
      branchSlugs: ['dha', 'clifton'],
      users: [
        { key: 'owner', role: SystemRole.OWNER },
        { key: 'cashier', role: SystemRole.CASHIER, branches: [0] },
        { key: 'kitchen', role: SystemRole.KITCHEN_STAFF, branches: [0] },
      ],
    });

    other = await createTenant(context.admin, {
      slug: 'orders-rival',
      branchSlugs: ['main'],
      users: [{ key: 'owner', role: SystemRole.OWNER }],
    });

    created.push(tenant, other);
    ownerToken = await login(context.app, tenant.users.owner!.email);
    branchId = tenant.branchIds[0]!;
    secondBranchId = tenant.branchIds[1]!;

    // 15% tax, Rs 150 delivery, Rs 500 minimum — the seeded demo shape.
    await context.admin.organization.update({
      where: { id: tenant.organizationId },
      data: {
        settings: {
          taxPercent: 15,
          deliveryFee: '150.00',
          minimumOrder: '500.00',
        },
      },
    });

    const modifier = await post('/api/v1/menu/modifiers', {
      name: 'Sauce',
      selectionType: 'SINGLE',
      options: [
        { name: 'Garlic', priceDelta: '0.00' },
        { name: 'Chilli', priceDelta: '50.00' },
      ],
    });
    sauceModifierId = modifier.json().data.id;
    chilliOptionId = modifier
      .json()
      .data.options.find((option: { name: string }) => option.name === 'Chilli').id;

    const item = await post('/api/v1/menu/items', {
      name: 'Chicken Burger',
      basePrice: '700.00',
      costPrice: '280.00',
    });
    burgerId = item.json().data.id;

    await put(`/api/v1/menu/items/${burgerId}/modifiers`, { modifierIds: [sauceModifierId] });
  });

  afterAll(async () => {
    await cleanupTenants(context.admin, created);
    await context.close();
  });

  async function post(url: string, payload: Record<string, unknown>, token = ownerToken) {
    return context.app.inject({ method: 'POST', url, headers: authHeaders(token), payload });
  }
  async function put(url: string, payload: Record<string, unknown>, token = ownerToken) {
    return context.app.inject({ method: 'PUT', url, headers: authHeaders(token), payload });
  }
  async function get(url: string, token = ownerToken) {
    return context.app.inject({ method: 'GET', url, headers: authHeaders(token) });
  }

  /** Builds a cart with one burger, returning the cart id. */
  async function seedCart(
    options: { orderType?: string; quantity?: number; optionIds?: string[]; branch?: string } = {},
  ) {
    const cart = await post('/api/v1/carts', {
      branchId: options.branch ?? branchId,
      source: 'POS',
      orderType: options.orderType ?? 'PICKUP',
    });
    const cartId = cart.json().data.id as string;

    await post(`/api/v1/carts/${cartId}/items`, {
      menuItemId: burgerId,
      quantity: options.quantity ?? 1,
      ...(options.optionIds ? { optionIds: options.optionIds } : {}),
    });

    return cartId;
  }

  async function checkout(
    cartId: string,
    overrides: Record<string, unknown> = {},
    token = ownerToken,
  ) {
    return context.app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { ...authHeaders(token), 'idempotency-key': randomUUID() },
      payload: {
        cartId,
        customerPhone: '03001234567',
        customerName: 'Test Customer',
        paymentMethod: PaymentMethod.CASH,
        ...overrides,
      },
    });
  }

  describe('cart', () => {
    it('computes totals server-side', async () => {
      const cartId = await seedCart({ quantity: 2 });
      const cart = await get(`/api/v1/carts/${cartId}`);

      const totals = cart.json().data.totals;
      // 700 x 2 = 1400, +15% tax, pickup so no delivery fee.
      expect(totals.subtotal).toBe('1400.00');
      expect(totals.taxAmount).toBe('210.00');
      expect(totals.deliveryFee).toBe('0.00');
      expect(totals.total).toBe('1610.00');
      expect(cart.json().data.canCheckout).toBe(true);
    });

    it('adds modifier deltas to the line', async () => {
      const cartId = await seedCart({ optionIds: [chilliOptionId] });
      const cart = await get(`/api/v1/carts/${cartId}`);

      const line = cart.json().data.items[0];
      expect(line.unitPrice).toBe('700.00');
      expect(line.modifiersTotal).toBe('50.00');
      expect(line.lineTotal).toBe('750.00');
      expect(line.modifiers[0].optionName).toBe('Chilli');
    });

    it('refuses an option that belongs to another item', async () => {
      const otherModifier = await post('/api/v1/menu/modifiers', {
        name: `Unrelated ${randomUUID().slice(0, 6)}`,
        options: [{ name: 'Nope', priceDelta: '10.00' }],
      });
      const strayOptionId = otherModifier.json().data.options[0].id;

      const cart = await post('/api/v1/carts', {
        branchId,
        source: 'POS',
        orderType: 'PICKUP',
      });

      const response = await post(`/api/v1/carts/${cart.json().data.id}/items`, {
        menuItemId: burgerId,
        optionIds: [strayOptionId],
      });

      // Otherwise a caller could price a burger with a pizza's toppings.
      expect(response.statusCode).toBe(422);
    });

    it('reports a blocker below the delivery minimum instead of failing', async () => {
      const cart = await post('/api/v1/carts', {
        branchId,
        source: 'WEBSITE',
        orderType: 'DELIVERY',
      });
      const cartId = cart.json().data.id as string;

      const preview = await get(`/api/v1/carts/${cartId}`);
      expect(preview.json().data.canCheckout).toBe(false);
      expect(preview.json().data.blockers).toContain('The cart is empty');
    });

    it('removes a line when quantity drops to zero', async () => {
      const cartId = await seedCart();
      const cart = await get(`/api/v1/carts/${cartId}`);
      const itemId = cart.json().data.items[0].id;

      const updated = await context.app.inject({
        method: 'PATCH',
        url: `/api/v1/carts/${cartId}/items/${itemId}`,
        headers: authHeaders(ownerToken),
        payload: { quantity: 0 },
      });

      expect(updated.json().data.items).toHaveLength(0);
    });

    it('refuses to add a sold-out item', async () => {
      const soldOut = await post('/api/v1/menu/items', {
        name: `Sold out ${randomUUID().slice(0, 6)}`,
        basePrice: '100.00',
      });
      const soldOutId = soldOut.json().data.id;
      await post(`/api/v1/menu/items/${soldOutId}/availability`, {
        availability: 'OUT_OF_STOCK',
      });

      const cart = await post('/api/v1/carts', {
        branchId,
        source: 'POS',
        orderType: 'PICKUP',
      });
      const response = await post(`/api/v1/carts/${cart.json().data.id}/items`, {
        menuItemId: soldOutId,
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('MENU_ITEM_UNAVAILABLE');
    });
  });

  describe('checkout', () => {
    it('sends a cash order straight to CONFIRMED', async () => {
      const cartId = await seedCart();
      const response = await checkout(cartId);

      expect(response.statusCode).toBe(201);
      const order = response.json().data;

      // The path spec v1 has no route for: a cash order never owes an online
      // payment, so it must not sit in PENDING_PAYMENT.
      expect(order.status).toBe(OrderStatus.CONFIRMED);
      expect(order.paymentStatus).toBe(PaymentStatus.UNPAID);
      expect(order.timestamps.confirmedAt).toBeTruthy();
    });

    it('holds an online order at PENDING_PAYMENT', async () => {
      const cartId = await seedCart();
      const response = await checkout(cartId, { paymentMethod: PaymentMethod.ONLINE });

      expect(response.json().data.status).toBe(OrderStatus.PENDING_PAYMENT);
      expect(response.json().data.paymentStatus).toBe(PaymentStatus.PENDING);
      expect(response.json().data.timestamps.confirmedAt).toBeNull();
    });

    it('ignores any total the client sends', async () => {
      const cartId = await seedCart({ quantity: 2 });
      const response = await checkout(cartId, {
        total: '1.00',
        subtotal: '1.00',
        taxAmount: '0.00',
      });

      // Invariant 3: the server recomputes, and Zod strips the keys anyway.
      expect(response.json().data.totals.total).toBe('1610.00');
      expect(response.json().data.totals.subtotal).toBe('1400.00');
    });

    it('charges the delivery fee on a delivery order', async () => {
      const cartId = await seedCart({ orderType: 'DELIVERY', quantity: 1 });
      const response = await checkout(cartId, {
        deliveryAddress: '12 Test Street, Karachi',
      });

      const totals = response.json().data.totals;
      // 700 + 105 tax + 150 delivery
      expect(totals.subtotal).toBe('700.00');
      expect(totals.deliveryFee).toBe('150.00');
      expect(totals.total).toBe('955.00');
    });

    it('requires an address for a delivery order', async () => {
      const cartId = await seedCart({ orderType: 'DELIVERY' });
      const response = await checkout(cartId, {});

      expect(response.statusCode).toBe(422);
    });

    it('normalises the phone number and reuses one customer record', async () => {
      const first = await checkout(await seedCart(), { customerPhone: '0300 111 2233' });
      const second = await checkout(await seedCart(), { customerPhone: '+92 300 1112233' });

      expect(first.json().data.customerPhone).toBe('+923001112233');
      expect(second.json().data.customerPhone).toBe('+923001112233');
      // The same person written two ways must not become two customers.
      expect(second.json().data.customerId).toBe(first.json().data.customerId);
    });

    it('numbers orders per branch', async () => {
      const first = await checkout(await seedCart({ branch: secondBranchId }));
      const second = await checkout(await seedCart({ branch: secondBranchId }));

      expect(first.json().data.orderNumber).toMatch(/^CLIFTO-\d{4}$/);
      const firstNumber = Number(first.json().data.orderNumber.split('-')[1]);
      const secondNumber = Number(second.json().data.orderNumber.split('-')[1]);
      expect(secondNumber).toBe(firstNumber + 1);
    });

    it('refuses to check the same cart out twice', async () => {
      const cartId = await seedCart();
      await checkout(cartId);
      const second = await checkout(cartId);

      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe('CONFLICT');
    });

    it('closes the cart on checkout', async () => {
      const cartId = await seedCart();
      await checkout(cartId);

      const cart = await get(`/api/v1/carts/${cartId}`);
      expect(cart.json().data.status).toBe('CHECKED_OUT');
    });
  });

  describe('snapshotting (spec 13, invariant 5)', () => {
    it('keeps historical prices when the menu changes', async () => {
      const cartId = await seedCart({ optionIds: [chilliOptionId] });
      const placed = await checkout(cartId);
      const orderId = placed.json().data.id;

      expect(placed.json().data.items[0].unitPrice).toBe('700.00');

      // The restaurant raises the price and renames the dish.
      await context.app.inject({
        method: 'PATCH',
        url: `/api/v1/menu/items/${burgerId}`,
        headers: authHeaders(ownerToken),
        payload: { basePrice: '900.00', name: 'Chicken Burger Deluxe' },
      });

      const after = await get(`/api/v1/orders/${orderId}`);
      const line = after.json().data.items[0];

      // The old receipt is unchanged, name and price alike.
      expect(line.unitPrice).toBe('700.00');
      expect(line.name).toBe('Chicken Burger');
      expect(after.json().data.totals.total).toBe('862.50');

      // Restore for the remaining tests.
      await context.app.inject({
        method: 'PATCH',
        url: `/api/v1/menu/items/${burgerId}`,
        headers: authHeaders(ownerToken),
        payload: { basePrice: '700.00', name: 'Chicken Burger' },
      });
    });

    it('survives the item being archived entirely', async () => {
      const temporary = await post('/api/v1/menu/items', {
        name: `Seasonal ${randomUUID().slice(0, 6)}`,
        basePrice: '300.00',
      });
      const temporaryId = temporary.json().data.id;

      const cart = await post('/api/v1/carts', {
        branchId,
        source: 'POS',
        orderType: 'PICKUP',
      });
      const cartId = cart.json().data.id;
      await post(`/api/v1/carts/${cartId}/items`, { menuItemId: temporaryId });

      const placed = await checkout(cartId);
      const orderId = placed.json().data.id;

      await context.app.inject({
        method: 'DELETE',
        url: `/api/v1/menu/items/${temporaryId}`,
        headers: authHeaders(ownerToken),
      });

      const after = await get(`/api/v1/orders/${orderId}`);
      expect(after.statusCode).toBe(200);
      expect(after.json().data.items[0].unitPrice).toBe('300.00');
    });

    it('snapshots modifier names and deltas', async () => {
      const cartId = await seedCart({ optionIds: [chilliOptionId] });
      const placed = await checkout(cartId);

      const modifier = placed.json().data.items[0].modifiers[0];
      expect(modifier.modifierName).toBe('Sauce');
      expect(modifier.optionName).toBe('Chilli');
      expect(modifier.priceDelta).toBe('50.00');
    });
  });

  describe('idempotency (spec 17, invariant 7)', () => {
    it('requires an Idempotency-Key', async () => {
      const cartId = await seedCart();
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/v1/orders',
        headers: authHeaders(ownerToken),
        payload: { cartId, customerPhone: '03001234567', paymentMethod: PaymentMethod.CASH },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('creates one order when the same request is retried', async () => {
      const cartId = await seedCart();
      const key = randomUUID();
      const payload = {
        cartId,
        customerPhone: '03009998877',
        paymentMethod: PaymentMethod.CASH,
      };

      const first = await context.app.inject({
        method: 'POST',
        url: '/api/v1/orders',
        headers: { ...authHeaders(ownerToken), 'idempotency-key': key },
        payload,
      });
      const second = await context.app.inject({
        method: 'POST',
        url: '/api/v1/orders',
        headers: { ...authHeaders(ownerToken), 'idempotency-key': key },
        payload,
      });

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      // The retry replays the first response rather than placing a second order.
      expect(second.json().data.id).toBe(first.json().data.id);

      const orders = await context.admin.order.findMany({
        where: { customerPhone: '+923009998877', tenantId: tenant.organizationId },
      });
      expect(orders).toHaveLength(1);
    });

    it('rejects the same key used for a different request', async () => {
      const key = randomUUID();

      await context.app.inject({
        method: 'POST',
        url: '/api/v1/orders',
        headers: { ...authHeaders(ownerToken), 'idempotency-key': key },
        payload: {
          cartId: await seedCart(),
          customerPhone: '03001234567',
          paymentMethod: PaymentMethod.CASH,
        },
      });

      const different = await context.app.inject({
        method: 'POST',
        url: '/api/v1/orders',
        headers: { ...authHeaders(ownerToken), 'idempotency-key': key },
        payload: {
          cartId: await seedCart(),
          customerPhone: '03007776655',
          paymentMethod: PaymentMethod.CASH,
        },
      });

      expect(different.statusCode).toBe(409);
      expect(different.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('releases the key when the request fails', async () => {
      const key = randomUUID();
      const payload = {
        cartId: randomUUID(), // no such cart
        customerPhone: '03001234567',
        paymentMethod: PaymentMethod.CASH,
      };

      const failed = await context.app.inject({
        method: 'POST',
        url: '/api/v1/orders',
        headers: { ...authHeaders(ownerToken), 'idempotency-key': key },
        payload,
      });
      expect(failed.statusCode).toBe(404);

      // A transient failure must not lock the key for 24 hours.
      const retry = await context.app.inject({
        method: 'POST',
        url: '/api/v1/orders',
        headers: { ...authHeaders(ownerToken), 'idempotency-key': key },
        payload,
      });
      expect(retry.statusCode).toBe(404);
    });
  });

  describe('state transitions (spec 16, invariant 6)', () => {
    async function placedOrder(orderType = 'PICKUP') {
      const cartId = await seedCart({ orderType });
      const response = await checkout(
        cartId,
        orderType === 'DELIVERY' ? { deliveryAddress: '1 Test Road' } : {},
      );
      return response.json().data.id as string;
    }

    async function transition(orderId: string, status: string, reason?: string, token = ownerToken) {
      return context.app.inject({
        method: 'POST',
        url: `/api/v1/orders/${orderId}/transition`,
        headers: authHeaders(token),
        payload: { status, ...(reason ? { reason } : {}) },
      });
    }

    it('walks a pickup order to completion', async () => {
      const orderId = await placedOrder('PICKUP');

      for (const status of ['ACCEPTED', 'PREPARING', 'READY', 'COMPLETED']) {
        const response = await transition(orderId, status);
        expect(response.statusCode, status).toBe(200);
        expect(response.json().data.status).toBe(status);
      }

      const final = await get(`/api/v1/orders/${orderId}`);
      expect(final.json().data.timestamps.completedAt).toBeTruthy();
      expect(final.json().data.allowedTransitions).toEqual([]);
    });

    it('rejects the spec\'s named illegal move', async () => {
      const orderId = await placedOrder('DELIVERY');
      for (const status of ['ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED']) {
        await transition(orderId, status);
      }

      const response = await transition(orderId, 'PREPARING');
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('ORDER_INVALID_STATE');
    });

    it('will not skip a step', async () => {
      const orderId = await placedOrder('PICKUP');
      const response = await transition(orderId, 'READY');

      expect(response.statusCode).toBe(409);
      expect(response.json().error.message).toBe('Order cannot be moved from CONFIRMED to READY');
    });

    it('will not send a pickup order out for delivery', async () => {
      const orderId = await placedOrder('PICKUP');
      for (const status of ['ACCEPTED', 'PREPARING', 'READY']) {
        await transition(orderId, status);
      }

      const response = await transition(orderId, 'OUT_FOR_DELIVERY');
      expect(response.statusCode).toBe(409);
    });

    it('marks a cash order paid when it is handed over', async () => {
      const orderId = await placedOrder('PICKUP');
      for (const status of ['ACCEPTED', 'PREPARING', 'READY']) {
        await transition(orderId, status);
      }

      const before = await get(`/api/v1/orders/${orderId}`);
      expect(before.json().data.paymentStatus).toBe(PaymentStatus.UNPAID);

      const completed = await transition(orderId, 'COMPLETED');
      // Cash is collected at handover, so that is what settles the order.
      expect(completed.json().data.paymentStatus).toBe(PaymentStatus.PAID);
    });

    it('requires a reason to cancel', async () => {
      const orderId = await placedOrder('PICKUP');

      const withoutReason = await transition(orderId, 'CANCELLED');
      expect(withoutReason.statusCode).toBe(422);

      const withReason = await transition(orderId, 'CANCELLED', 'Customer changed their mind');
      expect(withReason.statusCode).toBe(200);
      expect(withReason.json().data.cancellationReason).toBe('Customer changed their mind');
    });

    it('records every change in the history', async () => {
      const orderId = await placedOrder('PICKUP');
      await transition(orderId, 'ACCEPTED');
      await transition(orderId, 'PREPARING');

      const order = await get(`/api/v1/orders/${orderId}`);
      const history = order.json().data.history;

      expect(history.map((entry: { toStatus: string }) => entry.toStatus)).toEqual([
        'CONFIRMED',
        'ACCEPTED',
        'PREPARING',
      ]);
      expect(history[1].fromStatus).toBe('CONFIRMED');
      expect(history[1].actorId).toBe(tenant.users.owner!.userId);
    });

    it('writes an outbox event for every change', async () => {
      const orderId = await placedOrder('PICKUP');
      await transition(orderId, 'ACCEPTED');

      const events = await context.admin.outboxEvent.findMany({
        where: { aggregateId: orderId },
        orderBy: { createdAt: 'asc' },
      });

      // ORDER_CREATED, then the CONFIRMED and ACCEPTED status changes.
      expect(events.map((event) => event.eventType)).toEqual([
        'OrderCreated',
        'OrderStatusChanged',
        'OrderStatusChanged',
      ]);
      expect(events.every((event) => event.status === 'PENDING')).toBe(true);
    });

    it('stamps the stage timestamps used by kitchen metrics', async () => {
      const orderId = await placedOrder('DELIVERY');
      for (const status of ['ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY']) {
        await transition(orderId, status);
      }

      const order = await get(`/api/v1/orders/${orderId}`);
      const timestamps = order.json().data.timestamps;

      for (const field of ['confirmedAt', 'acceptedAt', 'preparingAt', 'readyAt', 'dispatchedAt']) {
        expect(timestamps[field], field).toBeTruthy();
      }
    });

    it('lets a failed delivery be re-dispatched', async () => {
      const orderId = await placedOrder('DELIVERY');
      for (const status of ['ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY']) {
        await transition(orderId, status);
      }

      expect((await transition(orderId, 'DELIVERY_FAILED')).statusCode).toBe(200);
      expect((await transition(orderId, 'OUT_FOR_DELIVERY')).statusCode).toBe(200);
      expect((await transition(orderId, 'DELIVERED')).statusCode).toBe(200);
    });
  });

  describe('branch selection and delivery zones (spec 29)', () => {
    beforeAll(async () => {
      // The DHA branch delivers within 4km cheaply and 9km for more; Clifton
      // covers a different part of the city.
      await context.admin.branch.update({
        where: { id: branchId },
        data: { latitude: 24.8008, longitude: 67.0114 },
      });
      await context.admin.branch.update({
        where: { id: secondBranchId },
        data: { latitude: 24.8138, longitude: 67.0299 },
      });

      await context.admin.deliveryZone.createMany({
        data: [
          {
            tenantId: tenant.organizationId,
            branchId,
            name: 'Inner',
            centerLatitude: 24.8008,
            centerLongitude: 67.0114,
            radiusMetres: 4000,
            deliveryFee: '120.00',
            sortOrder: 0,
          },
          {
            tenantId: tenant.organizationId,
            branchId,
            name: 'Outer',
            centerLatitude: 24.8008,
            centerLongitude: 67.0114,
            radiusMetres: 9000,
            deliveryFee: '250.00',
            minimumOrder: '900.00',
            sortOrder: 1,
          },
        ],
      });
    });

    it('returns branches that cover the address, nearest first', async () => {
      const response = await get(
        `/api/v1/branches/eligible?orderType=DELIVERY&latitude=24.8020&longitude=67.0120`,
      );

      expect(response.statusCode).toBe(200);
      const eligible = response.json().data.branches;
      expect(eligible.length).toBeGreaterThan(0);
      expect(eligible[0].branchId).toBe(branchId);
      // The cheap inner zone wins over the wider one it sits inside.
      expect(eligible[0].deliveryZone.name).toBe('Inner');
      expect(eligible[0].deliveryZone.deliveryFee).toBe('120.00');
    });

    it('picks the outer zone for an address beyond the inner one', async () => {
      // ~6km from the branch centre: outside Inner, inside Outer.
      const response = await get(
        `/api/v1/branches/eligible?orderType=DELIVERY&latitude=24.8500&longitude=67.0400`,
      );

      const match = response
        .json()
        .data.branches.find((entry: { branchId: string }) => entry.branchId === branchId);
      expect(match?.deliveryZone?.name).toBe('Outer');
      expect(match?.deliveryZone?.minimumOrder).toBe('900.00');
    });

    it('returns nothing for an address nobody covers', async () => {
      // Lahore, ~1000km away.
      const response = await get(
        `/api/v1/branches/eligible?orderType=DELIVERY&latitude=31.5204&longitude=74.3587`,
      );

      expect(response.json().data.branches).toEqual([]);
    });

    it('requires coordinates for delivery', async () => {
      const response = await get('/api/v1/branches/eligible?orderType=DELIVERY');
      expect(response.statusCode).toBe(422);
    });

    it('lists every open branch for pickup without coordinates', async () => {
      const response = await get('/api/v1/branches/eligible?orderType=PICKUP');

      expect(response.statusCode).toBe(200);
      // Pickup needs no zone: the customer chooses where to collect.
      expect(response.json().data.branches.length).toBeGreaterThanOrEqual(2);
    });

    it('charges the zone fee rather than the tenant default', async () => {
      const cart = await post('/api/v1/carts', {
        branchId,
        source: 'WEBSITE',
        orderType: 'DELIVERY',
      });
      const cartId = cart.json().data.id;
      await post(`/api/v1/carts/${cartId}/items`, { menuItemId: burgerId });

      const zoneCustomer = await post('/api/v1/customers', {
        phone: '03005554433',
        name: 'Zone Test',
      });
      const zoneCustomerId = zoneCustomer.json().data.id;

      await post(`/api/v1/customers/${zoneCustomerId}/addresses`, {
        address: '1 Inner Zone Road',
        latitude: 24.802,
        longitude: 67.012,
        isDefault: true,
      });

      await context.app.inject({
        method: 'PATCH',
        url: `/api/v1/carts/${cartId}`,
        headers: authHeaders(ownerToken),
        payload: { customerId: zoneCustomerId },
      });

      const priced = await get(`/api/v1/carts/${cartId}`);
      // The tenant default is 150; the inner zone charges 120.
      expect(priced.json().data.totals.deliveryFee).toBe('120.00');
      expect(priced.json().data.deliveryZone.name).toBe('Inner');
    });
  });

  describe('permissions and isolation', () => {
    it('stops kitchen staff placing an order', async () => {
      const kitchenToken = await login(context.app, tenant.users.kitchen!.email);
      const response = await post(
        '/api/v1/carts',
        { branchId, source: 'POS', orderType: 'PICKUP' },
        kitchenToken,
      );

      expect(response.statusCode).toBe(403);
    });

    it('lets kitchen staff move an order through the kitchen', async () => {
      const cartId = await seedCart();
      const placed = await checkout(cartId);
      const orderId = placed.json().data.id;

      const kitchenToken = await login(context.app, tenant.users.kitchen!.email);
      const response = await context.app.inject({
        method: 'POST',
        url: `/api/v1/orders/${orderId}/transition`,
        headers: authHeaders(kitchenToken),
        payload: { status: 'ACCEPTED' },
      });

      expect(response.statusCode).toBe(200);
    });

    it('confines a branch-scoped cashier to their own branch', async () => {
      const cashierToken = await login(context.app, tenant.users.cashier!.email);

      const ownBranch = await post(
        '/api/v1/carts',
        { branchId, source: 'POS', orderType: 'PICKUP' },
        cashierToken,
      );
      expect(ownBranch.statusCode).toBe(201);

      const siblingBranch = await post(
        '/api/v1/carts',
        { branchId: secondBranchId, source: 'POS', orderType: 'PICKUP' },
        cashierToken,
      );
      expect(siblingBranch.statusCode).toBe(403);
    });

    it('hides another tenant\'s order behind a 404', async () => {
      const placed = await checkout(await seedCart());
      const orderId = placed.json().data.id;

      const rivalToken = await login(context.app, other.users.owner!.email);
      const read = await get(`/api/v1/orders/${orderId}`, rivalToken);
      expect(read.statusCode).toBe(404);

      const write = await context.app.inject({
        method: 'POST',
        url: `/api/v1/orders/${orderId}/transition`,
        headers: authHeaders(rivalToken),
        payload: { status: 'ACCEPTED' },
      });
      expect(write.statusCode).toBe(404);
    });

    it('does not leak another tenant\'s orders into a list', async () => {
      await checkout(await seedCart());
      const rivalToken = await login(context.app, other.users.owner!.email);

      const list = await get('/api/v1/orders', rivalToken);
      expect(list.json().data.orders).toEqual([]);
      expect(list.json().data.total).toBe(0);
    });
  });
});
