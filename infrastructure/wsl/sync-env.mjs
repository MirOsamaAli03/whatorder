#!/usr/bin/env node
/**
 * Points .env at the PostgreSQL and Redis running inside WSL.
 *
 * Background: WSL2 normally forwards Windows `localhost` to the distribution,
 * but that forwarding is not active on every machine. Where it is missing, the
 * services are still reachable on the distribution's own IP — which changes
 * each time WSL restarts. This script rewrites the host in the three
 * connection strings in .env to the current address.
 *
 * A permanent alternative is mirrored networking, which makes `localhost` work
 * exactly as the docker-compose and CI setups assume. Create
 * `%USERPROFILE%\.wslconfig` with:
 *
 *     [wsl2]
 *     networkingMode=mirrored
 *
 * then run `wsl --shutdown`. That is a machine-wide WSL setting, so it is left
 * as a deliberate choice rather than something this script does for you.
 *
 * Usage: npm run wsl:sync-env
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const envPath = resolve(repoRoot, '.env');

if (!existsSync(envPath)) {
  console.error('.env not found. Copy .env.example to .env first.');
  process.exit(1);
}

function detectWslHost() {
  const raw = execFileSync('wsl', ['-e', 'bash', '-lc', 'hostname -I'], {
    encoding: 'utf8',
  });
  const address = raw.trim().split(/\s+/)[0];
  if (!address) {
    throw new Error('Could not determine the WSL IP address');
  }
  return address;
}

function reachable(host, port) {
  try {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `(Test-NetConnection ${host} -Port ${port} -WarningAction SilentlyContinue).TcpTestSucceeded`,
      ],
      { encoding: 'utf8' },
    );
    return true;
  } catch {
    return false;
  }
}

const host = detectWslHost();
console.log(`WSL address: ${host}`);

const original = readFileSync(envPath, 'utf8');

// Only the host segment of the three connection strings is touched; passwords,
// database names and every other setting are left exactly as they are.
const updated = original
  .replace(
    /^(DATABASE_URL=postgresql:\/\/[^@]+@)[^:]+(:\d+)/m,
    (_match, prefix, port) => `${prefix}${host}${port}`,
  )
  .replace(
    /^(DATABASE_URL_ADMIN=postgresql:\/\/[^@]+@)[^:]+(:\d+)/m,
    (_match, prefix, port) => `${prefix}${host}${port}`,
  )
  .replace(/^(REDIS_URL=redis:\/\/)[^:]+(:\d+)/m, (_match, prefix, port) => `${prefix}${host}${port}`);

if (updated === original) {
  console.log('.env already points at this address.');
} else {
  writeFileSync(envPath, updated);
  console.log('.env updated: DATABASE_URL, DATABASE_URL_ADMIN and REDIS_URL now use the WSL address.');
}

console.log(`\nPostgres reachable: ${reachable(host, 5432)}`);
console.log(`Redis reachable:    ${reachable(host, 6379)}`);
