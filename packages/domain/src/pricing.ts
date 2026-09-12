import { Money } from './money';
import { ValidationError } from './errors';

/**
 * Order pricing (ENGINEERING_SPEC.md 28; invariant 3).
 *
 * Pure functions over Money, so the same arithmetic runs for a POS sale, a
 * WhatsApp order and a website checkout, and can be tested exhaustively without
 * a database. Nothing here reads a number supplied by a client: callers pass
 * quantities and identifiers, and prices are looked up server-side before
 * arriving here.
 */

export interface PricedLine {
  /** Unit price after variant and modifiers, from resolveUnitPrice. */
  unitPrice: Money;
  quantity: number;
}

export interface PricingRules {
  /** Percentage, e.g. 15 for 15% GST. */
  taxPercent: number;
  /** Percentage added before tax, e.g. a 5% service charge on dine-in. */
  serviceChargePercent?: number;
  /**
   * Whether tax also applies to the delivery fee.
   *
   * ENGINEERING_SPEC.md 28 lists delivery fee before tax, which reads as though
   * tax covers it, but practice differs by tenant and jurisdiction. Made
   * explicit and defaulted to false rather than guessed, because getting it
   * wrong silently misreports every delivery order's tax.
   */
  taxAppliesToDeliveryFee?: boolean;
}

export interface PricingInput {
  lines: readonly PricedLine[];
  rules: PricingRules;
  /** Absolute discount, already resolved from promotions. */
  discount?: Money;
  deliveryFee?: Money;
  currency?: string;
}

export interface OrderTotals {
  subtotal: Money;
  discountAmount: Money;
  serviceCharge: Money;
  deliveryFee: Money;
  taxAmount: Money;
  total: Money;
}

/**
 * Computes an order's totals.
 *
 * Order of operations (spec 28):
 *   subtotal
 *     - discount            (never below zero)
 *     + service charge      (percentage of the discounted subtotal)
 *     + tax                 (on the discounted subtotal, plus delivery when configured)
 *     + delivery fee
 *     = total
 *
 * Discount is applied before tax so the customer is not taxed on money they did
 * not pay, and the service charge is computed on the discounted subtotal for
 * the same reason.
 */
export function computeOrderTotals(input: PricingInput): OrderTotals {
  const currency = input.currency ?? 'PKR';

  for (const line of input.lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new ValidationError(`Quantity must be a positive whole number, received ${line.quantity}`);
    }
  }

  const subtotal = Money.sum(
    input.lines.map((line) => line.unitPrice.multiply(line.quantity)),
    currency,
  );

  const requestedDiscount = input.discount ?? Money.zero(currency);
  if (requestedDiscount.isNegative()) {
    throw new ValidationError('Discount cannot be negative');
  }

  // A discount larger than the subtotal reduces the bill to zero; it never
  // becomes a credit the customer can walk away with.
  const discountAmount = requestedDiscount.greaterThan(subtotal) ? subtotal : requestedDiscount;
  const discountedSubtotal = subtotal.subtract(discountAmount);

  const deliveryFee = input.deliveryFee ?? Money.zero(currency);
  if (deliveryFee.isNegative()) {
    throw new ValidationError('Delivery fee cannot be negative');
  }

  const serviceCharge = discountedSubtotal.percentage(input.rules.serviceChargePercent ?? 0);

  const taxBase = input.rules.taxAppliesToDeliveryFee
    ? discountedSubtotal.add(serviceCharge).add(deliveryFee)
    : discountedSubtotal.add(serviceCharge);

  const taxAmount = taxBase.percentage(input.rules.taxPercent);

  const total = discountedSubtotal.add(serviceCharge).add(taxAmount).add(deliveryFee);

  return { subtotal, discountAmount, serviceCharge, deliveryFee, taxAmount, total };
}

/**
 * The business date an order belongs to, as YYYY-MM-DD (plan 2.6).
 *
 * Restaurants serve past midnight. An order taken at 01:30 belongs to the
 * previous trading day, and bucketing on the UTC timestamp puts it in the wrong
 * day twice over — once for the timezone, once for the late hour. Both are
 * corrected here so every daily revenue figure and "orders by hour" chart
 * (spec 46) reports what the restaurant actually experienced.
 *
 * @param instant      when the order was placed
 * @param timeZone     IANA zone, e.g. "Asia/Karachi"
 * @param startMinutes minutes past local midnight at which the day rolls over
 */
export function computeBusinessDate(
  instant: Date,
  timeZone: string,
  startMinutes = 0,
): string {
  if (!Number.isInteger(startMinutes) || startMinutes < 0 || startMinutes > 1439) {
    throw new ValidationError(`Business day start must be 0-1439 minutes, received ${startMinutes}`);
  }

  // Shifting the instant back by the rollover offset moves early-morning
  // trading into the previous calendar date before formatting.
  const shifted = new Date(instant.getTime() - startMinutes * 60_000);

  // en-CA formats as YYYY-MM-DD, which is what a DATE column wants.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(shifted);
}

/**
 * Great-circle distance in metres.
 *
 * Used for delivery-radius checks (spec 29). Straight-line distance
 * underestimates a real driving route, so a radius should be set conservatively
 * — this answers "is it plausibly close", not "how far will the rider ride".
 */
export function haversineMetres(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const EARTH_RADIUS_METRES = 6_371_000;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

  const deltaLat = toRadians(to.latitude - from.latitude);
  const deltaLon = toRadians(to.longitude - from.longitude);
  const fromLat = toRadians(from.latitude);
  const toLat = toRadians(to.latitude);

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.sin(deltaLon / 2) ** 2 * Math.cos(fromLat) * Math.cos(toLat);

  return Math.round(2 * EARTH_RADIUS_METRES * Math.asin(Math.sqrt(a)));
}
