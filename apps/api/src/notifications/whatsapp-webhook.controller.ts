import { Body, Controller, ForbiddenException, Get, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public, RateLimit, RawResponse } from '../common/decorators';
import { WhatsAppWebhookService } from './whatsapp-webhook.service';

/**
 * The single inbound endpoint for every tenant's WhatsApp traffic.
 *
 * Public, because the provider has no session with us. Authentication is by
 * HMAC over the raw body instead, and the tenant is resolved from the
 * `phone_number_id` the payload carries rather than from anything the caller
 * claims — the same rule as everywhere else (spec 6).
 */
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  constructor(private readonly webhook: WhatsAppWebhookService) {}

  /**
   * Meta's subscription handshake: echo the challenge to prove we own the
   * endpoint. Rejected unless the verify token matches, or anybody could point
   * their app at this URL.
   *
   * @RawResponse() because Meta expects the challenge string and nothing else.
   * Wrapped in this API's standard success envelope it is not a match, and the
   * webhook simply cannot be registered — which is a failure at onboarding
   * time, long before any message is involved.
   */
  @Get()
  @Public()
  @RawResponse()
  @RateLimit({ limit: 30, windowSeconds: 60 })
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ): string {
    if (!this.webhook.verifyChallenge(mode, token)) {
      throw new ForbiddenException('Webhook verification failed');
    }
    return challenge;
  }

  /**
   * Always answers 200 once the signature checks out.
   *
   * A provider treats anything else as a failed delivery and redelivers, so
   * returning an error for a payload we could not understand would earn the
   * same payload again, forever. Unparseable and unroutable items are recorded
   * instead.
   *
   * The rate limit is generous on purpose: a busy chain's delivery receipts run
   * to several per order, and throttling them would drop real delivery
   * information.
   */
  @Post()
  @Public()
  @RateLimit({ limit: 600, windowSeconds: 60 })
  async receive(
    @Req() request: FastifyRequest & { rawBody?: Buffer },
    @Body() body: unknown,
  ): Promise<{ received: true; accepted: number; ignored: number }> {
    const signature = request.headers['x-hub-signature-256'];

    if (!this.webhook.verifySignature(request.rawBody, asHeader(signature))) {
      throw new ForbiddenException('Invalid webhook signature');
    }

    const result = await this.webhook.handle(body);
    return { received: true, ...result };
  }
}

function asHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
