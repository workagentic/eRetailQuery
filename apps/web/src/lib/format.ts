import { formatMoney, money } from '@erq/shared';

const DASH = '—';

export function formatCents(cents: number, currency = 'USD'): string {
  return formatMoney(money(Math.round(cents), currency));
}

/** Basis points as a percentage with one decimal; an em dash when unknown. */
export function formatBps(bps: number | null): string {
  return bps === null ? DASH : `${(bps / 100).toFixed(1)}%`;
}

export function formatRoas(roas: number | null): string {
  return roas === null ? 'No ad spend' : `${roas.toFixed(1)}x`;
}

export interface Change {
  text: string;
  direction: 'up' | 'down' | 'flat';
}

/** Change versus the previous period, measured against the size of the previous value. */
export function formatChange(current: number, previous: number): Change {
  if (previous === 0) return { text: DASH, direction: 'flat' };
  const pct = Math.round(((current - previous) / Math.abs(previous)) * 100);
  if (pct === 0) return { text: '0%', direction: 'flat' };
  return { text: `${pct > 0 ? '+' : ''}${pct}%`, direction: pct > 0 ? 'up' : 'down' };
}
