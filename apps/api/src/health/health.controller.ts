import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/**
 * Health endpoints (ENGINEERING_SPEC.md 69).
 *
 * /health  — liveness. Answers as long as the process is running; it must not
 *            touch dependencies, or a database blip would cause an orchestrator
 *            to kill otherwise healthy instances.
 * /ready   — readiness. Checks PostgreSQL and Redis, and returns 503 when a
 *            dependency is down so a rolling deploy stops sending traffic.
 */
@Controller()
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get('health')
  health() {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  @Public()
  @Get('ready')
  @HttpCode(HttpStatus.OK)
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    const [database, redis] = await Promise.all([this.prisma.ping(), this.redis.ping()]);
    const ready = database && redis;

    if (!ready) {
      void reply.status(HttpStatus.SERVICE_UNAVAILABLE);
    }

    return {
      status: ready ? 'ready' : 'not_ready',
      checks: { database, redis },
    };
  }
}
