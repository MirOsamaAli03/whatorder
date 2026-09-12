import { Controller, Get, HttpCode, HttpStatus, Inject, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { BranchAccessDeniedError, DomainError, canAccessBranch } from '@restaurant-os/domain';
import { ErrorCode, Permission, type AuthContext } from '@restaurant-os/types';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentUser, Public, RequirePermission } from '../common/decorators';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { orderChannel, RealtimeService, type RealtimeMessage } from '../realtime/realtime.service';
import { StreamTicketService } from '../realtime/stream-ticket.service';
import { kdsSinceSchema, kdsStreamSchema, type KdsSinceDto, type KdsStreamDto } from './kds.dto';
import { KdsService } from './kds.service';

/** How often to send a heartbeat comment down an idle stream. */
const HEARTBEAT_MS = 15_000;

@Controller('kds')
export class KdsController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly kds: KdsService,
    private readonly realtime: RealtimeService,
    private readonly tickets: StreamTicketService,
  ) {}

  /** The full state of a kitchen screen, plus the sequence watermark. */
  @Get('branches/:branchId/snapshot')
  @RequirePermission(Permission.ORDERS_VIEW)
  snapshot(
    @CurrentUser() auth: AuthContext,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ) {
    return this.kds.snapshot(auth, branchId);
  }

  /** Orders that have gone unacknowledged, with the rungs that have fired. */
  @Get('unacknowledged')
  @RequirePermission(Permission.ORDERS_VIEW)
  unacknowledged(
    @CurrentUser() auth: AuthContext,
    @Query('branchId') branchId?: string,
  ) {
    return this.kds.unacknowledged(auth, branchId);
  }

  /** Events missed while disconnected, or an instruction to resync. */
  @Get('branches/:branchId/since')
  @RequirePermission(Permission.ORDERS_VIEW)
  since(
    @CurrentUser() auth: AuthContext,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query(new ZodValidationPipe(kdsSinceSchema)) query: KdsSinceDto,
  ) {
    return this.kds.since(auth, branchId, BigInt(query.sequence));
  }

  /**
   * Issues a single-use ticket for opening the event stream.
   *
   * EventSource cannot send an Authorization header, and putting the access
   * token in the query string would write a live credential into every access
   * log. See StreamTicketService.
   */
  @Post('branches/:branchId/ticket')
  @RequirePermission(Permission.ORDERS_VIEW)
  @HttpCode(HttpStatus.OK)
  async ticket(
    @CurrentUser() auth: AuthContext,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ) {
    if (!canAccessBranch(auth, branchId)) throw new BranchAccessDeniedError();

    // Confirms the branch exists in this tenant before handing out a ticket
    // for it.
    await this.kds.snapshot(auth, branchId);

    return this.tickets.issue(auth, branchId);
  }

  /**
   * Server-Sent Events stream for one branch (ENGINEERING_SPEC.md 64).
   *
   * SSE rather than WebSockets: the kitchen screen only ever *receives* —
   * actions go over ordinary HTTP — and SSE brings automatic browser
   * reconnection, works through every proxy that speaks HTTP, and needs no
   * additional dependency. §64 permits either.
   *
   * Marked @Public because a browser cannot attach a bearer token to an
   * EventSource; the one-time ticket is the credential, and the channel is
   * derived from the ticket's claims rather than from the URL.
   */
  @Public()
  @Get('stream')
  async stream(
    @Query(new ZodValidationPipe(kdsStreamSchema)) query: KdsStreamDto,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const claims = await this.tickets.redeem(query.ticket);

    if (query.branchId && query.branchId !== claims.branchId) {
      // The ticket, not the URL, decides which branch this stream carries.
      throw new DomainError(
        ErrorCode.BRANCH_ACCESS_DENIED,
        'This ticket is not valid for that branch',
        403,
      );
    }

    /**
     * CORS is applied by hand here, and it has to be.
     *
     * Writing to `reply.raw` bypasses Fastify's reply pipeline completely, so
     * the `Access-Control-Allow-Origin` header that `app.enableCors()` would
     * normally add never reaches the response. The stream then works perfectly
     * from the same origin and fails in every browser that is not — which is
     * every real deployment, where the dashboard and the API are on different
     * hosts.
     *
     * The origin is echoed only when it is on the configured allowlist, so this
     * is the same policy as the rest of the API rather than a hole beside it.
     * No credentials header: the ticket in the query string is the credential,
     * and the browser sends no cookie with it.
     */
    const origin = request.headers.origin;
    const corsHeaders: Record<string, string> =
      origin && this.env.CORS_ORIGINS.includes(origin)
        ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
        : {};

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx buffers by default, which would hold events until the buffer
      // fills — fatal for a live kitchen screen.
      'X-Accel-Buffering': 'no',
      ...corsHeaders,
    });

    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // The client learns immediately which branch it is attached to and can
    // reconcile against its snapshot.
    send('connected', {
      branchId: claims.branchId,
      serverTime: new Date().toISOString(),
      heartbeatMs: HEARTBEAT_MS,
    });

    const channel = orderChannel(claims.tenantId, claims.branchId);

    const unsubscribe = await this.realtime.subscribe(channel, (message: RealtimeMessage) => {
      send('event', message);
    });

    // A comment frame keeps the connection warm through proxies with idle
    // timeouts, and gives the client something to measure staleness against:
    // no heartbeat for two intervals means the stream is dead even though the
    // socket still looks open (plan 2.8).
    const heartbeat = setInterval(() => {
      reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
    }, HEARTBEAT_MS);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      void unsubscribe();
    };

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  }
}
