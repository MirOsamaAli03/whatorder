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

/* ---------------------------------------------------------------------------
 * Kitchen display.
 *
 * These are drawn heavier than the rest: a wall-mounted screen is read from
 * two metres, and a 2px stroke that reads fine on a laptop disappears at that
 * distance.
 * ------------------------------------------------------------------------- */

function KdsSvg({ className = 'icon', children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** A bright kitchen. */
export function SunIcon(props: IconProps) {
  return (
    <KdsSvg {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </KdsSvg>
  );
}

/** A dim kitchen. */
export function MoonIcon(props: IconProps) {
  return (
    <KdsSvg {...props}>
      <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" />
    </KdsSvg>
  );
}

/** Half-filled circle: follow whatever the device is set to. */
export function AutoThemeIcon(props: IconProps) {
  return (
    <KdsSvg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v18a9 9 0 0 0 0-18z" fill="currentColor" />
    </KdsSvg>
  );
}

/** A speaker with waves. The chime is on. */
export function SoundOnIcon(props: IconProps) {
  return (
    <KdsSvg {...props}>
      <path d="M4 9v6h4l5 4V5L8 9z" />
      <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />
    </KdsSvg>
  );
}

/** A speaker, crossed. */
export function SoundOffIcon(props: IconProps) {
  return (
    <KdsSvg {...props}>
      <path d="M4 9v6h4l5 4V5L8 9z" />
      <path d="m17 9 4 6M21 9l-4 6" />
    </KdsSvg>
  );
}

/** Two A's. Text size. */
export function TextSizeIcon(props: IconProps) {
  return (
    <KdsSvg {...props}>
      <path d="M3 19 8 5l5 14M4.8 14h6.4M15 19l3-8 3 8M15.9 16.5h4.2" />
    </KdsSvg>
  );
}

/** A door with an arrow. Leave the kitchen display. */
export function ExitIcon(props: IconProps) {
  return (
    <KdsSvg {...props}>
      <path d="M15 4h4v16h-4M10 16l-4-4 4-4M6 12h10" />
    </KdsSvg>
  );
}

/** A tick in a circle. Nothing outstanding. */
export function CheckCircleIcon(props: IconProps) {
  return (
    <KdsSvg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 3 3 5-6" />
    </KdsSvg>
  );
}

/** A bell. Nobody has acknowledged this order. */
export function BellIcon(props: IconProps) {
  return (
    <KdsSvg {...props}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </KdsSvg>
  );
}

/** A stopwatch. Running late. */
export function StopwatchIcon(props: IconProps) {
  return (
    <KdsSvg {...props}>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2 2M9 2h6" />
    </KdsSvg>
  );
}

/** A warning triangle. Late. */
export function WarningIcon(props: IconProps) {
  return (
    <KdsSvg {...props}>
      <path d="M12 3 2 20h20L12 3z" />
      <path d="M12 10v4M12 17h.01" />
    </KdsSvg>
  );
}

/** A motorbike. Delivery — the way most orders leave a kitchen here. */
export function DeliveryIcon(props: IconProps) {
  return (
    <KdsSvg {...props}>
      <circle cx="6" cy="17" r="3" />
      <circle cx="18" cy="17" r="3" />
      <path d="M6 17h7l3-7h3M9 10h4" />
    </KdsSvg>
  );
}

/** A paper bag. Collection. */
export function PickupIcon(props: IconProps) {
  return (
    <KdsSvg {...props}>
      <path d="M6 8h12l-1 12H7L6 8z" />
      <path d="M9 8a3 3 0 0 1 6 0" />
    </KdsSvg>
  );
}

/** A right arrow, on the card's action button. */
export function ArrowRightIcon(props: IconProps) {
  return (
    <KdsSvg {...props}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </KdsSvg>
  );
}
