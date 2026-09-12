import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Worker configuration.
 *
 * Deliberately tiny and dependency-free: the worker is the process that must
 * still start when everything else is having a bad day.
 */
export interface WorkerConfig {
  databaseUrl: string;
  /**
   * The APPLICATION role's connection string.
   *
   * The worker needs both. Discovering that work exists is a cross-tenant
   * question and belongs to the worker role; doing the work needs a customer's
   * phone number, which the worker role is deliberately refused at the
   * database. So tenant-scoped work runs on this connection under the same RLS
   * policy the API uses.
   */
  appDatabaseUrl: string;
  redisUrl: string;
  logLevel: string;
  /** How often to drain the outbox, in milliseconds. */
  outboxPollMs: number;
  /** How many events to publish per pass. */
  outboxBatchSize: number;
  /** How often to look for unacknowledged orders, in milliseconds. */
  escalationPollMs: number;
  /** How often to turn outbox events into notifications, in milliseconds. */
  notificationDispatchPollMs: number;
  /** How often to send queued notifications, in milliseconds. */
  notificationSendPollMs: number;
  notificationBatchSize: number;
  /**
   * How long a notification may sit PROCESSING before another worker reclaims
   * it. Long enough that a slow provider is not sent the same message twice,
   * short enough that a worker killed mid-send does not strand it.
   */
  notificationStaleClaimMs: number;
}

function loadEnvFile(): void {
  const candidates = [resolve(process.cwd(), '../../.env'), resolve(process.cwd(), '.env')];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
    break;
  }
}

export function loadWorkerConfig(): WorkerConfig {
  loadEnvFile();

  const databaseUrl = process.env.DATABASE_URL_WORKER;
  const appDatabaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;

  const missing = [
    ...(databaseUrl ? [] : ['DATABASE_URL_WORKER']),
    ...(appDatabaseUrl ? [] : ['DATABASE_URL']),
    ...(redisUrl ? [] : ['REDIS_URL']),
  ];

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'Copy .env.example to .env (see docs/LOCAL_SETUP.md).',
    );
  }

  return {
    databaseUrl: databaseUrl!,
    appDatabaseUrl: appDatabaseUrl!,
    redisUrl: redisUrl!,
    logLevel: process.env.LOG_LEVEL ?? 'info',
    outboxPollMs: Number(process.env.WORKER_OUTBOX_POLL_MS ?? 500),
    outboxBatchSize: Number(process.env.WORKER_OUTBOX_BATCH_SIZE ?? 100),
    escalationPollMs: Number(process.env.WORKER_ESCALATION_POLL_MS ?? 5_000),
    notificationDispatchPollMs: Number(process.env.WORKER_NOTIFICATION_DISPATCH_POLL_MS ?? 1_000),
    notificationSendPollMs: Number(process.env.WORKER_NOTIFICATION_SEND_POLL_MS ?? 1_000),
    notificationBatchSize: Number(process.env.WORKER_NOTIFICATION_BATCH_SIZE ?? 25),
    notificationStaleClaimMs: Number(process.env.WORKER_NOTIFICATION_STALE_CLAIM_MS ?? 120_000),
  };
}
