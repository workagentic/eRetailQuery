export interface Money {
  readonly cents: number;
  readonly currency: string;
}

const CURRENCY_RE = /^[A-Z]{3}$/;

export function money(cents: number, currency = 'USD'): Money {
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`cents must be a safe integer, got ${cents}`);
  }
  if (!CURRENCY_RE.test(currency)) {
    throw new RangeError(`invalid ISO currency code: ${currency}`);
  }
  return Object.freeze({ cents, currency });
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.cents + b.cents, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.cents - b.cents, a.currency);
}

export function negate(m: Money): Money {
  return money(m.cents === 0 ? 0 : -m.cents, m.currency);
}

export function sum(items: Money[], currency = 'USD'): Money {
  return items.reduce((acc, m) => add(acc, m), money(0, currency));
}

const DECIMAL_RE = /^(-)?(\d{1,15})(?:\.(\d{1,2}))?$/;

/** Parses "12.34" without ever going through a float. */
export function fromDecimalString(input: string, currency = 'USD'): Money {
  const match = DECIMAL_RE.exec(input.trim());
  if (!match) throw new RangeError(`invalid money string: ${JSON.stringify(input)}`);
  const [, negative, whole = '0', fraction = ''] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return money(negative && cents !== 0 ? -cents : cents, currency);
}

/** Multiplies by basis points (1% = 100 bps) in integer math, rounding half away from zero. */
export function applyBasisPoints(m: Money, bps: number): Money {
  if (!Number.isInteger(bps)) throw new RangeError(`bps must be an integer, got ${bps}`);
  const product = BigInt(m.cents) * BigInt(bps);
  const abs = product < 0n ? -product : product;
  let quotient = abs / 10_000n;
  if ((abs % 10_000n) * 2n >= 10_000n) quotient += 1n;
  return money(Number(product < 0n ? -quotient : quotient), m.currency);
}

/** Display only. The cents model assumes 2-decimal currencies. */
export function formatMoney(m: Money, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: m.currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(m.cents / 100);
}
