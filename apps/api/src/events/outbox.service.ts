import { Injectable } from '@nestjs/common';
import { Prisma, type TransactionClient } from '@restaurant-os/database';
import type { AggregateType, DomainEventType } from '@restaurant-os/types';
import { randomUUID } from 'node:crypto';
import { getRequestContext } from '../common/request-context';

export interface EmitEventInput {
  eventType: DomainEventType;
  aggregateType: AggregateType;
  aggregateId: string;
  tenantId: string;
  payload: Record<string, unknown>;
  /** Defaults to the authenticated user; pass a channel name for bots. */
  actor?: string | null;
}

/**
 * Transactional outbox (ENGINEERING_SPEC.md 58).
 *
 * Events are written with the change that produced them, in the same
 * transaction, so the pair commits or rolls back together. That is what closes
 * the "database updated but event lost" gap that publishing to a queue from
 * inside a request handler always leaves open.
 *
 * There is no `emit` outside a transaction, deliberately: an event that is not
 * atomic with its change is exactly the thing this pattern exists to prevent.
 * A worker drains the table from Phase 4.
 */
@Injectable()
export class OutboxService {
  emit(tx: TransactionClient, input: EmitEventInput): Promise<Prisma.BatchPayload> {
    const context = getRequestContext();

    return tx.outboxEvent.createMany({
      data: [
        {
          id: randomUUID(),
          tenantId: input.tenantId,
          eventType: input.eventType,
          aggregateType: input.aggregateType,
          aggregateId: input.aggregateId,
          actor: input.actor ?? context?.auth?.userId ?? null,
          payload: input.payload as Prisma.InputJsonValue,
        },
      ],
    });
  }
}
