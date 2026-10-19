import { describe, expect, it } from 'vitest';
import { formatBps, formatCents, formatChange, formatRoas } from './format';

describe('formatCents', () => {
  it('formats positive, negative and zero amounts', () => {
    expect(formatCents(123456)).toBe('$1,234.56');
    expect(formatCents(-1234)).toBe('-$12.34');
    expect(formatCents(0)).toBe('$0.00');
  });
});

describe('formatBps', () => {
  it('shows one decimal and an em dash for unknown', () => {
    expect(formatBps(3333)).toBe('33.3%');
    expect(formatBps(-250)).toBe('-2.5%');
    expect(formatBps(null)).toBe('—');
  });
});

describe('formatRoas', () => {
  it('shows a multiple, or says there is no ad spend', () => {
    expect(formatRoas(4.567)).toBe('4.6x');
    expect(formatRoas(null)).toBe('No ad spend');
  });
});

describe('formatChange', () => {
  it('compares with the previous period', () => {
    expect(formatChange(112, 100)).toEqual({ text: '+12%', direction: 'up' });
    expect(formatChange(80, 100)).toEqual({ text: '-20%', direction: 'down' });
    expect(formatChange(100, 100)).toEqual({ text: '0%', direction: 'flat' });
  });
  it('has no percentage when the previous value is zero', () => {
    expect(formatChange(50, 0)).toEqual({ text: '—', direction: 'flat' });
  });
  it('measures against the size of a negative previous value', () => {
    expect(formatChange(-50, -100)).toEqual({ text: '+50%', direction: 'up' });
  });
});
