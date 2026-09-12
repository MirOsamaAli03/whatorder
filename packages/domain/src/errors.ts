import { ErrorCode } from '@restaurant-os/types';

/**
 * Framework-free domain errors.
 *
 * The domain layer must not import from NestJS — it is shared with workers,
 * queue processors and AI tool handlers. Throwing these instead of
 * `HttpException` keeps the layering honest; a single exception filter in the
 * API translates them into the ENGINEERING_SPEC.md 62 envelope.
 */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    /** Suggested HTTP status. The transport decides; this is only a hint. */
    readonly status = 400,
    /** Safe to expose to the client. Never put internals here (spec 62). */
    readonly details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string, id?: string) {
    // The message never distinguishes "does not exist" from "belongs to
    // another tenant" — that distinction is itself an information leak
    // (ENGINEERING_SPEC.md 7).
    super(ErrorCode.NOT_FOUND, id ? `${entity} ${id} was not found` : `${entity} was not found`, 404);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'You do not have permission to perform this action') {
    super(ErrorCode.FORBIDDEN, message, 403);
  }
}

export class PermissionDeniedError extends DomainError {
  constructor(permission: string) {
    super(ErrorCode.PERMISSION_DENIED, `Missing required permission: ${permission}`, 403);
  }
}

export class BranchAccessDeniedError extends DomainError {
  constructor() {
    super(ErrorCode.BRANCH_ACCESS_DENIED, 'You do not have access to this branch', 403);
  }
}

export class TenantMismatchError extends DomainError {
  constructor() {
    super(ErrorCode.TENANT_MISMATCH, 'Resource does not belong to the current organization', 404);
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super(ErrorCode.CONFLICT, message, 409);
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, details?: Array<{ path: string; message: string }>) {
    super(ErrorCode.VALIDATION_ERROR, message, 422, details);
  }
}
