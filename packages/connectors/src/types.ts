// Interfaces from CLAUDE.md section 6. Normalized shapes are minimal on purpose;
// Phase 1b/1c specs extend them. No platform-specific fields may leak out of this package.
export interface Connection {
  id: string;
  externalAccountId: string;
}
export interface SyncResult {
  recordsProcessed: number;
  cursor: string | null;
}
export interface NormalizedOrder {
  externalId: string;
  placedAt: Date;
  currency: string;
  grossCents: number;
}
export interface NormalizedProduct {
  externalId: string;
  title: string;
}
export interface NormalizedInventory {
  externalVariantId: string;
  locationExternalId: string;
  available: number;
}

export interface StoreConnector {
  connect(oauthParams: Record<string, string>): Promise<Connection>;
  backfill(
    connection: Connection,
    since: Date,
  ): AsyncIterable<NormalizedOrder | NormalizedProduct | NormalizedInventory>;
  syncIncremental(connection: Connection, cursor: string | null): Promise<SyncResult>;
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
