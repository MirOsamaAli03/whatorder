import type { Prisma } from '@restaurant-os/database';
import { Money } from '@restaurant-os/domain';

/**
 * Renders a DECIMAL column as a fixed two-place string.
 *
 * `Prisma.Decimal.toString()` drops trailing zeros — a column holding 450.00
 * stringifies as "450" — so using it directly produces a response where
 * `basePrice` reads "450" next to a resolved `price` of "450.00". Clients then
 * have to normalise money themselves, and eventually one of them does it with
 * `parseFloat`.
 *
 * Everything monetary leaving the API goes through here, so the wire format is
 * always exactly two places, and always parseable by Money.fromDecimalString
 * without a float in the path (plan 2.6).
 */
export function toMoneyString(value: Prisma.Decimal, currency = 'PKR'): string {
  return Money.fromDecimalString(value.toString(), currency).toDecimalString();
}

/** Same, for nullable columns. */
export function toMoneyStringOrNull(
  value: Prisma.Decimal | null | undefined,
  currency = 'PKR',
): string | null {
  return value === null || value === undefined ? null : toMoneyString(value, currency);
}
