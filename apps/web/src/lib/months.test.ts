import { describe, expect, it } from 'vitest';
import { recentMonths, shiftMonth } from './months';

describe('shiftMonth', () => {
  it('moves across year boundaries in both directions', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-03', -12)).toBe('2025-03');
  });
});

describe('recentMonths', () => {
  it('lists n months ending at the given month, newest first', () => {
    expect(recentMonths('2026-02', 4)).toEqual(['2026-02', '2026-01', '2025-12', '2025-11']);
  });
});
