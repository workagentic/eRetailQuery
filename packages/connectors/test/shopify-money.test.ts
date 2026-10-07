import { describe, expect, it } from 'vitest';
import { minorUnitExponent, parseMoneyToMinorUnits, PermanentError } from '../src';

describe('minorUnitExponent', () => {
  it.each([
    ['USD', 2],
    ['EUR', 2],
    ['JPY', 0],
    ['KRW', 0],
    ['vnd', 0],
    ['KWD', 3],
    ['BHD', 3],
    ['usd', 2],
  ] as const)('%s has %i decimals', (code, exp) => expect(minorUnitExponent(code)).toBe(exp));
  it('rejects codes that are not three letters', () => {
    for (const bad of ['', 'US', 'USDD', '12A', 'U$D'])
      expect(() => minorUnitExponent(bad)).toThrow(PermanentError);
  });
});

describe('parseMoneyToMinorUnits', () => {
  it.each([
    ['10.99', 'USD', 1099],
    ['10', 'USD', 1000],
    ['0.5', 'USD', 50],
    ['0.05', 'USD', 5],
    ['0', 'USD', 0],
    ['0.00', 'USD', 0],
    ['1234', 'JPY', 1234],
    ['1234.5', 'JPY', 1235],
    ['1234.4', 'JPY', 1234],
    ['1.234', 'KWD', 1234],
    ['1.2', 'KWD', 1200],
    ['0.005', 'USD', 1],
    ['0.004', 'USD', 0],
    ['0.015', 'USD', 2],
    ['19.999', 'USD', 2000],
    ['-2.50', 'USD', -250],
    ['-0.005', 'USD', -1],
    ['-0', 'USD', 0],
    ['-0.00', 'USD', 0],
    ['-0.004', 'USD', 0],
    ['0.014999', 'USD', 1],
    ['0.0049999', 'USD', 0],
    ['-1500', 'JPY', -1500],
    ['-1500.5', 'JPY', -1501],
    ['-1.2345', 'KWD', -1235],
    ['-0.0004', 'KWD', 0],
    ['999999999999999', 'JPY', 999999999999999],
    ['  7.10  ', 'USD', 710],
    ['90071992547409.91', 'USD', 9007199254740991],
  ] as const)('%s %s -> %i', (amount, currency, cents) => {
    expect(parseMoneyToMinorUnits(amount, currency)).toBe(cents);
    expect(Object.is(parseMoneyToMinorUnits(amount, currency), -0)).toBe(false);
  });
  it.each([
    '',
    ' ',
    'abc',
    '1,000.00',
    '1e3',
    '1.',
    '.5',
    '--1',
    '+1',
    '1 0',
    '1.2.3',
    '1234567890123456',
    '90071992547409.92',
    '99999999999999.99',
  ])('rejects %j with a fixed message that does not echo the input', (bad) => {
    let message = '';
    try {
      parseMoneyToMinorUnits(bad, 'USD');
    } catch (e) {
      expect(e).toBeInstanceOf(PermanentError);
      message = (e as Error).message;
    }
    expect(message).toBe('Shopify returned an unreadable amount.');
  });
});
