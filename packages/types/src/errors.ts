/**
 * Machine-readable error codes returned in the `error.code` field
 * (ENGINEERING_SPEC.md 62). Clients branch on these; the human-readable
 * `message` is never load-bearing.
 */
export const ErrorCode = {
  // --- auth / authz ---
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  SESSION_REVOKED: 'SESSION_REVOKED',
  FORBIDDEN: 'FORBIDDEN',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  BRANCH_ACCESS_DENIED: 'BRANCH_ACCESS_DENIED',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',

  // --- tenancy ---
  TENANT_CONTEXT_MISSING: 'TENANT_CONTEXT_MISSING',
  TENANT_MISMATCH: 'TENANT_MISMATCH',
  ORGANIZATION_SUSPENDED: 'ORGANIZATION_SUSPENDED',

  // --- generic ---
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',

  // --- idempotency (spec 17) ---
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  IDEMPOTENT_REQUEST_IN_PROGRESS: 'IDEMPOTENT_REQUEST_IN_PROGRESS',

  // --- domain (populated as later phases land) ---
  ORDER_INVALID_STATE: 'ORDER_INVALID_STATE',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  MENU_ITEM_UNAVAILABLE: 'MENU_ITEM_UNAVAILABLE',
  BRANCH_CLOSED: 'BRANCH_CLOSED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Standard failure envelope (ENGINEERING_SPEC.md 62). */
export interface ApiErrorResponse {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    /** Field-level detail. Only ever populated for VALIDATION_ERROR. */
    details?: Array<{ path: string; message: string }>;
    /** Correlates a client-visible failure with server logs. */
    requestId?: string;
  };
}

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;
