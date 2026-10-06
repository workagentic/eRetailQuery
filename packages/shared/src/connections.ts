import { z } from 'zod';

export const installShopifyInput = z.object({ shop: z.string().trim().min(3).max(255) });
export type InstallShopifyInput = z.infer<typeof installShopifyInput>;

export interface ConnectionDto {
  id: string;
  platform: 'shopify' | 'woocommerce' | 'amazon';
  shop: string;
  status: 'pending' | 'active' | 'error' | 'disconnected' | 'demo';
  lastSyncedAt: string | null;
  lastError: string | null;
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
] as const;
export type ShopifyErrorCode = (typeof SHOPIFY_ERROR_CODES)[number];
