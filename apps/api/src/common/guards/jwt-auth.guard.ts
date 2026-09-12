import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError } from '@restaurant-os/domain';
import { ErrorCode } from '@restaurant-os/types';
import type { FastifyRequest } from 'fastify';
import { AuthService } from '../../auth/auth.service';
import { TokenService } from '../../auth/token.service';
import { IS_PUBLIC_KEY } from '../decorators';
import { setAuthContext } from '../request-context';

/**
 * Authenticates every request (ENGINEERING_SPEC.md 61.1, 61.2).
 *
 * Registered globally, so a route is private unless it opts out with
 * @Public(). Forgetting the decorator produces a locked route rather than an
 * open one.
 *
 * The resolved AuthContext — including tenantId — comes from the verified
 * session alone. No part of it is ever read from the request body, query or
 * headers, which is what makes spec 6 structural.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest & { auth?: unknown }>();
    const token = this.extractBearerToken(request.headers.authorization);

    if (!token) {
      throw new DomainError(ErrorCode.UNAUTHENTICATED, 'Authentication is required', 401);
    }

    const claims = await this.tokens.verifyAccessToken(token);
    const authContext = await this.auth.resolveAuthContext({
      userId: claims.sub,
      sessionId: claims.sid,
      tenantId: claims.tid,
    });

    request.auth = authContext;
    setAuthContext(authContext);
    return true;
  }

  private extractBearerToken(header: string | undefined): string | null {
    if (!header) return null;
    const [scheme, value] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' && value ? value : null;
  }
}
