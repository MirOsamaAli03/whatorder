import { Injectable, PipeTransform } from '@nestjs/common';
import { ValidationError } from '@restaurant-os/domain';
import type { ZodSchema } from 'zod';

/**
 * Schema-based request validation (ENGINEERING_SPEC.md 61.3).
 *
 * Zod is used rather than class-validator so that the same schemas can be
 * reused outside the HTTP layer — by queue workers, the WhatsApp adapter and
 * the AI command contract (spec 24), none of which have a NestJS pipeline.
 *
 * Parsing also strips unknown keys, so a client cannot smuggle an unexpected
 * field such as `tenant_id` into a handler.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ValidationError(
        'Request validation failed',
        result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }
    return result.data;
  }
}

/** Convenience factory: `@Body(zodBody(loginSchema)) body: LoginInput`. */
export function zodBody<T>(schema: ZodSchema<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}
