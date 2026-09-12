import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ApiSuccessResponse } from '@restaurant-os/types';
import { map, type Observable } from 'rxjs';
import { RAW_RESPONSE_KEY } from '../decorators';

/**
 * Wraps every successful handler result in the standard success envelope
 * (ENGINEERING_SPEC.md 61.7), so clients can branch on `success` alone rather
 * than inspecting status codes.
 *
 * A handler marked @RawResponse() is returned untouched. That exists for the
 * rare route whose response shape somebody else dictates — Meta's webhook
 * handshake expects its challenge echoed back verbatim, and an envelope around
 * it means the webhook cannot be registered.
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiSuccessResponse<T> | T> {
  constructor(private readonly reflector: Reflector) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiSuccessResponse<T> | T> {
    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (raw) return next.handle();

    return next.handle().pipe(map((data) => ({ success: true as const, data })));
  }
}
