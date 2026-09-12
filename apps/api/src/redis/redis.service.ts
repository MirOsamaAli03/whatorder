import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';

/**
 * Redis connection, used in Phase 1 for rate limiting (ENGINEERING_SPEC.md 67)
 * and from Phase 4 onward for BullMQ queues and real-time fan-out.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(@Inject(ENV) env: Env) {
    this.client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      // Fail fast rather than queueing commands against a dead Redis: rate
      // limiting must not become a source of request latency.
      enableOfflineQueue: false,
      lazyConnect: false,
      retryStrategy: (attempt) => Math.min(attempt * 200, 3_000),
    });

    this.client.on('error', (error: Error) => {
      this.logger.error({ err: error }, `Redis error: ${error.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => this.client.disconnect());
  }

  /**
   * Fixed-window counter. Returns the current count for the window.
   *
   * A fixed window admits up to double the limit across a window boundary.
   * That is an acceptable trade for Phase 1; the sliding-window upgrade
   * belongs with the public order APIs in Phase 3.
   */
  async incrementWindow(key: string, windowSeconds: number): Promise<number> {
    const results = await this.client
      .multi()
      .incr(key)
      .expire(key, windowSeconds, 'NX')
      .exec();

    const incrResult = results?.[0];
    if (!incrResult || incrResult[0]) {
      throw incrResult?.[0] ?? new Error('Redis rate limit command failed');
    }
    return Number(incrResult[1]);
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch (error) {
      this.logger.error({ err: error }, 'Redis readiness check failed');
      return false;
    }
  }
}
