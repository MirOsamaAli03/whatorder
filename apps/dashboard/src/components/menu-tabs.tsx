'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The menu's three jobs, which are genuinely different tasks.
 *
 * "Sold out tonight" happens every service and is done by whoever is on the
 * floor. Building the menu happens once, carefully, and then rarely. Option
 * groups are shared across dishes, so editing one reaches further than the
 * dish you were looking at. Putting all three on one screen made the daily job
 * share a page with the dangerous one.
 */
const TABS = [
  { href: '/menu', label: 'Availability & prices' },
  { href: '/menu/structure', label: 'Structure' },
  { href: '/menu/options', label: 'Option groups' },
];

export function MenuTabs({ optionGroupCount }: { optionGroupCount?: number }) {
  const pathname = usePathname();

  return (
    <nav className="tabs" aria-label="Menu sections">
      {TABS.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          className="tab"
          // Exact, or /menu would claim to be the current page on every tab.
          aria-current={pathname === tab.href ? 'page' : undefined}
        >
          {tab.label}
          {tab.href === '/menu/options' && optionGroupCount !== undefined ? (
            <span className="chip-count">{optionGroupCount}</span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}
