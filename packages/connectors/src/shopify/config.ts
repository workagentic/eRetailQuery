import { z } from 'zod';

/** Review against https://shopify.dev/docs/api/usage/versioning when upgrading. */
export const SHOPIFY_API_VERSION = '2025-07';
/** Read-only scopes 1b-3 needs. Protected customer data is deliberately not requested. */
export const DEFAULT_SHOPIFY_SCOPES = [
  'read_products',
  'read_inventory',
  'read_locations',
  'read_orders',
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
