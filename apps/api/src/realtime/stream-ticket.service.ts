import { Injectable } from '@nestjs/common';
import { DomainError } from '@restaurant-os/domain';
import { ErrorCode, type AuthContext } from '@restaurant-os/types';
import { randomBytes } from 'node:crypto';
import { RedisService } from '../redis/redis.service';

/** Short, because a ticket is redeemed immediately after it is issued. */
const TICKET_TTL_SECONDS = 30;

export interface StreamTicketClaims {
  userId: string;
  tenantId: string;
  branchId: string;
  sessionId: string;
}

/**
 * One-time tickets for authenticating an SSE stream.
 *
 * The browser `EventSource` API cannot set an Authorization header, which
 * leaves two bad options and one good one. Putting the access token in the
 * query string writes a live credential into every access log, proxy log and
 * `Referer` header. Falling back to a cookie means the stream is reachable by
 * any page on the origin, which is a CSRF-shaped problem.
 *
 * Instead the client calls POST /kds/ticket with its normal bearer token and
 * gets a short-lived, single-use ticket bound to one user, tenant and branch.
 * The worst a leaked ticket can do is open one stream, for one branch, within
 * thirty seconds, once.
 */
@Injectable()
export class StreamTicketService {
  constructor(private readonly redis: RedisService) {}

  private key(ticket: string): string {
    return `stream-ticket:${ticket}`;
  }

  /** Issues a ticket for a branch the caller has already been authorised for. */
  async issue(auth: AuthContext, branchId: string): Promise<{ ticket: string; expiresIn: number }> {
    const ticket = randomBytes(32).toString('base64url');

    const claims: StreamTicketClaims = {
      userId: auth.userId,
      tenantId: auth.tenantId,
      branchId,
      sessionId: auth.sessionId,
    };

    await this.redis.client.set(
      this.key(ticket),
      JSON.stringify(claims),
      'EX',
      TICKET_TTL_SECONDS,
    );

    return { ticket, expiresIn: TICKET_TTL_SECONDS };
  }

  /**
   * Redeems a ticket, consuming it.
   *
   * GETDEL is atomic, so two racing connections cannot both redeem the same
   * ticket — which is what makes "single-use" true rather than aspirational.
   */
  async redeem(ticket: string): Promise<StreamTicketClaims> {
    const raw = await this.redis.client.getdel(this.key(ticket));

    if (!raw) {
      throw new DomainError(
        ErrorCode.UNAUTHENTICATED,
        'Stream ticket is invalid, expired, or already used',
        401,
      );
    }

    return JSON.parse(raw) as StreamTicketClaims;
  }
}
