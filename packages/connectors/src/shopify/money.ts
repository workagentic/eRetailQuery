// ISO 4217 minor-unit exponents: https://www.iso.org/iso-4217-currency-codes.html
// Shopify money fields are decimal strings: https://shopify.dev/docs/api/admin-graphql/latest/scalars/Money
import { PermanentError } from '../errors';

const ZERO = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'ISK',
  'JPY',
  'KMF',
  'KRW',
  'PYG',
  'RWF',
  'UGX',
  'UYI',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);
// Four-decimal units of account (CLF, UYW) are deliberately absent: they are not shop currencies,
// and one would be treated as 2 decimals here.
const THREE = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
const UNREADABLE = 'Shopify returned an unreadable amount.';

export function minorUnitExponent(currency: string): number {
  const code = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code))
    throw new PermanentError('Shopify returned an unreadable currency.');
  if (ZERO.has(code)) return 0;
  if (THREE.has(code)) return 3;
  return 2;
}

/**
 * Exact decimal-string to minor-unit conversion. Never uses floating point. Digits beyond the
 * currency's minor unit are rounded (half away from zero, on the first dropped digit only), never
 * rejected; a result that rounds to zero is 0, never -0.
 */
export function parseMoneyToMinorUnits(amount: string, currency: string): number {
  const match = /^(-?)(\d{1,15})(?:\.(\d+))?$/.exec(amount.trim());
  if (!match) throw new PermanentError(UNREADABLE);
  const exponent = minorUnitExponent(currency);
  const negative = match[1] === '-';
  const whole = match[2]!;
  const fraction = (match[3] ?? '').padEnd(exponent, '0');
  let units = BigInt(whole + fraction.slice(0, exponent));
  // Round half away from zero on the first dropped digit.
  if (fraction.length > exponent && fraction.charCodeAt(exponent) >= 53 /* '5' */) units += 1n;
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new PermanentError(UNREADABLE);
  const value = Number(units);
  return negative && value !== 0 ? -value : value;
}
