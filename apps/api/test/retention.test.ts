import { PrismaClient } from '@prisma/client';
import {
  CartStatus,
  NotificationChannel,
  NotificationStatus,
  OrderSource,
  OrderType,
  RecipientType,
  SystemRole,
} from '@restaurant-os/types';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_RETENTION, RetentionSweeper } from '../../worker/src/retention-sweeper';
import {
  cleanupTenants,
  createTenant,
  createTestContext,
  ensureReferenceData,
  type TestContext,
  type TestTenant,
} from './helpers/test-context';

/**
 * Retention: deleting what has served its purpose (backlog B-13, B-18).
 *
 * Four tables grew without bound. None of it was a correctness problem, which
 * is exactly why it needs a test: a prune that quietly deletes the wrong row is
 * far worse than no prune at all, and the ways it can be wrong are specific.
 * A cart somebody is still filling. A notification still queued to send. An
 * outbox event the notification dispatcher has not read yet — which would mean
 * a customer never being told their order was confirmed.
 *
 * Driven through the real `restaurant_worker` role, because half the point of
 * doing this in a SECURITY DEFINER function is that the worker gains the
 * ability to delete these rows without gaining the ability to read them. A test
 * on an owner connection would prove neither.
 */
describe('retention', () => {
  let context: TestContext;
  let workerPrisma: PrismaClient;
  let sweeper: RetentionSweeper;

  let tenant: TestTenant;
  const created: TestTenant[] = [];
  let branchId: string;

  /** Generous enough that no parallel test's live rows are in range. */
  const policy = {
    cartGraceHours: 1,
    idempotencyGraceHours: 1,
    notificationHours: 24,
    outboxHours: 24,
  };

  const longAgo = new Date(Date.now() - 10 * 24 * 3_600_000);
  const recently = new Date(Date.now() - 60_000);

  beforeAll(async () => {
    context = await createTestContext();
    await ensureReferenceData(context.admin);

    workerPrisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL_WORKER } },
    });

    sweeper = new RetentionSweeper(workerPrisma, pino({ level: 'silent' }), { pollMs: 3_600_000 });

    tenant = await createTenant(context.admin, {
      slug: 'retention',
      branchSlugs: ['main'],
      users: [{ key: 'owner', role: SystemRole.OWNER }],
    });
    created.push(tenant);
    branchId = tenant.branchIds[0]!;
  });

  afterAll(async () => {
    await workerPrisma.$disconnect();
    await cleanupTenants(context.admin, created);
    await context.close();
  });

  async function makeCart(status: CartStatus, expiresAt: Date | null): Promise<string> {
    const cart = await context.admin.cart.create({
      data: {
        tenantId: tenant.organizationId,
        branchId,
        source: OrderSource.WHATSAPP,
        orderType: OrderType.PICKUP,
        status,
        expiresAt,
      },
      select: { id: true },
    });
    return cart.id;
  }

  async function makeNotification(status: NotificationStatus, createdAt: Date): Promise<string> {
    const row = await context.admin.notification.create({
      data: {
        tenantId: tenant.organizationId,
        branchId,
        eventId: randomUUID(),
        eventType: 'order.confirmed',
        recipientType: RecipientType.CUSTOMER,
        recipientId: randomUUID(),
        channel: NotificationChannel.WHATSAPP,
        templateKey: 'order_confirmed',
        status,
        createdAt,
      },
      select: { id: true },
    });
    return row.id;
  }

  async function makeOutboxEvent(
    processedAt: Date | null,
  ): Promise<{ id: string; sequence: bigint }> {
    return context.admin.outboxEvent.create({
      data: {
        tenantId: tenant.organizationId,
        eventType: 'order.confirmed',
        aggregateType: 'ORDER',
        aggregateId: randomUUID(),
        payload: {},
        status: processedAt ? 'PROCESSED' : 'PENDING',
        processedAt,
      },
      select: { id: true, sequence: true },
    });
  }

  it('deletes an abandoned cart, and the lines on it', async () => {
    const stale = await makeCart(CartStatus.ACTIVE, longAgo);

    await context.admin.cartItem.create({
      data: {
        tenantId: tenant.organizationId,
        cartId: stale,
        menuItemId: randomUUID(),
        quantity: 2,
      },
    });

    await sweeper.sweepOnce(policy);

    expect(await context.admin.cart.findUnique({ where: { id: stale } })).toBeNull();
    // By cascade, so a prune cannot leave orphaned lines behind.
    expect(await context.admin.cartItem.count({ where: { cartId: stale } })).toBe(0);
  });

  it('leaves a cart somebody is still filling', async () => {
    // Three ways a cart must survive: no expiry set at all, an expiry still in
    // the future, and an expiry that passed moments ago — the last because a
    // cart deleted from under a customer mid-tap is the one failure here that
    // a customer would actually notice.
    const noExpiry = await makeCart(CartStatus.ACTIVE, null);
    const future = await makeCart(CartStatus.ACTIVE, new Date(Date.now() + 3_600_000));
    const justExpired = await makeCart(CartStatus.ACTIVE, recently);

    await sweeper.sweepOnce(policy);

    for (const id of [noExpiry, future, justExpired]) {
      expect(await context.admin.cart.findUnique({ where: { id } })).not.toBeNull();
    }
  });

  it('leaves the cart an order was placed from', async () => {
    // CHECKED_OUT is the one a customer actually ordered from, however old.
    const ordered = await makeCart(CartStatus.CHECKED_OUT, longAgo);

    await sweeper.sweepOnce(policy);

    expect(await context.admin.cart.findUnique({ where: { id: ordered } })).not.toBeNull();
  });

  it('deletes an expired idempotency key but not a live one', async () => {
    const expired = await context.admin.idempotencyKey.create({
      data: {
        tenantId: tenant.organizationId,
        key: `retention-expired-${randomUUID()}`,
        endpoint: 'POST /api/v1/orders',
        requestHash: 'a'.repeat(64),
        expiresAt: longAgo,
      },
      select: { id: true },
    });

    const live = await context.admin.idempotencyKey.create({
      data: {
        tenantId: tenant.organizationId,
        key: `retention-live-${randomUUID()}`,
        endpoint: 'POST /api/v1/orders',
        requestHash: 'b'.repeat(64),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
      select: { id: true },
    });

    await sweeper.sweepOnce(policy);

    expect(await context.admin.idempotencyKey.findUnique({ where: { id: expired.id } })).toBeNull();
    expect(
      await context.admin.idempotencyKey.findUnique({ where: { id: live.id } }),
    ).not.toBeNull();
  });

  it('deletes a finished notification but never one still queued', async () => {
    const sent = await makeNotification(NotificationStatus.SENT, longAgo);
    const suppressed = await makeNotification(NotificationStatus.SUPPRESSED, longAgo);

    // Old and still PENDING means something is wrong, and deleting the evidence
    // would also delete the message. Both stay, however old they are.
    const pending = await makeNotification(NotificationStatus.PENDING, longAgo);
    const processing = await makeNotification(NotificationStatus.PROCESSING, longAgo);

    await sweeper.sweepOnce(policy);

    for (const id of [sent, suppressed]) {
      expect(await context.admin.notification.findUnique({ where: { id } })).toBeNull();
    }
    for (const id of [pending, processing]) {
      expect(await context.admin.notification.findUnique({ where: { id } })).not.toBeNull();
    }
  });

  it('never deletes an outbox event a consumer has not read', async () => {
    // The publisher marks a row PROCESSED once it reaches Redis, but the
    // notification dispatcher reads the same table on its own cursor. Pruning
    // on PROCESSED alone would throw away an event nobody has turned into a
    // message yet, and the customer would never hear that their order was
    // confirmed.
    const unread = await makeOutboxEvent(longAgo);
    const pending = await makeOutboxEvent(null);

    const floors = await context.admin.$queryRaw<Array<{ floor: bigint }>>`
      SELECT COALESCE(MIN(last_sequence), 0) AS floor FROM outbox_cursors
    `;
    // A newly created event is above every cursor by construction.
    expect(unread.sequence > (floors[0]?.floor ?? 0n)).toBe(true);

    await sweeper.sweepOnce(policy);

    expect(await context.admin.outboxEvent.findUnique({ where: { id: unread.id } })).not.toBeNull();
    expect(
      await context.admin.outboxEvent.findUnique({ where: { id: pending.id } }),
    ).not.toBeNull();
  });

  it('deletes one the slowest consumer has passed', async () => {
    const consumed = await makeOutboxEvent(longAgo);

    // Rolled back, so the cursor move is never committed: advancing a real
    // consumer's cursor would make it skip events other work depends on. What
    // is being proved is that the cursor is the only thing holding this row.
    const rollback = new Error('rollback');

    await expect(
      workerPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE outbox_cursors SET last_sequence = ${consumed.sequence}`;

        const rows = await tx.$queryRaw<Array<{ pruned_outbox_events: bigint }>>`
          SELECT * FROM app_prune_retention(
            '1 hours'::interval, '1 hours'::interval, '24 hours'::interval, '24 hours'::interval
          )
        `;
        expect(Number(rows[0]?.pruned_outbox_events ?? 0)).toBeGreaterThanOrEqual(1);

        const still = await tx.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) AS count FROM outbox_events WHERE id = ${consumed.id}::uuid
        `;
        expect(Number(still[0]?.count ?? -1)).toBe(0);

        throw rollback;
      }),
    ).rejects.toBe(rollback);

    // And it is back, because the transaction rolled back.
    expect(
      await context.admin.outboxEvent.findUnique({ where: { id: consumed.id } }),
    ).not.toBeNull();
  });

  it('prunes without the worker gaining read access to any of it', async () => {
    // The whole reason this is a SECURITY DEFINER function rather than a column
    // grant: DELETE needs SELECT on the columns in its WHERE clause, so doing
    // it directly would have handed a background process standing read access
    // to carts. It must still be refused.
    await expect(workerPrisma.$queryRaw`SELECT 1 FROM carts LIMIT 1`).rejects.toThrow(/permission/i);
    await expect(workerPrisma.$queryRaw`SELECT 1 FROM idempotency_keys LIMIT 1`).rejects.toThrow(
      /permission/i,
    );
    await expect(
      workerPrisma.$queryRaw`SELECT template_key FROM notifications LIMIT 1`,
    ).rejects.toThrow(/permission/i);
  });

  it('keeps the two logs for weeks, not hours', () => {
    // A support question — "what did we send that customer last Tuesday" —
    // arrives days late or not at all, so these defaults are the feature.
    expect(DEFAULT_RETENTION.notificationHours).toBeGreaterThanOrEqual(7 * 24);
    expect(DEFAULT_RETENTION.outboxHours).toBeGreaterThanOrEqual(7 * 24);
    expect(DEFAULT_RETENTION.cartGraceHours).toBeGreaterThan(0);
  });
});
