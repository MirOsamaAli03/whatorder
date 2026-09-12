import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@restaurant-os/database';
import { DomainError } from '@restaurant-os/domain';
import { ErrorCode, IdempotencyStatus } from '@restaurant-os/types';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

/** How long a key is honoured before a retry is treated as a new request. */
const RETENTION_HOURS = 24;

export interface IdempotentResult<T> {
  replayed: boolean;
  value: T;
}

/**
 * Idempotent write handling (ENGINEERING_SPEC.md 17; invariant 7).
 *
 * A customer on a patchy mobile connection taps "Place order", the response is
 * lost, and the client retries. Without this they are charged twice and the
 * kitchen cooks twice. With it, the second request replays the first response.
 *
 * The claim is a unique INSERT, so two simultaneous retries race at the
 * database and exactly one wins — there is no read-then-write window for the
 * loser to slip through.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  hashRequest(body: unknown): string {
    return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
  }

  /**
   * Runs `work` at most once per key.
   *
   * On a repeat with the same key: returns the recorded response if the first
   * attempt finished, or refuses with IDEMPOTENT_REQUEST_IN_PROGRESS if it is
   * still running — the caller should wait and retry rather than start a second
   * order.
   *
   * A repeat with the same key but a DIFFERENT body is rejected outright. That
   * is a client bug, and honouring it would return someone else's order.
   */
  async run<T>(
    input: { tenantId: string; key: string; endpoint: string; body: unknown },
    work: () => Promise<T>,
  ): Promise<IdempotentResult<T>> {
    const requestHash = this.hashRequest(input.body);
    const expiresAt = new Date(Date.now() + RETENTION_HOURS * 3_600_000);

    const existing = await this.claim(input, requestHash, expiresAt);

    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new DomainError(
          ErrorCode.IDEMPOTENCY_KEY_REUSED,
          'This Idempotency-Key was already used for a different request',
          409,
        );
      }

      if (existing.status === IdempotencyStatus.IN_PROGRESS) {
        throw new DomainError(
          ErrorCode.IDEMPOTENT_REQUEST_IN_PROGRESS,
          'An identical request is still being processed. Retry shortly.',
          409,
        );
      }

      return { replayed: true, value: existing.responseBody as T };
    }

    try {
      const value = await work();

      await this.prisma.forTenant(input.tenantId, (tx) =>
        tx.idempotencyKey.updateMany({
          where: { key: input.key },
          data: {
            status: IdempotencyStatus.COMPLETED,
            responseStatus: 201,
            responseBody: (value ?? null) as Prisma.InputJsonValue,
            completedAt: new Date(),
          },
        }),
      );

      return { replayed: false, value };
    } catch (error) {
      // Release the key so the caller can genuinely retry. Keeping it would
      // make a transient failure permanent for the next 24 hours.
      await this.release(input.tenantId, input.key);
      throw error;
    }
  }

  /**
   * Claims the key, or returns the existing row when it is already taken.
   * The unique constraint on (tenant_id, key) is what makes this atomic.
   */
  private async claim(
    input: { tenantId: string; key: string; endpoint: string },
    requestHash: string,
    expiresAt: Date,
  ) {
    try {
      await this.prisma.forTenant(input.tenantId, (tx) =>
        tx.idempotencyKey.create({
          data: {
            tenantId: input.tenantId,
            key: input.key,
            endpoint: input.endpoint,
            requestHash,
            status: IdempotencyStatus.IN_PROGRESS,
            expiresAt,
          },
        }),
      );
      return null;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.forTenant(input.tenantId, (tx) =>
          tx.idempotencyKey.findFirst({ where: { key: input.key } }),
        );

        // An expired key is treated as absent: the row is replaced and the
        // request runs again.
        if (existing && existing.expiresAt <= new Date()) {
          await this.prisma.forTenant(input.tenantId, (tx) =>
            tx.idempotencyKey.updateMany({
              where: { key: input.key },
              data: {
                requestHash,
                endpoint: input.endpoint,
                status: IdempotencyStatus.IN_PROGRESS,
                responseBody: Prisma.DbNull,
                responseStatus: null,
                completedAt: null,
                expiresAt,
              },
            }),
          );
          return null;
        }

        return existing;
      }
      throw error;
    }
  }

  private async release(tenantId: string, key: string): Promise<void> {
    try {
      await this.prisma.forTenant(tenantId, (tx) =>
        tx.idempotencyKey.deleteMany({
          where: { key, status: IdempotencyStatus.IN_PROGRESS },
        }),
      );
    } catch (error) {
      // Never mask the original failure with a cleanup failure.
      this.logger.error({ err: error, key }, 'Failed to release an idempotency key');
    }
  }
}
