import type { ApiErrorResponse, Permission } from '@restaurant-os/types';

/**
 * The dashboard's only route to the server.
 *
 * ENGINEERING_SPEC.md §87: channels are thin adapters over one application
 * layer. Everything this file does is transport — authentication, retries,
 * error shaping. It computes nothing. Prices, totals, tax, which status
 * transitions are legal and whether an item is available all arrive already
 * decided by the API, and the UI renders them verbatim.
 *
 * Session handling:
 *   * The access token lives in memory only. It is never written to
 *     localStorage, where any injected script could read it.
 *   * The refresh token is an httpOnly cookie the API set at login, so the
 *     browser sends it without this code ever seeing it.
 *   * A 401 triggers exactly one silent refresh and one retry. Concurrent
 *     requests share that single refresh rather than each starting their own.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:3001';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Array<{ path: string; message: string }>,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field-level messages, keyed by field, for rendering next to inputs. */
  get fieldErrors(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const detail of this.details ?? []) map[detail.path] = detail.message;
    return map;
  }
}

export interface SessionUser {
  userId: string;
  tenantId: string;
  membershipId: string;
  roles: string[];
  permissions: Permission[];
  branchIds: string[] | null;
  isPlatformAdmin: boolean;
}

export interface LoginResult {
  accessToken: string;
  expiresIn: number;
  user: { id: string; name: string; email: string };
  organization: { id: string; name: string; slug: string; type: string };
  roles: string[];
  permissions: Permission[];
  branchIds: string[] | null;
}

export interface OrganizationChoice {
  organizationSelectionRequired: true;
  organizations: Array<{ id: string; name: string; slug: string; type: string }>;
}

let accessToken: string | null = null;
/** Shared across concurrent 401s so only one refresh is ever in flight. */
let refreshInFlight: Promise<boolean> | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function hasAccessToken(): boolean {
  return accessToken !== null;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Extra headers, e.g. Idempotency-Key on order creation. */
  headers?: Record<string, string>;
  /** Skip the refresh-and-retry dance. Used by refresh itself. */
  noRetry?: boolean;
}

async function rawRequest(path: string, options: RequestOptions = {}): Promise<Response> {
  return fetch(`${API_URL}/api/v1${path}`, {
    method: options.method ?? 'GET',
    // Sends the httpOnly refresh cookie. The API allows this origin explicitly
    // via CORS_ORIGINS with credentials enabled.
    credentials: 'include',
    headers: {
      /**
       * Declared only when there is actually a body.
       *
       * Fastify rejects a request that announces `application/json` and then
       * sends nothing — "Body cannot be empty when content-type is set to
       * 'application/json'", a 400 — so a bodiless POST like
       * `/conversations/:id/resolve` failed before it reached the handler. The
       * symptom was a button that appeared to do nothing.
       */
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

/**
 * Exchanges the refresh cookie for a new access token.
 * Returns false when the session is genuinely over.
 */
export async function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const response = await rawRequest('/auth/refresh', {
        method: 'POST',
        body: {},
        noRetry: true,
      });

      if (!response.ok) {
        accessToken = null;
        return false;
      }

      const body = (await response.json()) as { data: { accessToken: string } };
      accessToken = body.data.accessToken;
      return true;
    } catch {
      accessToken = null;
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response = await rawRequest(path, options);

  // One silent refresh, one retry. A second 401 means the session is over and
  // the caller should send the user to sign in again.
  if (response.status === 401 && !options.noRetry) {
    const refreshed = await refreshSession();
    if (refreshed) {
      response = await rawRequest(path, options);
    }
  }

  if (!response.ok) {
    let payload: ApiErrorResponse | null = null;
    try {
      payload = (await response.json()) as ApiErrorResponse;
    } catch {
      /* not the standard envelope */
    }

    throw new ApiError(
      response.status,
      payload?.error?.code ?? 'INTERNAL_ERROR',
      payload?.error?.message ?? `Request failed with status ${response.status}`,
      payload?.error?.details,
      payload?.error?.requestId,
    );
  }

  if (response.status === 204) return undefined as T;

  const body = (await response.json()) as { data: T };
  return body.data;
}

// --- authentication ---------------------------------------------------------

export async function login(
  email: string,
  password: string,
  organizationSlug?: string,
): Promise<LoginResult | OrganizationChoice> {
  const result = await api<LoginResult | OrganizationChoice>('/auth/login', {
    method: 'POST',
    body: { email, password, ...(organizationSlug ? { organizationSlug } : {}) },
    noRetry: true,
  });

  if ('accessToken' in result) {
    accessToken = result.accessToken;
  }
  return result;
}

export async function logout(): Promise<void> {
  try {
    await api('/auth/logout', { method: 'POST', body: {} });
  } finally {
    accessToken = null;
  }
}

export function fetchMe(): Promise<SessionUser> {
  return api<SessionUser>('/auth/me');
}

/** The API base, for the one thing that cannot go through fetch: EventSource. */
export function apiUrl(): string {
  return API_URL;
}
