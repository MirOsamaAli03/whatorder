import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { DomainError } from '@restaurant-os/domain';
import { ErrorCode, type ApiErrorResponse } from '@restaurant-os/types';
import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { getRequestId } from '../request-context';

/**
 * Translates every thrown value into the ENGINEERING_SPEC.md 62 envelope.
 *
 * Rule from spec 62: stack traces, database errors, secrets, provider
 * credentials and internal implementation details never reach the client.
 * Unrecognised errors are logged in full server-side and returned as an opaque
 * INTERNAL_ERROR carrying only the request id, which is enough for support to
 * find the corresponding log line.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const requestId = getRequestId();
    const { status, body } = this.describe(exception, requestId);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        { err: exception, requestId },
        `Unhandled error: ${exception instanceof Error ? exception.message : String(exception)}`,
      );
    } else if (status === HttpStatus.FORBIDDEN || status === HttpStatus.UNAUTHORIZED) {
      // Authorization failures are security signal, not noise (spec 61.8).
      this.logger.warn({ requestId, code: body.error.code }, body.error.message);
    }

    void reply.status(status).send(body);
  }

  private describe(
    exception: unknown,
    requestId: string | undefined,
  ): { status: number; body: ApiErrorResponse } {
    if (exception instanceof DomainError) {
      return {
        status: exception.status,
        body: {
          success: false,
          error: {
            code: exception.code,
            message: exception.message,
            ...(exception.details ? { details: exception.details } : {}),
            ...(requestId ? { requestId } : {}),
          },
        },
      };
    }

    if (exception instanceof ZodError) {
      return {
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        body: {
          success: false,
          error: {
            code: ErrorCode.VALIDATION_ERROR,
            message: 'Request validation failed',
            details: exception.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
            ...(requestId ? { requestId } : {}),
          },
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: string | string[] }).message ?? exception.message);

      return {
        status,
        body: {
          success: false,
          error: {
            code: this.codeForStatus(status),
            message: Array.isArray(message) ? message.join('; ') : message,
            ...(requestId ? { requestId } : {}),
          },
        },
      };
    }

    // Anything else is a bug. Say nothing useful to the caller.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        success: false,
        error: {
          code: ErrorCode.INTERNAL_ERROR,
          message: 'An unexpected error occurred',
          ...(requestId ? { requestId } : {}),
        },
      },
    };
  }

  private codeForStatus(status: number): ErrorCode {
    switch (status) {
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.UNAUTHENTICATED;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ErrorCode.CONFLICT;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMITED;
      case HttpStatus.BAD_REQUEST:
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return ErrorCode.VALIDATION_ERROR;
      case HttpStatus.SERVICE_UNAVAILABLE:
        return ErrorCode.SERVICE_UNAVAILABLE;
      default:
        return ErrorCode.INTERNAL_ERROR;
    }
  }
}
