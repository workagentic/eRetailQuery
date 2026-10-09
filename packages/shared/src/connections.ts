import { z } from 'zod';

export const installShopifyInput = z.object({ shop: z.string().trim().min(3).max(255) });
export type InstallShopifyInput = z.infer<typeof installShopifyInput>;

export type ConnectionResourceName = 'locations' | 'products' | 'inventory' | 'orders';
export interface ConnectionResourceDto {
  resource: ConnectionResourceName;
  /** never: not imported yet; running: importing now; failed: the last attempt failed; idle: imported before. */
  state: 'never' | 'running' | 'failed' | 'idle';
  /** When this resource last finished importing (ISO), or null. A failed resource keeps its last good time. */
  lastCompletedAt: string | null;
  /** Stored, already sanitized failure text, else null. */
  error: string | null;
}

export interface ConnectionSyncDto {
  state: 'never' | 'running' | 'idle' | 'failed';
  /** The resource currently importing or that failed ('locations' | 'products' | 'inventory' | 'orders'), else null. */
  resource: string | null;
  recordsProcessed: number;
  /** Oldest imported order date (ISO), or null when no orders yet. */
  coveredFrom: string | null;
  /** True when read_all_orders was not granted, so older order history is not available. */
  historyLimited: boolean;
  error: string | null;
  /** False when the server cannot start syncs (no queue configured) or the connection is not usable. */
  canStart: boolean;
  /** One entry per resource, in import order (locations, products, inventory, orders). */
  resources: ConnectionResourceDto[];
  /** Order lines whose product is not imported yet, so their cost is not counted. */
  unlinkedLines: number;
}

export interface SyncNowResponse {
  started: boolean;
}

export interface ConnectionDto {
  id: string;
  platform: 'shopify' | 'woocommerce' | 'amazon';
  shop: string;
  status: 'pending' | 'active' | 'error' | 'disconnected' | 'demo';
  lastSyncedAt: string | null;
  lastError: string | null;
  sync: ConnectionSyncDto;
}

export interface InstallResponse {
  authorizeUrl: string;
}

export const SHOPIFY_ERROR_CODES = [
  'invalid_request',
  'state_expired',
  'shop_mismatch',
  'shop_in_use',
  'exchange_failed',
  'not_configured',
  'server_error',
  'wrong_account',
  'not_allowed',
] as const;
export type ShopifyErrorCode = (typeof SHOPIFY_ERROR_CODES)[number];

/** Body of the authenticated callback: the raw, still-encoded query string Shopify sent (no leading `?` needed). */
export const shopifyCallbackInput = z.object({ query: z.string().min(1).max(4096) });
export type ShopifyCallbackInput = z.infer<typeof shopifyCallbackInput>;
export interface ShopifyCallbackResponse {
  redirectTo: string;
}
