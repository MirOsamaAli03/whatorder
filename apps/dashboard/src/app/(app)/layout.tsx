'use client';

import { Permission } from '@restaurant-os/types';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import {
  ConversationsIcon,
  KitchenIcon,
  MenuIcon,
  OrdersIcon,
  SettingsIcon,
} from '@/components/icons';
import { api } from '@/lib/api-client';
import { BranchProvider } from '@/lib/branch';
import { useRequireSession } from '@/lib/session';

interface NavItem {
  href: string;
  /** The full name, used in the sidebar and as the accessible name. */
  label: string;
  /** The short name, used when the sidebar collapses to a rail or a bottom bar. */
  short: string;
  icon: ComponentType<{ className?: string }>;
  permission: Permission;
}

/**
 * Navigation adapts to what the signed-in user may actually do
 * (ENGINEERING_SPEC.md §44: "navigation should adapt according to tenant type
 * and permissions"). Kitchen staff see the kitchen display and nothing else.
 *
 * Hiding a link is courtesy, not security — the API refuses the request anyway.
 *
 * Two labels each, because the same link is a row in a 232px sidebar, an icon
 * in an 88px rail and a tab in a bottom bar. `label` is always the accessible
 * name regardless of which is on screen, so assistive technology and the
 * browser tests see one stable name at every width; `short` is contained within
 * it, which is what WCAG 2.5.3 asks for.
 */
const NAV: NavItem[] = [
  {
    href: '/orders',
    label: 'Live orders',
    short: 'Orders',
    icon: OrdersIcon,
    permission: Permission.ORDERS_VIEW,
  },
  {
    href: '/kds',
    label: 'Kitchen display',
    short: 'Kitchen',
    icon: KitchenIcon,
    permission: Permission.ORDERS_VIEW,
  },
  {
    href: '/conversations',
    label: 'Conversations',
    short: 'Inbox',
    icon: ConversationsIcon,
    permission: Permission.CUSTOMERS_VIEW,
  },
  {
    href: '/menu',
    label: 'Menu',
    short: 'Menu',
    icon: MenuIcon,
    permission: Permission.MENU_VIEW,
  },
  {
    href: '/settings',
    label: 'Settings',
    short: 'Settings',
    icon: SettingsIcon,
    permission: Permission.ORGANIZATION_VIEW,
  },
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

/** The restaurant's initial, for the brand mark. */
function initial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || 'R';
}

/** Somebody's initials, for the avatar. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]!.charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1]!.charAt(0) : '';
  return (first + last).toUpperCase();
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
      <div className="app auth-loading">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  /*
   * The kitchen display gets the whole screen.
   *
   * It is bolted to a wall and read from across the room, so a 232px column of
   * navigation is a fifth of the screen spent on links nobody taps — and a
   * tap-target beside a button a cook hits with the back of a hand. It keeps
   * the session guard and the branch context; it just loses the furniture.
   */
  if (pathname.startsWith('/kds')) {
    return (
      <BranchProvider>
        {children}
      </BranchProvider>
    );
  }

  const visible = NAV.filter((item) => session.can(item.permission));
  const organizationName = session.user.organization.name;
  const personName = session.user.name || session.user.email;

  return (
    <BranchProvider>
      <div className="app shell">
        {/* Phone only: the sidebar has become a bottom bar, so the restaurant
            name and the branch switcher need somewhere to live. */}
        <header className="topbar">
          <span className="brand-mark" aria-hidden="true">
            {initial(organizationName)}
          </span>
          <span className="topbar-name">{organizationName}</span>
        </header>

        <aside className="sidebar" aria-label="Main navigation">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              {initial(organizationName)}
            </span>
            <span className="brand-text">
              <span className="brand-name">{organizationName}</span>
              <span className="brand-sub">Restaurant OS</span>
            </span>
          </div>

          <nav className="nav">
            {visible.map((item) => {
              const Icon = item.icon;
              const current = pathname.startsWith(item.href);

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="nav-item"
                  aria-label={item.label}
                  aria-current={current ? 'page' : undefined}
                >
                  <Icon />
                  <span className="nav-label">{item.label}</span>
                  <span className="nav-short">{item.short}</span>
                  {item.href === '/conversations' && waiting > 0 ? (
                    <span className="badge badge-danger">{waiting}</span>
                  ) : null}
                </Link>
              );
            })}
          </nav>

          <div className="sidebar-foot">
            <span className="avatar" aria-hidden="true">
              {initials(personName)}
            </span>
            <span className="who">
              <b>{personName}</b>
              <span className="faint">
                {session.user.roles.join(', ') || 'No role'}
                {session.isBranchScoped ? ' · Access limited to assigned branches' : ''}
              </span>
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm sign-out"
              onClick={() => void session.signOut()}
            >
              Sign out
            </button>
          </div>
        </aside>

        <main className="main">{children}</main>
      </div>
    </BranchProvider>
  );
}
