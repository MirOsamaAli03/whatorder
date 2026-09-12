import type { PrismaClient } from '@restaurant-os/database';
import { OutboxStatus } from '@restaurant-os/types';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { orderChannel, tenantChannel, type RealtimeMessage } from './channels';

/**
 * Drains the transactional outbox and publishes to Redis
 * (ENGINEERING_SPEC.md 58).
 *
 * The outbox closes the "database updated but event lost" gap on the write
 * side: the event is committed with the change that caused it. This publisher
 * closes the other half, moving committed events out to subscribers.
 *
 * Delivery is at-least-once, not exactly-once. A crash between publishing to
 * Redis and marking the row PROCESSED will republish on restart. That is the
 * correct trade: a duplicate "order is ready" is a harmless re-render on a
 * kitchen screen, while a lost one is an order nobody cooks. Every message
 * carries an eventId and a sequence so a consumer that cares can deduplicate.
 */
export class OutboxPublisher {
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
    private readonly logger: Logger,
    private readonly options: { pollMs: number; batchSize: number },
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(0);
    this.logger.info(
      { pollMs: this.options.pollMs, batchSize: this.options.batchSize },
      'Outbox publisher started',
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      const published = await this.drainOnce();
      // A full batch means there is probably more waiting, so come straight
      // back rather than sleeping through a backlog.
      this.scheduleNext(published >= this.options.batchSize ? 0 : this.options.pollMs);
    } catch (error) {
      this.logger.error({ err: error }, 'Outbox drain failed; retrying');
      this.scheduleNext(this.options.pollMs);
    }
  }

  /** Publishes one batch. Returns how many events were sent. */
  async drainOnce(): Promise<number> {
    const events = await this.prisma.outboxEvent.findMany({
      where: { status: OutboxStatus.PENDING },
      // Sequence order, so subscribers see events in the order they happened.
      orderBy: { sequence: 'asc' },
      take: this.options.batchSize,
    });

    if (events.length === 0) return 0;

    const publishedIds: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (const event of events) {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const branchId = typeof payload.branchId === 'string' ? payload.branchId : null;

      const message: RealtimeMessage = {
        sequence: event.sequence.toString(),
        eventId: event.id,
        eventType: event.eventType,
        tenantId: event.tenantId,
        branchId,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        payload,
        occurredAt: event.createdAt.toISOString(),
      };

      // Branch-scoped events go to the branch channel so a kitchen screen only
      // hears about its own orders; anything else is tenant-wide.
      const channel = branchId
        ? orderChannel(event.tenantId, branchId)
        : tenantChannel(event.tenantId);

      try {
        await this.redis.publish(channel, JSON.stringify(message));
        publishedIds.push(event.id);
      } catch (error) {
        failed.push({
          id: event.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (publishedIds.length > 0) {
      await this.prisma.outboxEvent.updateMany({
        where: { id: { in: publishedIds } },
        data: { status: OutboxStatus.PROCESSED, processedAt: new Date() },
      });
    }

    for (const failure of failed) {
      // Left PENDING on purpose, with the attempt counted: the next pass will
      // try again rather than the event being dropped.
      await this.prisma.outboxEvent.updateMany({
        where: { id: failure.id },
        data: { attempts: { increment: 1 }, lastError: failure.error.slice(0, 500) },
      });
    }

    if (failed.length > 0) {
      this.logger.warn(
        { published: publishedIds.length, failed: failed.length },
        'Some outbox events could not be published and remain pending',
      );
    } else {
      this.logger.debug({ published: publishedIds.length }, 'Outbox batch published');
    }

    return publishedIds.length;
  }
}
