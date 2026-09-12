'use client';

import type { Permission } from '@restaurant-os/types';
import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  fetchMe,
  hasAccessToken,
  logout as apiLogout,
  refreshSession,
  type SessionUser,
} from './api-client';

interface SessionState {
  status: 'loading' | 'authenticated' | 'anonymous';
  user: SessionUser | null;
  /** Permission check, using the same permission strings the API enforces. */
  can: (permission: Permission) => boolean;
  /** True when the user is confined to specific branches (spec §7). */
  isBranchScoped: boolean;
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

/**
 * Holds the signed-in session.
 *
 * The access token lives in memory in api-client, so a page reload starts with
 * nothing and immediately exchanges the httpOnly refresh cookie for a new one.
 * That is the cost of never putting a token where a script can read it, and it
 * is why `status` has a `loading` state rather than assuming anonymous.
 *
 * Permissions here are for *rendering* only — hiding a button the user cannot
 * use. The API enforces the same permission again on every request, and is the
 * only thing that actually decides (spec §61.4). A tampered client gets a 403.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionState['status']>('loading');
  const [user, setUser] = useState<SessionUser | null>(null);

  const load = useCallback(async () => {
    try {
      if (!hasAccessToken()) {
        const refreshed = await refreshSession();
        if (!refreshed) {
          setUser(null);
          setStatus('anonymous');
          return;
        }
      }

      const me = await fetchMe();
      setUser(me);
      setStatus('authenticated');
    } catch {
      setUser(null);
      setStatus('anonymous');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const signOut = useCallback(async () => {
    await apiLogout().catch(() => undefined);
    setUser(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo<SessionState>(
    () => ({
      status,
      user,
      can: (permission) => user?.permissions.includes(permission) ?? false,
      isBranchScoped: user?.branchIds !== null && user?.branchIds !== undefined,
      signOut,
      reload: load,
    }),
    [status, user, signOut, load],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSession must be used inside a SessionProvider');
  }
  return context;
}

/** Sends anonymous visitors to the sign-in page once loading settles. */
export function useRequireSession(): SessionState {
  const session = useSession();
  const router = useRouter();

  useEffect(() => {
    if (session.status === 'anonymous') {
      router.replace('/login');
    }
  }, [session.status, router]);

  return session;
}
