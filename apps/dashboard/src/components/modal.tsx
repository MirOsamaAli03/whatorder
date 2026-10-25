'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A modal dialog.
 *
 * Editing used to open inline at the top of the menu, which meant clicking
 * Edit on a dish near the bottom of a long list appeared to do nothing at all
 * — the form opened off-screen. A dialog puts the form where the attention
 * already is and makes it obvious that something is open.
 *
 * The behaviour that matters is keyboard behaviour. Escape closes it, focus
 * moves into it when it opens and returns to whatever opened it when it
 * closes, and Tab is held inside while it is up — a dialog you can Tab behind
 * is a dialog a keyboard user loses. The page behind it is also frozen, since
 * a background that scrolls under a modal is disorienting on a phone.
 */
export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Roomier, for a form rather than a question. */
  wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;

    // Focus the first thing somebody would type into, or the panel itself.
    const focusable = panel.current?.querySelector<HTMLElement>(
      'input:not([type="hidden"]), select, textarea, button, [href]',
    );
    (focusable ?? panel.current)?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== 'Tab' || !panel.current) return;

      const stops = Array.from(
        panel.current.querySelectorAll<HTMLElement>(
          'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((node) => node.offsetParent !== null);

      if (stops.length === 0) return;

      const first = stops[0]!;
      const last = stops[stops.length - 1]!;

      // Wrap at both ends, so Tab never reaches the page behind.
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="scrim is-fixed"
      // A click on the backdrop dismisses; a click inside must not, which is
      // why this checks the target rather than relying on the event not
      // bubbling.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={wide ? 'dialog is-wide' : 'dialog'}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panel}
      >
        {children}
      </div>
    </div>
  );
}
