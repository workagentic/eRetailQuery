// packages/connectors/src/shopify/hmac.ts
// OAuth query hmac (hex): https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
// Webhook X-Shopify-Hmac-Sha256 (base64 over the raw body): https://shopify.dev/docs/apps/build/webhooks/subscribe/https
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isValidShopDomain } from './domain';

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyOAuthQuery(
  query: Record<string, string | string[] | undefined>,
  apiSecret: string,
  opts: { now?: Date; maxAgeSeconds?: number } = {},
): boolean {
  const { hmac, ...rest } = query;
  if (typeof hmac !== 'string' || !/^[0-9a-f]{64}$/i.test(hmac)) return false;
  const pairs: string[] = [];
  for (const key of Object.keys(rest).sort()) {
    const value = rest[key];
    if (typeof value !== 'string') return false; // repeated parameters are never valid
    pairs.push(`${key}=${value}`);
  }
  const expected = createHmac('sha256', apiSecret).update(pairs.join('&')).digest();
  if (!safeEqual(expected, Buffer.from(hmac, 'hex'))) return false;
  const ts = Number(rest.timestamp);
  if (!Number.isSafeInteger(ts)) return false;
  const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  return ts <= nowSec + 60 && nowSec - ts <= (opts.maxAgeSeconds ?? 600);
}

export function verifyWebhookSignature(
  rawBody: Buffer | string,
  hmacHeader: string | undefined,
  apiSecret: string,
): boolean {
  if (!hmacHeader || !/^[A-Za-z0-9+/]+={0,2}$/.test(hmacHeader)) return false;
  const expected = createHmac('sha256', apiSecret).update(rawBody).digest();
  return safeEqual(expected, Buffer.from(hmacHeader, 'base64'));
}

export interface WebhookHeaders {
  topic: string;
  shop: string;
  webhookId: string;
  eventId: string | null;
}

export function parseWebhookHeaders(
  headers: Record<string, string | string[] | undefined>,
): WebhookHeaders | null {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const value = Array.isArray(v) ? v[0] : v;
    if (typeof value === 'string') lower[k.toLowerCase()] = value;
  }
  const topic = lower['x-shopify-topic'];
  const shop = lower['x-shopify-shop-domain'];
  const webhookId = lower['x-shopify-webhook-id'];
  if (!topic || !webhookId || !shop || !isValidShopDomain(shop)) return null;
  return { topic, shop, webhookId, eventId: lower['x-shopify-event-id'] || null };
}
