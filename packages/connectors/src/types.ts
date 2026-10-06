// Interfaces from CLAUDE.md section 6, with the store connector reshaped into a page-based contract.
// No platform-specific fields may leak out of this package.
import type {
  NormalizedInventoryLevel,
  NormalizedLocation,
  NormalizedOrder,
  NormalizedProduct,
  SyncResource,
} from './normalized';

export interface Connection {
  id: string;
  externalAccountId: string;
}
export interface SyncResult {
  recordsProcessed: number;
  cursor: string | null;
}

export interface ResourceItems {
  locations: NormalizedLocation;
  products: NormalizedProduct;
  inventory: NormalizedInventoryLevel;
  orders: NormalizedOrder;
}
export interface Page<T> {
  items: T[];
  /** Null when this was the last page. */
  nextCursor: string | null;
  /** Rate-limit cost the call consumed, when the platform reports one. */
  cost?: number;
}
export interface FetchOptions {
  /** Backfill: only data from this date on. */
  since?: Date;
  /** Incremental: only data changed since this date. */
  updatedSince?: Date;
}
export interface ConnectionContext {
  connectionId: string;
  externalAccountId: string;
  /** Decrypted credentials. Never log this. Null for connections without credentials. */
  credentials: unknown;
}
export interface StoreConnector {
  connect(oauthParams: Record<string, string>): Promise<Connection>;
  fetchPage<R extends SyncResource>(
    ctx: ConnectionContext,
    resource: R,
    cursor: string | null,
    options: FetchOptions,
  ): Promise<Page<ResourceItems[R]>>;
  handleWebhook(payload: unknown, headers: Record<string, string>): Promise<void>;
  pushPrice?(sku: string, priceCents: number): Promise<void>; // phase 4
  pushInventory?(sku: string, location: string, qty: number): Promise<void>; // phase 4
}

export type InsightLevel = 'campaign' | 'adset' | 'ad';
export interface DateRange {
  from: Date;
  to: Date;
}
export interface AdConnector {
  connect(oauthParams: Record<string, string>): Promise<Connection>;
  syncInsights(
    connection: Connection,
    dateRange: DateRange,
    level: InsightLevel,
  ): Promise<SyncResult>;
}
