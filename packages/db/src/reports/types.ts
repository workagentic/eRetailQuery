export interface ReportRange {
  /** Inclusive YYYY-MM-DD in the org timezone. */
  from: string;
  to: string;
}
export type SalesChannelName = 'shopify_online' | 'shopify_pos' | 'amazon';
/** 'all' means every channel; 'shopify_online' includes only online Shopify orders. */
export type ChannelFilter = 'all' | 'shopify_online' | 'amazon';
export type RangePreset = '7d' | '30d' | '90d' | 'mtd';
export interface Compared<T> {
  value: T;
  previous: T;
}
