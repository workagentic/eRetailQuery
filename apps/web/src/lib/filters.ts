import type { ChannelFilter, RangePreset } from '@erq/db';

export type SearchParams = Record<string, string | string[] | undefined>;
export interface Filters {
  preset: RangePreset;
  channel: ChannelFilter;
}

const PRESETS: readonly RangePreset[] = ['7d', '30d', '90d', 'mtd'];
const CHANNELS: readonly ChannelFilter[] = ['all', 'shopify_online', 'amazon'];
const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** Reads ?range= and ?channel= from the URL. Anything unexpected falls back to the defaults. */
export function parseFilters(params: SearchParams): Filters {
  const range = first(params.range);
  const channel = first(params.channel);
  return {
    preset: PRESETS.find((p) => p === range) ?? '30d',
    channel: CHANNELS.find((c) => c === channel) ?? 'all',
  };
}

/** A YYYY-MM month from ?month=, or null. */
export function parseMonth(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null;
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : null;
}

export const PRESET_LABEL: Record<RangePreset, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  mtd: 'This month',
};
export const CHANNEL_LABEL: Record<ChannelFilter, string> = {
  all: 'All channels',
  shopify_online: 'Shopify',
  amazon: 'Amazon',
};
