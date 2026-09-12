import type { Permission } from './permissions';

/**
 * The authenticated caller, resolved from the session on every request.
 *
 * ENGINEERING_SPEC.md 6: "Never trust tenant_id supplied by the client.
 * Tenant context must be derived from the authenticated user/session."
 * Nothing in this object is ever read from the request body or query string.
 */
export interface AuthContext {
  userId: string;
  sessionId: string;
  /** The organization this session is acting within. */
  tenantId: string;
  membershipId: string;
  roles: string[];
  permissions: Permission[];
  /**
   * Branches this user may act on.
   *
   * `null` means organization-wide access (OWNER, REGIONAL_MANAGER...).
   * An array — possibly empty — means access is confined to exactly those
   * branch ids (ENGINEERING_SPEC.md 7).
   */
  branchIds: string[] | null;
  isPlatformAdmin: boolean;
}

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  tid: string;
  typ: 'access';
  iat: number;
  exp: number;
}

export interface RefreshTokenClaims {
  sub: string;
  sid: string;
  typ: 'refresh';
  iat: number;
  exp: number;
}
