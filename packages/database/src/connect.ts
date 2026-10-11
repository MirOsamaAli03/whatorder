import type { PrismaClient } from './client';

/**
 * Waits for the database instead of exiting when it is not there yet.
 *
 * `depends_on: condition: service_healthy` in the compose file governs only the
 * initial `up`. After a host reboot, `restart: unless-stopped` brings every
 * container back at once, so the API and the worker can start while Postgres is
 * still replaying its write-ahead log and answering
 * "the database system is starting up". Both then exited, Docker restarted
 * them, and they recovered within seconds — nothing was lost, but the logs read
 * like a broken deployment, and the first thing anybody does with a crash loop
 * is investigate it (backlog B-31).
 *
 * Bounded rather than infinite, deliberately. A database that is coming up
 * takes seconds; one that is never coming up is a problem somebody needs to be
 * told about, and a process that hangs for ever tells nobody. Giving up after
 * the budget is spent lets an orchestrator's own health checks notice.
 */

export interface ConnectWithRetryOptions {
  /** Total attempts, including the first. */
  attempts?: number;
  /** Delay before the second attempt; doubles up to maxDelayMs. */
  delayMs?: number;
  maxDelayMs?: number;
  /** Called before each wait, for a log line that explains the pause. */
  onRetry?: (attempt: number, error: unknown, waitMs: number) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_ATTEMPTS = 30;
const DEFAULT_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 5_000;

/**
 * Connects, retrying while the database is unreachable.
 *
 * Rethrows the last error once the budget is spent, so a genuinely
 * misconfigured connection string still fails loudly rather than silently
 * retrying for ever — the caller's existing error handling is unchanged.
 */
export async function connectWithRetry(
  prisma: Pick<PrismaClient, '$connect'>,
  options: ConnectWithRetryOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const maxDelay = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let delay = options.delayMs ?? DEFAULT_DELAY_MS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await prisma.$connect();
      return;
    } catch (error) {
      lastError = error;

      // The final failure is the caller's to report; do not sleep after it.
      if (attempt === attempts) break;

      options.onRetry?.(attempt, error, delay);
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelay);
    }
  }

  throw lastError;
}
