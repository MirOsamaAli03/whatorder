#!/usr/bin/env node
/**
 * Runs the Prisma CLI as the SCHEMA OWNER rather than the application role.
 *
 * The application connects with a least-privilege role that cannot create
 * tables and cannot bypass RLS (see infrastructure/docker/init/01-app-role.sql).
 * Migrations need the opposite, so every `prisma migrate`/`studio` invocation
 * goes through here with DATABASE_URL swapped for DATABASE_URL_ADMIN.
 *
 * Also loads the repo-root .env, which Prisma would not find on its own from
 * this package directory.
 *
 * Usage: node scripts/prisma.mjs migrate dev
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const repoRoot = resolve(packageRoot, '..', '..');

/** Minimal .env reader — avoids a dependency for four lines of parsing. */
function loadEnvFile(path) {
  if (!existsSync(path)) return;
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
    // Real environment variables win over the file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(resolve(repoRoot, '.env'));

const adminUrl = process.env.DATABASE_URL_ADMIN;
if (!adminUrl) {
  console.error(
    '\nDATABASE_URL_ADMIN is not set.\n' +
      'Migrations must run as the schema owner, not the application role.\n' +
      'Copy .env.example to .env and fill it in (see docs/LOCAL_SETUP.md).\n',
  );
  process.exit(1);
}

/**
 * Resolve the Prisma CLI from node_modules rather than trusting PATH: PATH only
 * contains it when this script is launched through `npm run`, and running it
 * directly with `node` is a reasonable thing to do.
 */
function resolvePrismaBin() {
  const binName = process.platform === 'win32' ? 'prisma.cmd' : 'prisma';
  const candidates = [
    resolve(packageRoot, 'node_modules', '.bin', binName),
    resolve(repoRoot, 'node_modules', '.bin', binName),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? 'prisma';
}

const child = spawn(resolvePrismaBin(), process.argv.slice(2), {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  cwd: packageRoot,
  env: { ...process.env, DATABASE_URL: adminUrl },
});

child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', (error) => {
  console.error(`Failed to start the Prisma CLI: ${error.message}`);
  process.exit(1);
});
