/**
 * Presentation helpers.
 *
 * Nothing here does arithmetic on money. The API sends fixed two-place decimal
 * strings and these functions only add a currency label and separators — the
 * value itself passes through as text. Parsing it into a float to "format" it
 * would reintroduce exactly the rounding problem the Money type exists to
 * prevent (plan §2.6).
 */

/** `"2400.00"` -> `"Rs 2,400.00"`. The digits are never recomputed. */
export function formatMoney(amount: string, currency = 'PKR'): string {
  const negative = amount.startsWith('-');
  const [whole = '0', fraction = '00'] = amount.replace('-', '').split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const symbol = currency === 'PKR' ? 'Rs' : currency;
  return `${negative ? '-' : ''}${symbol} ${grouped}.${fraction}`;
}

/** Seconds as `m:ss`, or `h:mm:ss` past an hour. For kitchen timers. */
export function formatElapsed(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/** A wall-clock time in the viewer's locale, e.g. "19:42". */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** `OUT_FOR_DELIVERY` -> `Out for delivery`. */
export function humanize(value: string): string {
  const lower = value.replace(/_/g, ' ').toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
