import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Every environment variable the code reads must be declared in turbo.json.
 *
 * Turborepo runs each task in a **sanitised environment**: anything not listed
 * in `globalEnv` or `globalPassThroughEnv` is stripped before the task starts.
 * A variable that is read but not declared is therefore `undefined` inside a
 * task — and the failure has a nasty shape:
 *
 *   * Locally it does not happen. The test harness loads the repository's
 *     `.env` from disk, so the value is present regardless of what Turbo
 *     passed through.
 *   * In CI it does. There is no `.env` file, so the only source is the process
 *     environment — which Turbo has already filtered.
 *
 * That is exactly how `DATABASE_URL_WORKER` went missing: it was added in Phase
 * 4, never added here, and CI failed on it for four consecutive runs while
 * every local run passed. This test makes that class of drift a build failure
 * instead of a mystery.
 *
 * Static, like the other guards in this package: it reads files as text and
 * needs no database.
 */

const repoRoot = resolve(__dirname, '../../..');

const turbo = JSON.parse(readFileSync(resolve(repoRoot, 'turbo.json'), 'utf8')) as {
  globalEnv?: string[];
  globalPassThroughEnv?: string[];
};

const declared = new Set([...(turbo.globalEnv ?? []), ...(turbo.globalPassThroughEnv ?? [])]);

/**
 * Variables read somewhere the sanitised environment cannot reach them.
 *
 * Collected by hand rather than by scanning every `process.env.X` in the tree,
 * because plenty of those reads are in code Turbo never runs — scripts, the
 * seed, this test — and a scanner would either miss the ones that matter or
 * demand declarations for the ones that do not.
 */
const REQUIRED: ReadonlyArray<{ name: string; why: string }> = [
  { name: 'DATABASE_URL', why: 'the application role; every integration test' },
  { name: 'DATABASE_URL_ADMIN', why: 'migrations, the seed, and the test harness' },
  {
    name: 'DATABASE_URL_WORKER',
    why: 'the worker role, read directly by the kds and notification-pipeline tests',
  },
  { name: 'REDIS_URL', why: 'rate limiting, stream tickets, realtime fan-out' },
  { name: 'JWT_ACCESS_SECRET', why: 'the API refuses to boot without it' },
  { name: 'JWT_REFRESH_SECRET', why: 'the API refuses to boot without it' },
  { name: 'WHATSAPP_WEBHOOK_SECRET', why: 'inbound webhook signature verification' },
  { name: 'WHATSAPP_WEBHOOK_VERIFY_TOKEN', why: "Meta's subscription handshake" },
  { name: 'NODE_ENV', why: 'config validation and logger transport selection' },
];

describe('turbo.json environment passthrough', () => {
  it.each(REQUIRED)('declares $name ($why)', ({ name }) => {
    expect(declared.has(name)).toBe(true);
  });

  /**
   * The env schema is the API's own list of what it reads, so it is the best
   * available cross-check: anything required there must survive into a task.
   */
  it('declares every variable the API validates at boot', () => {
    const schema = readFileSync(
      resolve(repoRoot, 'apps/api/src/config/env.schema.ts'),
      'utf8',
    );

    // Keys of the zod object: `NAME: z.` at the start of a line.
    const keys = [...schema.matchAll(/^\s{4}([A-Z][A-Z0-9_]*):\s*z\./gm)].map((match) => match[1]!);

    expect(keys.length).toBeGreaterThan(5);

    const missing = keys.filter((key) => !declared.has(key));

    expect(
      missing,
      'These are read by apps/api/src/config/env.schema.ts but are stripped by ' +
        'Turborepo before a task runs. Add them to globalPassThroughEnv in ' +
        'turbo.json — the symptom otherwise is a CI-only failure that no local ' +
        'run reproduces.',
    ).toEqual([]);
  });

  it('declares the worker tuning variables', () => {
    const config = readFileSync(resolve(repoRoot, 'apps/worker/src/config.ts'), 'utf8');
    const keys = [...config.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]!);

    const missing = [...new Set(keys)].filter((key) => !declared.has(key));
    expect(missing).toEqual([]);
  });
});
