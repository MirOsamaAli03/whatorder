import { ValidationError } from '@restaurant-os/domain';

/**
 * Phone number normalisation.
 *
 * The phone number is a customer's identity: it is how WhatsApp addresses them,
 * how the POS finds a repeat customer, and what `customers.phone` is unique on.
 * The same person will present it as "0300 1234567", "3001234567",
 * "+92 300 1234567" and "0092-300-1234567" across channels, and each of those
 * creating a separate customer record is how a CRM quietly becomes useless.
 *
 * Everything is stored in E.164 (`+923001234567`). This is a deliberately small
 * implementation covering the numbering plans the product targets rather than a
 * full libphonenumber dependency; it rejects anything it cannot confidently
 * normalise instead of guessing.
 */

const DEFAULT_COUNTRY_CODE = '92';

/** National significant number lengths, by country calling code. */
const NSN_LENGTHS: Record<string, { min: number; max: number }> = {
  '92': { min: 10, max: 10 }, // Pakistan: 3XXXXXXXXX
  '91': { min: 10, max: 10 }, // India
  '971': { min: 8, max: 9 }, // UAE
  '966': { min: 9, max: 9 }, // Saudi Arabia
  '44': { min: 9, max: 10 }, // United Kingdom
  '1': { min: 10, max: 10 }, // US / Canada
};

export function normalizePhone(input: string, defaultCountryCode = DEFAULT_COUNTRY_CODE): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new ValidationError('Phone number is required');
  }

  // Keep a leading + as a marker, drop every other non-digit: spaces, dashes,
  // brackets and the occasional stray letter.
  const hadPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/\D/g, '');

  if (!digits) {
    throw new ValidationError(`"${input}" is not a usable phone number`);
  }

  // 0092... — the international prefix written out.
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
    return toE164(digits, input);
  }

  if (hadPlus) {
    return toE164(digits, input);
  }

  // A national trunk zero: 0300... is 300... within the country.
  if (digits.startsWith('0')) {
    return toE164(`${defaultCountryCode}${digits.replace(/^0+/, '')}`, input);
  }

  // Already prefixed with its country code, e.g. 923001234567.
  const expected = NSN_LENGTHS[defaultCountryCode];
  if (digits.startsWith(defaultCountryCode) && expected) {
    const remainder = digits.slice(defaultCountryCode.length);
    if (remainder.length >= expected.min && remainder.length <= expected.max) {
      return toE164(digits, input);
    }
  }

  // Bare national number, e.g. 3001234567.
  return toE164(`${defaultCountryCode}${digits}`, input);
}

function toE164(digits: string, original: string): string {
  // Longest matching calling code wins, so 971 is not read as 97 + 1.
  const countryCode = Object.keys(NSN_LENGTHS)
    .sort((a, b) => b.length - a.length)
    .find((code) => digits.startsWith(code));

  if (countryCode) {
    const nsn = digits.slice(countryCode.length);
    const { min, max } = NSN_LENGTHS[countryCode]!;
    if (nsn.length < min || nsn.length > max) {
      throw new ValidationError(
        `"${original}" is not a valid phone number for country code +${countryCode}`,
      );
    }
    return `+${countryCode}${nsn}`;
  }

  // An unlisted country. Accept a plausible length rather than refusing service
  // to a traveller, but still reject obvious nonsense.
  if (digits.length < 8 || digits.length > 15) {
    throw new ValidationError(`"${original}" is not a usable phone number`);
  }
  return `+${digits}`;
}

/** Formats for display, e.g. "+92 300 1234567". Never stored. */
export function formatPhoneForDisplay(e164: string): string {
  const match = /^\+(92)(\d{3})(\d{7})$/.exec(e164);
  return match ? `+${match[1]} ${match[2]} ${match[3]}` : e164;
}
