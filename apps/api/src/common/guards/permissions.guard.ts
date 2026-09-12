import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenError, PermissionDeniedError } from '@restaurant-os/domain';
import type { AuthContext, Permission } from '@restaurant-os/types';
import type { FastifyRequest } from 'fastify';
import { PLATFORM_ONLY_KEY, REQUIRED_PERMISSIONS_KEY } from '../decorators';

/**
 * Enforces the permissions a route declares (ENGINEERING_SPEC.md 61.4).
 *
 * Runs after JwtAuthGuard, so `request.auth` is present and trustworthy. All
 * declared permissions must be held — routes needing "any of" should express
 * that with a coarser permission rather than by weakening this check.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const platformOnly = this.reflector.getAllAndOverride<boolean>(PLATFORM_ONLY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const required = this.reflector.getAllAndOverride<Permission[]>(REQUIRED_PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!platformOnly && (!required || required.length === 0)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest & { auth?: AuthContext }>();
    const auth = request.auth;

    if (!auth) {
      // Only reachable if a route is marked @Public() but also declares
      // permissions — a configuration mistake, not a client error.
      throw new ForbiddenError('This route requires an authenticated caller');
    }

    if (platformOnly && !auth.isPlatformAdmin) {
      throw new ForbiddenError('This route is restricted to platform operators');
    }

    for (const permission of required ?? []) {
      if (!auth.permissions.includes(permission)) {
        throw new PermissionDeniedError(permission);
      }
    }

    return true;
  }
}
