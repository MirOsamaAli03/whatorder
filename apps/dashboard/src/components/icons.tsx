/**
 * The interface icons, lifted from the redesign's own SVG rather than redrawn.
 *
 * One file, plain inline SVG, no icon dependency: there are a dozen of them and
 * they never change independently of the design. Inline also means they inherit
 * `currentColor`, which is what lets a nav item, a button and a kitchen card
 * each tint its icon from its own text colour without a second rule.
 *
 * Every icon is `aria-hidden`. None of them is ever the only label for a
 * control — the accessible name always comes from real text or an aria-label on
 * the element itself (docs/DESIGN_BRIEF.md: no icon-only buttons without
 * accessible labels).
 */

interface IconProps {
  /** Overrides the 20px default; `.icon-sm` is 16 and `.icon-lg` is 28. */
  className?: string;
}

function Svg({ className = 'icon', children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** A receipt. Live orders. */
export function OrdersIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
      <path d="M9 8h6M9 12h6" />
    </Svg>
  );
}

/** A cloche. The kitchen display. */
export function KitchenIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 10h16v3a6 6 0 0 1-6 6h-4a6 6 0 0 1-6-6z" />
      <path d="M2 10h20M9 6c0-1 1-1.5 1-3M14 6c0-1 1-1.5 1-3" />
    </Svg>
  );
}

/** A speech bubble. Conversations handed to a person. */
export function ConversationsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 5h16v11H9l-5 4z" />
    </Svg>
  );
}

/** A bound menu card. */
export function MenuIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z" />
      <path d="M5 17a3 3 0 0 1 3-3h11M9 8h6" />
    </Svg>
  );
}

/** Sliders. Settings. */
export function SettingsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </Svg>
  );
}

/** A tick, for the sign-in panel's list. Heavier stroke, as drawn. */
export function CheckIcon({ className = 'icon' }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m5 12 5 5 9-10" />
    </svg>
  );
}

/** A warning roundel, for alerts. */
export function AlertIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 16h.01" />
    </Svg>
  );
}

/** A map pin, for the branch switcher. */
export function PinIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11z" />
      <circle cx="12" cy="10" r="2.5" />
    </Svg>
  );
}

/** A chevron, for a disclosure or a select. */
export function ChevronDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  );
}

/* ---------------------------------------------------------------------------
 * Food icons.
 *
 * A menu with no photographs would otherwise be a wall of text, and image
 * upload does not exist yet (backlog B-2). A tinted tile with a shape is not a
 * photograph, but it gives the eye something to land on and tells one category
 * from another at a glance — and unlike a photograph it costs no upload, no
 * storage and no moderation.
 * ------------------------------------------------------------------------- */

/** Skewers. */
export function SkewerIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m3 21 18-18" />
      <circle cx="9" cy="15" r="2.2" />
      <circle cx="13" cy="11" r="2.2" />
      <circle cx="17" cy="7" r="2.2" />
    </Svg>
  );
}

/** A karahi, handles and all. */
export function KarahiIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 11h18a9 6 0 0 1-18 0z" />
      <path d="M1 11h2M21 11h2M9 7c0-1 1-1.5 1-3M14 7c0-1 1-1.5 1-3" />
    </Svg>
  );
}

/** A bowl of rice. */
export function RiceIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 11h18a9 8 0 0 1-18 0z" />
      <path d="M7 8a5 3 0 0 1 10 0" />
    </Svg>
  );
}

/** A slice. */
export function PizzaIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3 3 19c6 3 12 3 18 0z" />
      <circle cx="11" cy="12" r="1.3" />
      <circle cx="14" cy="16" r="1.3" />
    </Svg>
  );
}

/** A cup. */
export function DrinkIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 4h14l-2 16H7z" />
      <path d="M5 9h14" />
    </Svg>
  );
}

/** A plate and cover — the fallback for a category we cannot guess. */
export function DishIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 12h16a8 8 0 0 0-16 0z" />
      <path d="M2 16h20M12 4v0" />
    </Svg>
  );
}

/** A left arrow, for going back from a thread to the list on a phone. */
export function BackIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M19 12H5M11 18l-6-6 6-6" />
    </Svg>
  );
}

/** A paper plane. Send. */
export function SendIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21 3 10.5 13.5M21 3l-7 18-3.5-7.5L3 10z" />
    </Svg>
  );
}

/** A clock, for waiting times and system notes. */
export function ClockIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Svg>
  );
}
