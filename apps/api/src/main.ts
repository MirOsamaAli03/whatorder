import 'reflect-metadata';

import { Logger as NestLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Http2ServerRequest } from 'node:http2';
import { AppModule } from './app.module';
import { ENV } from './config/config.module';
import type { Env } from './config/env.schema';

/**
 * API bootstrap.
 *
 * Fastify rather than Express: the POS and the Kitchen Display System are
 * latency sensitive (ENGINEERING_SPEC.md 65), and Fastify's lower per-request
 * overhead is worth having before those arrive.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Fastify generates its own request ids; ours are propagated from the
      // client where present so a trace spans the dashboard and the API.
      // Receives the raw Node request, before Fastify has built its own.
      // Typed as HTTP/1.1 or HTTP/2 because the adapter supports both.
      genReqId: (request: IncomingMessage | Http2ServerRequest) =>
        (request.headers['x-request-id'] as string | undefined) ?? randomUUID(),
      trustProxy: true,
      bodyLimit: 1_048_576,
    }),
    {
      bufferLogs: true,
      /**
       * Keeps the raw request bytes available as `request.rawBody`.
       *
       * Provider webhook signatures are computed over exactly the bytes that
       * were sent. Re-serialising the parsed JSON produces a different byte
       * sequence — a reordered key or a changed number format is enough — and
       * the signature would never match.
       */
      rawBody: true,
    },
  );

  app.useLogger(app.get(Logger));

  const env = app.get<Env>(ENV);
  const logger = new NestLogger('Bootstrap');

  await app.register(import('@fastify/helmet'), {
    // The API serves JSON only; a restrictive default CSP is correct here.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },

    /**
     * Helmet defaults Cross-Origin-Resource-Policy to `same-origin`, which is
     * the right default for a site that serves its own pages and the wrong one
     * for an API whose whole purpose is to be read from another origin. The
     * dashboard runs on a different host in every real deployment, and a
     * browser refuses a `same-origin` resource across origins.
     *
     * Who may actually call this API is decided by the CORS allowlist below,
     * not by CORP.
     */
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
  await app.register(import('@fastify/cookie'));

  app.enableCors({
    origin: env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
  });

  // Health probes sit outside the versioned API so orchestrators are not
  // coupled to the API version (ENGINEERING_SPEC.md 69).
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });

  app.enableShutdownHooks();

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  logger.log(`Restaurant OS API listening on port ${env.PORT} (${env.NODE_ENV})`);
}

void bootstrap().catch((error: unknown) => {
  // Configuration and database-privilege failures land here. Print the reason
  // plainly: this is the message an operator sees when a deploy will not start.
  console.error('\nFailed to start the API:\n');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
