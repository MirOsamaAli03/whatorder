import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError } from '@restaurant-os/domain';
import { ErrorCode, type AuthContext } from '@restaurant-os/types';
import type { FastifyRequest } from 'fastify';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { RedisService } from '../../redis/redis.service';
import { RATE_LIMIT_KEY, type RateLimitCategory, type RateLimitOptions } from '../decorators';

/**
 * Redis-backed rate limiting (ENGINEERING_SPEC.md 67).
 *
 * Keyed by authenticated user where available and by client IP otherwise, so
 * one abusive tenant cannot exhaust another's budget. Routes tighten the limit
 * with @RateLimit — authentication and, later, the public order, reservation,
 * payment and AI endpoints.
 *
 * If Redis is unavailable the request is allowed through: an outage must not
 * take ordering offline. That is a deliberate availability-over-enforcement
 * trade, and the failure is logged so it cannot pass unnoticed.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const spec = this.reflector.getAllAndOverride<RateLimitCategory | RateLimitOptions>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );

    const { limit, windowSeconds } = this.resolve(spec);

    const request = context.switchToHttp().getRequest<FastifyRequest & { auth?: AuthContext }>();
    const identity = request.auth
      ? `user:${request.auth.userId}`
      : `ip:${request.ip ?? 'unknown'}`;
    const route = `${request.method}:${request.routeOptions?.url ?? request.url}`;
    const window = Math.floor(Date.now() / (windowSeconds * 1000));
    const key = `ratelimit:${route}:${identity}:${window}`;

    try {
      const count = await this.redis.incrementWindow(key, windowSeconds);
      if (count > limit) {
        throw new DomainError(
          ErrorCode.RATE_LIMITED,
          'Too many requests. Please slow down and try again shortly.',
          429,
        );
      }
      return true;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      this.logger.error(
        { err: error },
        'Rate limiting is unavailable; allowing the request through',
      );
      return true;
    }
  }

  private resolve(
    spec: RateLimitCategory | RateLimitOptions | undefined,
  ): { limit: number; windowSeconds: number } {
    if (spec === 'auth') {
      return { limit: this.env.RATE_LIMIT_AUTH_PER_MINUTE, windowSeconds: 60 };
    }
    if (spec === 'default' || spec === undefined) {
      return { limit: this.env.RATE_LIMIT_DEFAULT_PER_MINUTE, windowSeconds: 60 };
    }
    return { limit: spec.limit, windowSeconds: spec.windowSeconds };
  }
}
