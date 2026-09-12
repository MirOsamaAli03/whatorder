'use client';

import { Permission } from '@restaurant-os/types';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/api-client';
import { BranchProvider } from '@/lib/branch';
import { useRequireSession } from '@/lib/session';

interface NavItem {
  href: string;
  label: string;
  permission: Permission;
}

/**
 * Navigation adapts to what the signed-in user may actually do
 * (ENGINEERING_SPEC.md §44: "navigation should adapt according to tenant type
 * and permissions"). Kitchen staff see the kitchen display and nothing else.
 *
 * Hiding a link is courtesy, not security — the API refuses the request anyway.
 */
const NAV: NavItem[] = [
  { href: '/orders', label: 'Live orders', permission: Permission.ORDERS_VIEW },
  { href: '/kds', label: 'Kitchen', permission: Permission.ORDERS_VIEW },
  { href: '/conversations', label: 'Conversations', permission: Permission.CUSTOMERS_VIEW },
  { href: '/menu', label: 'Menu', permission: Permission.MENU_VIEW },
  { href: '/settings', label: 'Settings', permission: Permission.ORGANIZATION_VIEW },
];

/**
 * How many customers are waiting for a person to reply.
 *
 * A badge rather than a screen somebody has to remember to open. The bot tells
 * a customer "somebody will reply here shortly", and nobody is going to keep an
 * inbox tab in front of them during a dinner rush — so the number has to be
 * visible from wherever they already are.
 */
function useWaitingCount(enabled: boolean): number {
  const [waiting, setWaiting] = useState(0);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    const check = async () => {
      try {
        const result = await api<{ waiting: number }>('/conversations/waiting');
        if (!cancelled) setWaiting(result.waiting);
      } catch {
        // A failed poll is not worth interrupting anybody over; the next one
        // will pick it up, and the inbox itself reports its own errors.
      }
    };

    void check();
    const timer = setInterval(() => void check(), 15_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);

  return waiting;
}

export default function AppLayout({ children }: { children: ReactNode }) {
  const session = useRequireSession();
  const pathname = usePathname();

  // Before the early return below: a hook cannot be called conditionally, and
  // the polling is gated by its own argument instead.
  const waiting = useWaitingCount(
    session.status === 'authenticated' && session.can(Permission.CUSTOMERS_VIEW),
  );

  if (session.status !== 'authenticated' || !session.user) {
    return (
      <div className="auth">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  const visible = NAV.filter((item) => session.can(item.permission));

  return (
    <BranchProvider>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            Restaurant OS
            <small>{session.user.roles.join(', ') || 'No role'}</small>
          </div>

          <nav className="nav">
            {visible.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={pathname.startsWith(item.href) ? 'page' : undefined}
              >
                {item.label}
                {item.href === '/conversations' && waiting > 0 ? (
                  <span className="nav-badge" aria-label={`${waiting} waiting`}>
                    {waiting}
                  </span>
                ) : null}
              </Link>
            ))}
          </nav>

          <div className="sidebar-footer">
            {session.isBranchScoped ? (
              <span>Access limited to assigned branches</span>
            ) : (
              <span>Organization-wide access</span>
            )}
            <button type="button" className="btn btn-sm" onClick={() => void session.signOut()}>
              Sign out
            </button>
          </div>
        </aside>

        <main className="main">{children}</main>
      </div>
    </BranchProvider>
  );
}
