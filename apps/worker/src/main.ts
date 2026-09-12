import {
  assertLeastPrivilegeConnection,
  assertWorkerConnection,
  createPrismaClient,
  createWorkerPrismaClient,
} from '@restaurant-os/database';
import {
  NotificationDispatcher,
  NotificationSender,
  createDefaultChannelRegistry,
} from '@restaurant-os/notifications';
import { createDefaultRegistry } from '@restaurant-os/whatsapp';
import Redis from 'ioredis';
import pino from 'pino';
import { loadWorkerConfig } from './config';
import { EscalationMonitor } from './escalation-monitor';
import { OutboxPublisher } from './outbox-publisher';

/**
 * Background worker (ENGINEERING_SPEC.md 32, 33, 58).
 *
 * A separate process from the API on purpose: a slow notification retry or a
 * long escalation sweep must never occupy a request handler, and the worker can
 * be restarted or scaled without touching the API.
 *
 * Four jobs today:
 *   OutboxPublisher        — drains committed domain events to Redis
 *   EscalationMonitor      — raises the alarm on unacknowledged orders
 *   NotificationDispatcher — turns those events into notification rows
 *   NotificationSender     — delivers them, with backoff
 *
 * The last two are separate on purpose. Deciding that somebody should be told
 * is cheap and must never be blocked; actually telling them involves a third
 * party that can be down for an hour. Splitting them is what lets invariant 8
 * hold as a schedule rather than as a hope.
 */
async function bootstrap(): Promise<void> {
  const config = loadWorkerConfig();

  const logger = pino({
    level: config.logLevel,
    base: { service: 'worker' },
    ...(process.env.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
      : {}),
  });

  const prisma = createWorkerPrismaClient(config.databaseUrl);
  await prisma.$connect();

  // Refuses to start if the worker role has more access than the design
  // intends — see packages/database/src/worker.ts.
  await assertWorkerConnection(prisma);
  logger.info('Worker database connection verified as least-privilege');

  // The second connection, as the application role. Tenant-scoped notification
  // work runs here under RLS, because the worker role is deliberately refused
  // customers at the database and a message needs a phone number. The same boot
  // guard the API uses refuses to start if this turns out to be the owner role
  // by mistake.
  const appPrisma = createPrismaClient({ databaseUrl: config.appDatabaseUrl });
  await appPrisma.$connect();
  await assertLeastPrivilegeConnection(appPrisma);
  logger.info('Application database connection verified as least-privilege');

  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  redis.on('error', (error: Error) => logger.error({ err: error }, 'Redis error'));

  const publisher = new OutboxPublisher(prisma, redis, logger.child({ job: 'outbox' }), {
    pollMs: config.outboxPollMs,
    batchSize: config.outboxBatchSize,
  });

  const escalations = new EscalationMonitor(prisma, logger.child({ job: 'escalation' }), {
    pollMs: config.escalationPollMs,
  });

  const whatsappProviders = createDefaultRegistry((message, detail) =>
    logger.debug(detail, message),
  );
  const channels = createDefaultChannelRegistry(whatsappProviders, (message, detail) =>
    logger.debug(detail, message),
  );

  const dispatcher = new NotificationDispatcher(
    prisma,
    appPrisma,
    logger.child({ job: 'notification-dispatch' }),
    { pollMs: config.notificationDispatchPollMs, batchSize: config.outboxBatchSize },
  );

  const sender = new NotificationSender(
    prisma,
    appPrisma,
    channels,
    logger.child({ job: 'notification-send' }),
    {
      pollMs: config.notificationSendPollMs,
      batchSize: config.notificationBatchSize,
      staleClaimMs: config.notificationStaleClaimMs,
    },
  );

  publisher.start();
  escalations.start();
  dispatcher.start();
  sender.start();

  logger.info('Restaurant OS worker running');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down');
    // Stop taking new work first, then release connections. An event published
    // but not yet marked PROCESSED will simply be republished on restart,
    // which at-least-once delivery already accounts for.
    await publisher.stop();
    await escalations.stop();
    await dispatcher.stop();
    await sender.stop();
    await redis.quit().catch(() => redis.disconnect());
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrap().catch((error: unknown) => {
  console.error('\nFailed to start the worker:\n');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
