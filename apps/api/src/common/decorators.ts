import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Permission } from '@restaurant-os/types';

/**
 * Marks a route as reachable without authentication.
 *
 * Authentication is on by default (JwtAuthGuard is registered globally), so
 * forgetting this decorator makes a route private rather than public — the
 * safe direction to fail (ENGINEERING_SPEC.md 61.1).
 */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Declares the permissions a route requires (ENGINEERING_SPEC.md 61.4).
 * All listed permissions must be held; PermissionsGuard enforces it.
 */
export const REQUIRED_PERMISSIONS_KEY = 'requiredPermissions';
export const RequirePermission = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);

/**
 * Returns the handler's result as-is, without the standard success envelope.
 *
 * For the rare route whose response shape is dictated by somebody else. Meta's
 * webhook subscription handshake is the case that forced this: it expects the
 * challenge string echoed back verbatim, and an envelope around it means the
 * webhook cannot be registered at all.
 *
 * Deliberately opt-in and rare. Every ordinary endpoint keeps the envelope
 * ENGINEERING_SPEC.md 61.7 requires.
 */
export const RAW_RESPONSE_KEY = 'rawResponse';
export const RawResponse = () => SetMetadata(RAW_RESPONSE_KEY, true);

/** Restricts a route to platform operators (the back office). */
export const PLATFORM_ONLY_KEY = 'platformOnly';
export const PlatformOnly = () => SetMetadata(PLATFORM_ONLY_KEY, true);

export interface RateLimitOptions {
  limit: number;
  windowSeconds: number;
}

/**
 * Named budgets whose limits come from configuration rather than from the
 * decorator, so an operator can tighten authentication limits under attack
 * without a deploy — and so tests can raise them without weakening the guard
 * itself (ENGINEERING_SPEC.md 67, 74: never hard-code tenant-facing behaviour).
 */
export type RateLimitCategory = 'auth' | 'default';

/** Per-route rate limit: a named category, or explicit numbers. */
export const RATE_LIMIT_KEY = 'rateLimit';
export const RateLimit = (spec: RateLimitCategory | RateLimitOptions) =>
  SetMetadata(RATE_LIMIT_KEY, spec);

/**
 * Injects the authenticated caller.
 *
 * Always resolved from the verified session, never from request input —
 * this is the mechanism behind spec 6's "never trust tenant_id supplied by
 * the client".
 */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<{ auth?: unknown }>();
  return request.auth;
});
