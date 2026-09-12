import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { enterRequestContext } from './request-context';

/**
 * Installs the per-request context as part of the application module graph
 * rather than from the bootstrap file.
 *
 * It was originally registered in main.ts, which meant every other way of
 * standing the app up — integration tests, and later any embedded or
 * serverless bootstrap — silently lost request ids, and with them the
 * correlation between an error envelope, a log line and an audit row. Owning
 * it here makes the behaviour a property of the application.
 *
 * A Fastify `onRequest` hook rather than NestJS middleware: the hook runs
 * before guards, so the authentication guard can write the resolved caller
 * into the same store. `enterWith` is used because a hook has no callback to
 * wrap; it sets the store for the remainder of the async execution.
 */
@Injectable()
class RequestContextInstaller implements OnModuleInit {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  onModuleInit(): void {
    const instance = this.adapterHost.httpAdapter?.getInstance<FastifyInstance>();
    if (!instance?.addHook) return;

    instance.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
      const requestId = String(request.id);
      enterRequestContext({
        requestId,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });
      void reply.header('x-request-id', requestId);
      done();
    });
  }
}

@Module({ providers: [RequestContextInstaller] })
export class RequestContextModule {}
