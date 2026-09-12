import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DomainError } from '@restaurant-os/domain';
import { ErrorCode, type AccessTokenClaims, type RefreshTokenClaims } from '@restaurant-os/types';
import { createHash, randomBytes } from 'node:crypto';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';

/**
 * Issues and verifies the two token types.
 *
 * Access and refresh tokens are signed with SEPARATE secrets and carry a `typ`
 * claim, so an access token can never be replayed at the refresh endpoint even
 * if the secrets were ever misconfigured to match (the env schema also rejects
 * that outright).
 *
 * Only a SHA-256 hash of the refresh token is stored. A database leak
 * therefore yields no usable session. SHA-256 rather than argon2 is correct
 * here: the token is 256 bits of entropy from a CSPRNG, so there is no
 * dictionary to attack and the hash is checked on every refresh.
 */
@Injectable()
export class TokenService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly jwt: JwtService,
  ) {}

  async signAccessToken(input: {
    userId: string;
    sessionId: string;
    tenantId: string;
  }): Promise<string> {
    return this.jwt.signAsync(
      { sub: input.userId, sid: input.sessionId, tid: input.tenantId, typ: 'access' },
      { secret: this.env.JWT_ACCESS_SECRET, expiresIn: this.env.JWT_ACCESS_TTL },
    );
  }

  async signRefreshToken(input: { userId: string; sessionId: string }): Promise<string> {
    return this.jwt.signAsync(
      { sub: input.userId, sid: input.sessionId, typ: 'refresh', jti: randomBytes(16).toString('hex') },
      { secret: this.env.JWT_REFRESH_SECRET, expiresIn: this.env.JWT_REFRESH_TTL },
    );
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    const claims = await this.verify<AccessTokenClaims>(token, this.env.JWT_ACCESS_SECRET);
    if (claims.typ !== 'access') {
      throw new DomainError(ErrorCode.TOKEN_INVALID, 'Not an access token', 401);
    }
    return claims;
  }

  async verifyRefreshToken(token: string): Promise<RefreshTokenClaims> {
    const claims = await this.verify<RefreshTokenClaims>(token, this.env.JWT_REFRESH_SECRET);
    if (claims.typ !== 'refresh') {
      throw new DomainError(ErrorCode.TOKEN_INVALID, 'Not a refresh token', 401);
    }
    return claims;
  }

  private async verify<T extends object>(token: string, secret: string): Promise<T> {
    try {
      return await this.jwt.verifyAsync<T>(token, { secret });
    } catch (error) {
      const expired = error instanceof Error && error.name === 'TokenExpiredError';
      throw new DomainError(
        expired ? ErrorCode.TOKEN_EXPIRED : ErrorCode.TOKEN_INVALID,
        expired ? 'Token has expired' : 'Token is invalid',
        401,
      );
    }
  }

  /** The value stored in `sessions.refresh_token_hash`. */
  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
