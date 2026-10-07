import { z } from 'zod';

/** Review against https://shopify.dev/docs/api/usage/versioning when upgrading. */
export const SHOPIFY_API_VERSION = '2025-07';
/** Read-only scopes the sync needs. Protected customer data is deliberately not requested. */
export const DEFAULT_SHOPIFY_SCOPES = [
  'read_products',
  'read_inventory',
  'read_locations',
  'read_orders',
  // Lifts the default 60-day order window to full history; Shopify may need to approve it, so ordersBackfillSince degrades to 60 days when it is not granted.
  'read_all_orders',
];

export const shopifyConfigSchema = z.object({
  apiKey: z.string().min(1),
  apiSecret: z.string().min(1),
  scopes: z.array(z.string().regex(/^[a-z_]+$/)).min(1),
  redirectUri: z.string().url(),
  webhookUrl: z.string().url(),
  apiVersion: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .default(SHOPIFY_API_VERSION),
});
export type ShopifyConfig = z.infer<typeof shopifyConfigSchema>;
