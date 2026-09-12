import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Req, Res } from '@nestjs/common';
import { DomainError } from '@restaurant-os/domain';
import { ErrorCode, type AuthContext } from '@restaurant-os/types';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentUser, Public, RateLimit } from '../common/decorators';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { AuthService } from './auth.service';
import { loginSchema, refreshSchema, type LoginDto, type RefreshDto } from './auth.dto';

/** Name of the httpOnly cookie carrying the refresh token. */
const REFRESH_COOKIE = 'ros_refresh';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly auth: AuthService,
  ) {}

  /**
   * POST /api/v1/auth/login
   *
   * Returns either a full session or, when the account belongs to several
   * organizations and none was named, the list to choose from.
   */
  @Public()
  @RateLimit('auth')
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(zodBody(loginSchema)) body: LoginDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.auth.login(body, {
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });

    if ('organizations' in result) {
      return { organizationSelectionRequired: true, organizations: result.organizations };
    }

    this.setRefreshCookie(reply, result.refreshToken);

    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: result.user,
      organization: result.organization,
      roles: result.roles,
      permissions: result.permissions,
      branchIds: result.branchIds,
    };
  }

  /**
   * POST /api/v1/auth/refresh
   *
   * Rotates the refresh token. Reads the cookie first and falls back to the
   * body for non-browser clients such as the future POS terminal.
   */
  @Public()
  @RateLimit('auth')
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body(zodBody(refreshSchema)) body: RefreshDto,
    @Req() request: FastifyRequest & { cookies?: Record<string, string | undefined> },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const token = request.cookies?.[REFRESH_COOKIE] ?? body.refreshToken;
    if (!token) {
      throw new DomainError(ErrorCode.UNAUTHENTICATED, 'No refresh token was provided', 401);
    }

    const tokens = await this.auth.refresh(token, {
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });

    this.setRefreshCookie(reply, tokens.refreshToken);
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn };
  }

  /** POST /api/v1/auth/logout — revokes the current session. */
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @CurrentUser() auth: AuthContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.auth.logout(auth.sessionId);
    void reply.clearCookie(REFRESH_COOKIE, { path: '/' });
    return { loggedOut: true };
  }

  /** GET /api/v1/auth/me — the caller's identity and effective grants. */
  @Get('me')
  me(@CurrentUser() auth: AuthContext) {
    return {
      userId: auth.userId,
      tenantId: auth.tenantId,
      membershipId: auth.membershipId,
      roles: auth.roles,
      permissions: auth.permissions,
      branchIds: auth.branchIds,
      isPlatformAdmin: auth.isPlatformAdmin,
    };
  }

  /**
   * httpOnly so client-side script cannot read the token even if the dashboard
   * is ever hit by XSS; sameSite=lax blocks the cross-site POST that CSRF
   * needs; secure in production because the cookie must never cross plain HTTP
   * (ENGINEERING_SPEC.md 66).
   */
  private setRefreshCookie(reply: FastifyReply, token: string): void {
    void reply.setCookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.env.NODE_ENV === 'production',
      path: '/',
      maxAge: this.env.JWT_REFRESH_TTL,
    });
  }
}
