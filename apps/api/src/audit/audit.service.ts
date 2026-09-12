import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type TransactionClient } from '@restaurant-os/database';
import type { AuditAction } from '@restaurant-os/types';
import { getRequestContext } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  /** Null for unauthenticated events such as a failed login. */
  tenantId?: string | null;
  actorId?: string | null;
  actorType?: string;
  oldValues?: unknown;
  newValues?: unknown;
}

/**
 * Append-only audit trail (ENGINEERING_SPEC.md 59).
 *
 * Two ways in:
 *   record()   — standalone write, used for authentication events.
 *   recordIn() — writes inside an existing transaction, so the audit row
 *                commits atomically with the change it describes. Prefer it:
 *                a change that survives while its audit row is rolled back is
 *                exactly the gap an audit trail exists to close.
 *
 * Writing an audit row must never fail the operation being audited, so
 * standalone failures are logged and swallowed. Transactional writes
 * deliberately do not swallow: there, atomicity is the point.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * `createMany` rather than `create`, because `create` issues
   * INSERT ... RETURNING, and under RLS the returned row must also satisfy the
   * table's SELECT policy. Pre-authentication entries — a failed login — carry
   * a NULL tenant_id, which the SELECT policy deliberately excludes, so
   * `create` fails on a row that was inserted perfectly well. Nothing here
   * needs the row back.
   */
  async recordIn(tx: TransactionClient, entry: AuditEntry): Promise<void> {
    await tx.auditLog.createMany({ data: [this.toRow(entry)] });
  }

  async record(entry: AuditEntry): Promise<void> {
    try {
      if (entry.tenantId) {
        await this.prisma.forTenant(entry.tenantId, (tx) => this.recordIn(tx, entry));
      } else {
        await this.prisma.withoutTenant((tx) => this.recordIn(tx, entry));
      }
    } catch (error) {
      this.logger.error({ err: error, entry }, 'Failed to write audit log entry');
    }
  }

  private toRow(entry: AuditEntry) {
    const context = getRequestContext();
    return {
      tenantId: entry.tenantId ?? context?.auth?.tenantId ?? null,
      actorId: entry.actorId ?? context?.auth?.userId ?? null,
      actorType: entry.actorType ?? 'USER',
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      oldValues: this.redact(entry.oldValues),
      newValues: this.redact(entry.newValues),
      ipAddress: context?.ipAddress ?? null,
      userAgent: context?.userAgent ?? null,
      requestId: context?.requestId ?? null,
    };
  }

  /**
   * Strips secrets before they reach a long-lived table that many staff roles
   * can eventually read. The audit trail records that a password changed, never
   * what it changed to.
   *
   * Returns Prisma.DbNull rather than `null` so the column is written as SQL
   * NULL; a bare `null` would be stored as the JSON value `null`, which is a
   * different thing and would make "no previous value" indistinguishable from
   * "the previous value was null".
   */
  private redact(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
    if (value === null || value === undefined) return Prisma.DbNull;
    if (typeof value !== 'object') return { value } as Prisma.InputJsonValue;

    const sensitive = /password|secret|token|hash|credential|apiKey|api_key/i;
    const redacted: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      redacted[key] = sensitive.test(key) ? '[REDACTED]' : entryValue;
    }
    return redacted as Prisma.InputJsonValue;
  }
}
