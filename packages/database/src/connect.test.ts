import { describe, expect, it, vi } from 'vitest';
import { connectWithRetry } from './connect';

/**
 * Pure: the retry policy is exercised with a fake client and a fake clock, so
 * these run in milliseconds and need no database.
 */
function clientThatFails(times: number, error = new Error('the database system is starting up')) {
  let calls = 0;
  return {
    calls: () => calls,
    $connect: async () => {
      calls += 1;
      if (calls <= times) throw error;
    },
  };
}

const noSleep = async () => {};

describe('connectWithRetry', () => {
  it('returns immediately when the database is already up', async () => {
    const client = clientThatFails(0);
    await connectWithRetry(client, { sleep: noSleep });
    expect(client.calls()).toBe(1);
  });

  it('waits out a database that is still starting', async () => {
    // The real case: Postgres is replaying its write-ahead log after a reboot
    // and answers "the database system is starting up" for a few seconds.
    const client = clientThatFails(4);
    await connectWithRetry(client, { sleep: noSleep });
    expect(client.calls()).toBe(5);
  });

  it('gives up rather than hanging for ever', async () => {
    // A connection string pointing at nothing must still fail loudly: a
    // process that retries for ever tells nobody anything is wrong.
    const client = clientThatFails(Number.MAX_SAFE_INTEGER, new Error('ENOTFOUND db'));

    await expect(
      connectWithRetry(client, { attempts: 3, sleep: noSleep }),
    ).rejects.toThrow('ENOTFOUND db');

    expect(client.calls()).toBe(3);
  });

  it('backs off, and caps the wait', async () => {
    const waits: number[] = [];
    const client = clientThatFails(5);

    await connectWithRetry(client, {
      delayMs: 100,
      maxDelayMs: 400,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    // Doubling, then held at the cap rather than growing without limit.
    expect(waits).toEqual([100, 200, 400, 400, 400]);
  });

  it('does not sleep after the last attempt', async () => {
    // Sleeping and then giving up adds a pause nobody benefits from.
    const sleep = vi.fn(async () => {});
    const client = clientThatFails(Number.MAX_SAFE_INTEGER);

    await expect(connectWithRetry(client, { attempts: 3, sleep })).rejects.toThrow();

    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('reports each retry so the pause is explained in the log', async () => {
    const seen: Array<{ attempt: number; waitMs: number }> = [];
    const client = clientThatFails(2);

    await connectWithRetry(client, {
      delayMs: 50,
      sleep: noSleep,
      onRetry: (attempt, _error, waitMs) => seen.push({ attempt, waitMs }),
    });

    expect(seen).toEqual([
      { attempt: 1, waitMs: 50 },
      { attempt: 2, waitMs: 100 },
    ]);
  });
});
