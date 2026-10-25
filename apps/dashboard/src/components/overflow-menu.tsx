'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface OverflowAction {
  key: string;
  label: string;
  onSelect: () => void;
  /** Renders the item in the danger colour: cancelling, rejecting, deleting. */
  danger?: boolean;
  disabled?: boolean;
  /** A short trailing note, e.g. what the action will do. */
  hint?: string;
}

/**
 * The "…" menu that holds a row's secondary actions.
 *
 * This exists because the old menu rows ended in three side-by-side buttons in
 * a 180px column: they wrapped to two lines, so no two rows lined up and the
 * list read as broken. One primary button plus this is the redesign's answer,
 * and it also scales — an order can have five legal transitions and a row
 * cannot have five buttons.
 *
 * Keyboard behaviour is the whole reason this is a component rather than a
 * `<details>`: Escape closes it and returns focus to the trigger, the arrow
 * keys walk the items, and a click anywhere else dismisses it. A menu that can
 * only be opened with a mouse would put the cancel action out of reach of
 * anybody using a keyboard.
 */
export function OverflowMenu({
  label,
  actions,
  disabled,
  triggerClassName = 'btn btn-icon btn-ghost',
  children,
}: {
  /** The accessible name of the trigger, e.g. "More actions for order 1044". */
  label: string;
  actions: OverflowAction[];
  disabled?: boolean;
  /**
   * The trigger's own classes. Defaults to the icon button used in table rows;
   * pass something else where the trigger carries a label, since `.btn-icon`
   * is a fixed square and would clip the text.
   */
  triggerClassName?: string;
  /** The trigger's content. Defaults to a horizontal ellipsis. */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  /**
   * Where to draw the popup, in viewport coordinates.
   *
   * Fixed rather than absolute, because every pane this menu appears in has
   * `overflow: hidden` to keep its corners rounded — which clipped the popup
   * to the row it belonged to. Measuring also lets it flip above the trigger
   * near the bottom of the window instead of opening off-screen.
   */
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      setAt(null);
      return;
    }

    const place = () => {
      const button = trigger.current?.getBoundingClientRect();
      const popup = wrap.current?.querySelector<HTMLElement>('.menu-pop');
      if (!button) return;

      const height = popup?.offsetHeight ?? 0;
      const width = popup?.offsetWidth ?? 232;
      const room = window.innerHeight - button.bottom;

      setAt({
        // Above the trigger when there is not room below for the whole menu.
        top: height > 0 && room < height + 12 ? button.top - height - 6 : button.bottom + 6,
        // Right-aligned to the trigger, nudged back inside the window.
        left: Math.max(8, Math.min(button.right - width, window.innerWidth - width - 8)),
      });
    };

    place();
    // Again once it has been measured, since the first pass has no height yet.
    const frame = requestAnimationFrame(place);

    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);

    const onPointerDown = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      // Returned deliberately: dismissing a menu should leave the keyboard
      // where it was, not at the top of the document.
      trigger.current?.focus();
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (actions.length === 0) return null;

  const items = () => Array.from(wrap.current?.querySelectorAll<HTMLButtonElement>('.menu-item') ?? []);

  const move = (from: HTMLElement, by: number) => {
    const all = items();
    const index = all.indexOf(from as HTMLButtonElement);
    const next = all[(index + by + all.length) % all.length];
    next?.focus();
  };

  return (
    <div className="menu-wrap" ref={wrap}>
      <button
        type="button"
        ref={trigger}
        className={triggerClassName}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((was) => !was)}
      >
        {children ?? <span aria-hidden="true">···</span>}
      </button>

      {open ? (
        <div
          className="menu-pop is-fixed"
          role="menu"
          aria-label={label}
          // Hidden until measured, so it never flashes in the wrong place.
          style={at ? { top: at.top, left: at.left } : { visibility: 'hidden' }}
        >
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              role="menuitem"
              className={action.danger ? 'menu-item is-danger' : 'menu-item'}
              disabled={action.disabled}
              onClick={() => {
                setOpen(false);
                action.onSelect();
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  move(event.currentTarget, 1);
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  move(event.currentTarget, -1);
                }
              }}
            >
              {action.label}
              {action.hint ? <span className="menu-hint">{action.hint}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
