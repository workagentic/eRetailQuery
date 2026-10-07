import { describe, expect, it } from 'vitest';
import { ORDERS_HISTORY_DAYS, ordersBackfillSince } from '../src';

const NOW = new Date('2026-10-09T12:00:00Z');
describe('ordersBackfillSince', () => {
  it('goes back 365 days when read_all_orders was granted', () => {
    expect(ordersBackfillSince(['read_orders', 'read_all_orders'], NOW)).toEqual(
      new Date('2025-10-09T12:00:00Z'),
    );
    expect(ORDERS_HISTORY_DAYS).toEqual({ full: 365, limited: 60 });
  });
  it('falls back to 60 days otherwise', () => {
    expect(ordersBackfillSince(['read_orders'], NOW)).toEqual(new Date('2026-08-10T12:00:00Z'));
    expect(ordersBackfillSince([], NOW)).toEqual(new Date('2026-08-10T12:00:00Z'));
  });
  it('matches the scope exactly (no substring or case tricks)', () => {
    for (const scopes of [
      ['read_all_orders_extra'],
      ['READ_ALL_ORDERS'],
      ['all_orders'],
      ['read_orders,read_all_orders'],
    ]) {
      expect(ordersBackfillSince(scopes, NOW)).toEqual(new Date('2026-08-10T12:00:00Z'));
    }
  });
});
