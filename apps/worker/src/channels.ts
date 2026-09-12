/**
 * Real-time channel names (ENGINEERING_SPEC.md 64).
 *
 * The shape the spec gives is `tenant:{tenantId}:branch:{branchId}:orders`, and
 * the tenant id is baked into every channel deliberately: a subscriber can only
 * ever receive another tenant's events by subscribing to their channel, and the
 * API resolves the channel name from the session rather than from anything the
 * client sends (spec 64: "Never allow arbitrary channel subscription").
 *
 * Shared between the worker that publishes and the API that subscribes, so the
 * two cannot drift apart over a string.
 */

export function orderChannel(tenantId: string, branchId: string): string {
  return `tenant:${tenantId}:branch:${branchId}:orders`;
}

/** Tenant-wide events that are not tied to one branch, such as menu changes. */
export function tenantChannel(tenantId: string): string {
  return `tenant:${tenantId}:events`;
}

/** Pattern the API subscribes to in order to receive everything for a tenant. */
export function tenantPattern(tenantId: string): string {
  return `tenant:${tenantId}:*`;
}

/** What travels over the channel. */
export interface RealtimeMessage {
  /** Monotonic publication order, from outbox_events.sequence. */
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
