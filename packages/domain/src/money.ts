/**
 * Money — an exact currency value.
 *
 * Plan 2.6 / ENGINEERING_SPEC.md invariant 3: order totals are server
 * calculated and must be exact. JavaScript's `number` is a float, so
 * `0.1 + 0.2 !== 0.3`; doing arithmetic on rupee floats silently corrupts
 * revenue reporting a fraction of a paisa at a time.
 *
 * Every value is therefore held as an integer count of MINOR units (paisa for
 * PKR, cents for USD). Integers up to 2^53 are exact, which is roughly 90
 * trillion rupees — far beyond any order total.
 *
 * The database still stores DECIMAL(12,2) as the spec requires; this type is
 * what all arithmetic passes through in between.
 */

const MINOR_UNITS_PER_MAJOR = 100;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Rounds half away from zero: 2.5 -> 3, -2.5 -> -3. */
function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

export class Money {
  private constructor(
    /** Integer count of minor units (paisa). */
    public readonly minor: number,
    public readonly currency: string,
  ) {}

  static fromMinor(minor: number, currency = 'PKR'): Money {
    if (!Number.isInteger(minor)) {
      throw new MoneyError(`Minor units must be an integer, received ${minor}`);
    }
    if (!Number.isSafeInteger(minor)) {
      throw new MoneyError(`Minor units ${minor} exceeds safe integer range`);
    }
    return new Money(minor, currency);
  }

  /** From a major-unit amount, e.g. `Money.fromMajor(10.5)` is Rs 10.50. */
  static fromMajor(major: number, currency = 'PKR'): Money {
    if (!Number.isFinite(major)) {
      throw new MoneyError(`Amount must be finite, received ${major}`);
    }
    return Money.fromMinor(roundHalfAwayFromZero(major * MINOR_UNITS_PER_MAJOR), currency);
  }

  /**
   * From a decimal string, which is how DECIMAL columns and payment provider
   * payloads arrive. Parsed textually rather than via `parseFloat` so that no
   * float ever touches the value.
   */
  static fromDecimalString(value: string, currency = 'PKR'): Money {
    const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
    if (!match) {
      throw new MoneyError(`Invalid decimal money string: "${value}"`);
    }
    const sign = match[1];
    const whole = match[2] as string;
    const fraction = match[3] ?? '';
    const minor = Number(whole) * MINOR_UNITS_PER_MAJOR + Number(fraction.padEnd(2, '0'));
    return Money.fromMinor(sign ? -minor : minor, currency);
  }

  static zero(currency = 'PKR'): Money {
    return new Money(0, currency);
  }

  static sum(values: readonly Money[], currency = 'PKR'): Money {
    return values.reduce<Money>((acc, value) => acc.add(value), Money.zero(currency));
  }

  private assertSameCurrency(other: Money): void {
    // A zero of any currency is compatible, which keeps Money.sum() seeding simple.
    if (this.minor !== 0 && other.minor !== 0 && this.currency !== other.currency) {
      throw new MoneyError(`Currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }

  private pickCurrency(other: Money): string {
    return this.minor !== 0 ? this.currency : other.currency;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinor(this.minor + other.minor, this.pickCurrency(other));
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinor(this.minor - other.minor, this.pickCurrency(other));
  }

  /** Multiply by a whole quantity — the line-item case. Always exact. */
  multiply(quantity: number): Money {
    if (!Number.isInteger(quantity)) {
      throw new MoneyError(`Quantity must be an integer, received ${quantity}. Use rate() instead.`);
    }
    return Money.fromMinor(this.minor * quantity, this.currency);
  }

  /**
   * Apply a fractional rate — tax, service charge, percentage discount.
   * Rounds half away from zero at the paisa. This is the only place a
   * non-integer factor is permitted to touch a monetary value.
   */
  rate(factor: number): Money {
    if (!Number.isFinite(factor)) {
      throw new MoneyError(`Rate must be finite, received ${factor}`);
    }
    return Money.fromMinor(roundHalfAwayFromZero(this.minor * factor), this.currency);
  }

  /** `percentage(15)` is 15% of this amount. */
  percentage(percent: number): Money {
    return this.rate(percent / 100);
  }

  /**
   * Split into `parts` shares that sum EXACTLY back to this amount.
   * Remainder paisa are distributed one each to the earliest shares, so
   * Rs 10.00 into 3 gives [3.34, 3.33, 3.33] and never loses a paisa.
   */
  allocate(parts: number): Money[] {
    if (!Number.isInteger(parts) || parts <= 0) {
      throw new MoneyError(`Parts must be a positive integer, received ${parts}`);
    }
    const base = Math.trunc(this.minor / parts);
    let remainder = this.minor - base * parts;
    const step = remainder < 0 ? -1 : 1;
    return Array.from({ length: parts }, () => {
      let share = base;
      if (remainder !== 0) {
        share += step;
        remainder -= step;
      }
      return Money.fromMinor(share, this.currency);
    });
  }

  /** Clamps negatives to zero — used where a discount may exceed a subtotal. */
  clampToZero(): Money {
    return this.minor < 0 ? Money.zero(this.currency) : this;
  }

  isZero(): boolean {
    return this.minor === 0;
  }

  isNegative(): boolean {
    return this.minor < 0;
  }

  isPositive(): boolean {
    return this.minor > 0;
  }

  equals(other: Money): boolean {
    return this.minor === other.minor && this.currency === other.currency;
  }

  greaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor > other.minor;
  }

  lessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  /** The DECIMAL(12,2) representation written to Postgres. */
  toDecimalString(): string {
    const absolute = Math.abs(this.minor);
    const whole = Math.trunc(absolute / MINOR_UNITS_PER_MAJOR);
    const fraction = absolute % MINOR_UNITS_PER_MAJOR;
    return `${this.minor < 0 ? '-' : ''}${whole}.${String(fraction).padStart(2, '0')}`;
  }

  /**
   * Lossy: for display and JSON only. Never feed the result back into
   * arithmetic — round-trip through `minor` instead.
   */
  toMajorNumber(): number {
    return this.minor / MINOR_UNITS_PER_MAJOR;
  }

  toString(): string {
    return `${this.currency} ${this.toDecimalString()}`;
  }

  toJSON(): { minor: number; currency: string; formatted: string } {
    return { minor: this.minor, currency: this.currency, formatted: this.toDecimalString() };
  }
}
