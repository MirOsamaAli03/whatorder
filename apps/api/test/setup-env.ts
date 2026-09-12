import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads the repo-root .env before any test runs.
 *
 * The application loads it during bootstrap, but the test harness reads
 * DATABASE_URL_ADMIN before Nest is constructed, so it has to be present
 * earlier than that.
 *
 * Values already present in process.env win, which is what lets
 * vitest.config.ts raise the rate limits for the suite without editing .env.
 */
const candidates = [
  resolve(process.cwd(), '../../.env'),
  resolve(process.cwd(), '.env'),
];

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
