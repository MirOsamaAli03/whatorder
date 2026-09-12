import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AuditAction,
  BranchStatus,
  Language,
  MembershipStatus,
  CartStatus,
  ConsentStatus,
  ConversationChannel,
  ConversationState,
  DeliveryZoneType,
  EscalationTarget,
  IdempotencyStatus,
  MessageDirection,
  MenuItemAvailability,
  ModifierSelectionType,
  NotificationChannel,
  NotificationStatus,
  OrderSource,
  OrderStatus,
  OrderType,
  PaymentMethod,
  PaymentStatus,
  OrganizationStatus,
  OrganizationType,
  OutboxStatus,
  RecipientType,
  UserStatus,
  WhatsAppSendMode,
  WhatsAppTemplateCategory,
  WhatsAppTemplateStatus,
} from '@restaurant-os/types';
import { NON_TENANT_TABLES } from './index';

/**
 * Static guards over the schema.
 *
 * These read the Prisma schema and the RLS migration as text, so they need no
 * database and run in milliseconds on every commit. Their job is to make two
 * classes of mistake impossible to merge:
 *
 *   1. An enum drifting between the database and @restaurant-os/types, which
 *      would surface as a runtime cast failure rather than a type error.
 *   2. A new tenant-owned table shipped without an RLS policy — the exact gap
 *      that ENGINEERING_SPEC.md Rule 7 exists to prevent, and the one most
 *      likely to appear quietly in a later phase.
 */

const migrationsDir = resolve(__dirname, '../prisma/migrations');

const schema = readFileSync(resolve(__dirname, '../prisma/schema.prisma'), 'utf8');

/**
 * Every migration's SQL, concatenated.
 *
 * Read as a whole rather than from one known file: each phase adds tables in a
 * new migration with its own policies, and a guard that only inspected the
 * Phase 1 migration would quietly stop covering everything added afterwards.
 */
const rlsMigration = readdirSync(migrationsDir)
  .filter((entry) => statSync(resolve(migrationsDir, entry)).isDirectory())
  .sort()
  .map((entry) => {
    const file = resolve(migrationsDir, entry, 'migration.sql');
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  })
  .join('\n');

/** Extracts the member names of one Prisma enum block. */
function prismaEnumValues(name: string): string[] {
  const match = new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`, 'm').exec(schema);
  if (!match?.[1]) {
    throw new Error(`Enum ${name} was not found in schema.prisma`);
  }
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//') && !line.startsWith('@@'));
}

/** Every model's mapped table name, paired with whether it has a tenant_id. */
function prismaModels(): Array<{ model: string; table: string; hasTenantId: boolean }> {
  const models: Array<{ model: string; table: string; hasTenantId: boolean }> = [];
  const modelPattern = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;

  let match: RegExpExecArray | null;
  while ((match = modelPattern.exec(schema)) !== null) {
    const [, model, body] = match;
    if (!model || !body) continue;
    const mapMatch = /@@map\("([^"]+)"\)/.exec(body);
    models.push({
      model,
      table: mapMatch?.[1] ?? model.toLowerCase(),
      hasTenantId: /\btenantId\s+String/.test(body),
    });
  }
  return models;
}

describe('enum parity between Prisma and @restaurant-os/types', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['OrganizationType', OrganizationType],
    ['OrganizationStatus', OrganizationStatus],
    ['BranchStatus', BranchStatus],
    ['UserStatus', UserStatus],
    ['MembershipStatus', MembershipStatus],
    ['Language', Language],
    ['AuditAction', AuditAction],
    ['MenuItemAvailability', MenuItemAvailability],
    ['ModifierSelectionType', ModifierSelectionType],
    ['OutboxStatus', OutboxStatus],
    ['OrderSource', OrderSource],
    ['OrderType', OrderType],
    ['OrderStatus', OrderStatus],
    ['PaymentStatus', PaymentStatus],
    ['PaymentMethod', PaymentMethod],
    ['CartStatus', CartStatus],
    ['DeliveryZoneType', DeliveryZoneType],
    ['IdempotencyStatus', IdempotencyStatus],
    ['EscalationTarget', EscalationTarget],
    ['NotificationChannel', NotificationChannel],
    ['NotificationStatus', NotificationStatus],
    ['RecipientType', RecipientType],
    ['WhatsAppTemplateCategory', WhatsAppTemplateCategory],
    ['WhatsAppTemplateStatus', WhatsAppTemplateStatus],
    ['MessageDirection', MessageDirection],
    ['WhatsAppSendMode', WhatsAppSendMode],
    ['ConsentStatus', ConsentStatus],
    ['ConversationState', ConversationState],
    ['ConversationChannel', ConversationChannel],
  ];

  it.each(cases)('%s matches', (name, typescriptEnum) => {
    expect(prismaEnumValues(name).sort()).toEqual(Object.values(typescriptEnum).sort());
  });

  it('covers every enum declared in the schema', () => {
    const declared = [...schema.matchAll(/enum\s+(\w+)\s*\{/g)].map((match) => match[1]);
    const asserted = cases.map(([name]) => name);
    // A new enum must be added to the parity list above, or it can drift
    // unnoticed.
    expect(declared.sort()).toEqual(asserted.sort());
  });
});

describe('Row-Level Security coverage', () => {
  const models = prismaModels();

  it('finds the expected models', () => {
    expect(models.length).toBeGreaterThan(5);
    expect(models.map((model) => model.table)).toContain('organizations');
  });

  it('enables RLS on every tenant-owned table', () => {
    const missing = models
      .filter((model) => model.hasTenantId || model.table === 'organizations')
      .filter((model) => !NON_TENANT_TABLES.includes(model.table))
      .filter(
        (model) =>
          !new RegExp(`ALTER TABLE\\s+"${model.table}"\\s+ENABLE ROW LEVEL SECURITY`, 'i').test(
            rlsMigration,
          ),
      )
      .map((model) => model.table);

    expect(
      missing,
      `These tenant-owned tables have no RLS policy. Add one to the row_level_security migration ` +
        `(ENGINEERING_SPEC.md Rule 7), or list the table in NON_TENANT_TABLES with a reason.`,
    ).toEqual([]);
  });

  it('declares a policy for every table that enables RLS', () => {
    const enabled = [
      ...rlsMigration.matchAll(/ALTER TABLE\s+"(\w+)"\s+ENABLE ROW LEVEL SECURITY/gi),
    ].map((match) => match[1]);

    // A table with RLS enabled but no policy denies everything, including to
    // the application. That is a far more confusing failure than a missing
    // policy, so catch it here.
    const withoutPolicy = enabled.filter(
      (table) => !new RegExp(`CREATE POLICY\\s+\\w+\\s+ON\\s+"${table}"`, 'i').test(rlsMigration),
    );

    expect(withoutPolicy).toEqual([]);
  });

  it('keeps audit_logs append-only', () => {
    // Policies exist for SELECT and INSERT only; with RLS enabled, an
    // operation without a policy is denied, so UPDATE and DELETE are blocked
    // at the database.
    const auditPolicies = [
      ...rlsMigration.matchAll(/CREATE POLICY\s+\w+\s+ON\s+"audit_logs"\s+FOR\s+(\w+)/gi),
    ].map((match) => match[1]?.toUpperCase());

    expect(auditPolicies.sort()).toEqual(['INSERT', 'SELECT']);
  });
});
