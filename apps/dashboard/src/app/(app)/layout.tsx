'use client';

import { Permission } from '@restaurant-os/types';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
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
  { href: '/menu', label: 'Menu', permission: Permission.MENU_VIEW },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const session = useRequireSession();
  const pathname = usePathname();

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
