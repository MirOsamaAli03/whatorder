import { PrismaClient } from '@prisma/client';

// Exported as a value, not just a type: callers need Prisma.DbNull and
// Prisma.JsonNull at runtime to distinguish a SQL NULL column from a JSON
// `null` value stored inside one.
export { Prisma, PrismaClient } from '@prisma/client';

/**
 * A Prisma client restricted to what is valid inside a transaction.
 * Tenant-scoped work always runs in one (see withTenantContext), so services
 * are typed against this rather than the full client.
 */
export type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export interface PrismaClientOptions {
  /** Defaults to process.env.DATABASE_URL — the least-privilege app role. */
  databaseUrl?: string;
  /** Emit query-level logs. Development only; queries can contain PII. */
  logQueries?: boolean;
}

export function createPrismaClient(options: PrismaClientOptions = {}): PrismaClient {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set; refusing to start without a database connection');
  }

  return new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    log: options.logQueries
      ? [
          { emit: 'event', level: 'query' },
          { emit: 'stdout', level: 'warn' },
          { emit: 'stdout', level: 'error' },
        ]
      : [
          { emit: 'stdout', level: 'warn' },
          { emit: 'stdout', level: 'error' },
        ],
  });
}
