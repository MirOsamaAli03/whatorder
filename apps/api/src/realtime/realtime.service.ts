import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';

/**
 * Channel names (ENGINEERING_SPEC.md 64).
 *
 * Mirrors apps/worker/src/channels.ts. The tenant id is baked into every
 * channel deliberately, and the API always derives the name from the session —
 * never from anything the client sends. Spec 64: "Never allow arbitrary channel
 * subscription."
 */
export function orderChannel(tenantId: string, branchId: string): string {
  return `tenant:${tenantId}:branch:${branchId}:orders`;
}

export function tenantChannel(tenantId: string): string {
  return `tenant:${tenantId}:events`;
}

export interface RealtimeMessage {
  sequence: string;
  eventId: string;
  eventType: string;
  tenantId: string;
  branchId: string | null;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

type Subscriber = (message: RealtimeMessage) => void;

/**
 * Fans domain events out to connected clients.
 *
 * The worker publishes to Redis; every API instance subscribes and pushes to
 * the clients it holds open. Redis is what lets a kitchen screen connected to
 * one instance see an order placed through another.
 *
 * One Redis connection per process, not per client: a busy chain with forty
 * screens would otherwise open forty subscriber connections per instance.
 */
@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  private readonly subscriber: Redis;

  /** channel -> the local listeners waiting on it. */
  private readonly listeners = new Map<string, Set<Subscriber>>();

  constructor(@Inject(ENV) env: Env) {
    this.subscriber = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      retryStrategy: (attempt) => Math.min(attempt * 200, 3_000),
    });
  }

  onModuleInit(): void {
    this.subscriber.on('message', (channel: string, raw: string) => {
      const listeners = this.listeners.get(channel);
      if (!listeners || listeners.size === 0) return;

      let message: RealtimeMessage;
      try {
        message = JSON.parse(raw) as RealtimeMessage;
      } catch (error) {
        this.logger.error({ err: error, channel }, 'Discarding malformed realtime message');
        return;
      }

      for (const listener of listeners) {
        try {
          listener(message);
        } catch (error) {
          // One broken client must not stop the others receiving the event.
          this.logger.error({ err: error, channel }, 'A realtime listener threw');
        }
      }
    });

    this.subscriber.on('error', (error: Error) => {
      this.logger.error({ err: error }, 'Realtime subscriber error');
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.listeners.clear();
    await this.subscriber.quit().catch(() => this.subscriber.disconnect());
  }

  /**
   * Subscribes to a channel. Returns an unsubscribe function.
   *
   * Callers pass a channel produced by `orderChannel`/`tenantChannel` from a
   * verified session; this method never builds one from user input.
   */
  async subscribe(channel: string, listener: Subscriber): Promise<() => Promise<void>> {
    let listeners = this.listeners.get(channel);

    if (!listeners) {
      listeners = new Set();
      this.listeners.set(channel, listeners);
      await this.subscriber.subscribe(channel);
    }

    listeners.add(listener);

    return async () => {
      const current = this.listeners.get(channel);
      if (!current) return;

      current.delete(listener);

      // The last listener leaving releases the Redis subscription, so an
      // instance does not accumulate channels for screens that went home.
      if (current.size === 0) {
        this.listeners.delete(channel);
        await this.subscriber.unsubscribe(channel).catch((error: unknown) => {
          this.logger.error({ err: error, channel }, 'Failed to unsubscribe');
        });
      }
    };
  }

  /** Open channels and their listener counts, for /ready and diagnostics. */
  stats(): { channels: number; listeners: number } {
    let listeners = 0;
    for (const set of this.listeners.values()) listeners += set.size;
    return { channels: this.listeners.size, listeners };
  }
}
