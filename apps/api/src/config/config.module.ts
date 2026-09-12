import { Global, Module } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv, type Env } from './env.schema';

export const ENV = Symbol('ENV');

/** Loads the repo-root .env without pulling in a dotenv dependency. */
function loadDotEnv(): void {
  const path = resolve(process.cwd(), '../../.env');
  const fallback = resolve(process.cwd(), '.env');
  const file = existsSync(path) ? path : existsSync(fallback) ? fallback : null;
  if (!file) return;

  for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
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
}

@Global()
@Module({
  providers: [
    {
      provide: ENV,
      useFactory: (): Env => {
        loadDotEnv();
        return parseEnv();
      },
    },
  ],
  exports: [ENV],
})
export class ConfigModule {}
