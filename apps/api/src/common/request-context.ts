import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthContext } from '@restaurant-os/types';

/**
 * Per-request ambient state.
 *
 * Carries the request id and the authenticated caller down to places that have
 * no access to the HTTP request object — the audit interceptor, the Prisma
 * tenant wrapper, log enrichment. AsyncLocalStorage keeps this correct across
 * awaits without threading a context parameter through every signature.
 *
 * The authenticated caller is written here exactly once, by the auth guard,
 * from the verified session. Nothing else may write it, and no handler may
 * take a tenant id from the request body (ENGINEERING_SPEC.md 6).
 */
export interface RequestContext {
  requestId: string;
  auth?: AuthContext;
  ipAddress?: string;
  userAgent?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * Enters a request context for the remainder of the current async execution.
 *
 * Used from Fastify's `onRequest` hook, where there is no callback to wrap:
 * `run()` would end the moment the hook returns, before the handler executes.
 */
export function enterRequestContext(context: RequestContext): void {
  storage.enterWith(context);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** The authenticated caller, or undefined on a public route. */
export function getAuthContext(): AuthContext | undefined {
  return storage.getStore()?.auth;
}

/**
 * Sets the authenticated caller for the current request. Called only by
 * JwtAuthGuard after the session has been verified.
 */
export function setAuthContext(auth: AuthContext): void {
  const store = storage.getStore();
  if (store) {
    store.auth = auth;
  }
}
