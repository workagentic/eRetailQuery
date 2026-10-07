// packages/connectors/src/shopify/hmac.ts
// OAuth query hmac (hex): https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
// Webhook X-Shopify-Hmac-Sha256 (base64 over the raw body): https://shopify.dev/docs/apps/build/webhooks/subscribe/https
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isValidShopDomain } from './domain';

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

const MAX_QUERY_LENGTH = 4096;

function hmacEquals(message: string, apiSecret: string, given: Buffer): boolean {
  return safeEqual(createHmac('sha256', apiSecret).update(message).digest(), given);
}

/**
 * Verifies the signature Shopify puts on the OAuth redirect, from the RAW query string.
 * Shopify's docs do not say whether the signed message uses the encoded or the decoded values, so both are
 * accepted (a valid HMAC under the app secret authenticates the same logical parameters either way).
 * After the first real install, drop whichever form Shopify does not use.
 */
export function verifyOAuthRawQuery(
  rawQuery: string,
  apiSecret: string,
  opts: { now?: Date; maxAgeSeconds?: number } = {},
): boolean {
  const query = rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery;
  if (!query || query.length > MAX_QUERY_LENGTH) return false;
  const seen = new Set<string>();
  let hmac: string | undefined;
  const encoded: { key: string; pair: string }[] = [];
  const decoded: { key: string; pair: string }[] = [];
  // The decoded message is only unambiguous when no decoded piece can be re-split into other pairs.
  let decodedAllowed = true;
  let timestamp: string | undefined;
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) return false;
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(pair.slice(0, eq).replace(/\+/g, ' '));
      value = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
    } catch {
      return false;
    }
    if (seen.has(key)) return false;
    seen.add(key);
    if (key.includes('&') || key.includes('=') || value.includes('&')) decodedAllowed = false;
    if (key === 'hmac') {
      hmac = value;
      continue;
    }
    if (key === 'timestamp') timestamp = value;
    encoded.push({ key, pair });
    decoded.push({ key, pair: `${key}=${value}` });
  }
  if (typeof hmac !== 'string' || !/^[0-9a-f]{64}$/i.test(hmac)) return false;
  const bySortedKey = (a: { key: string }, b: { key: string }) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  const given = Buffer.from(hmac, 'hex');
  const matchEncoded = hmacEquals(
    encoded
      .sort(bySortedKey)
      .map((p) => p.pair)
      .join('&'),
    apiSecret,
    given,
  );
  const matchDecoded = hmacEquals(
    decoded
      .sort(bySortedKey)
      .map((p) => p.pair)
      .join('&'),
    apiSecret,
    given,
  );
  // Both comparisons always run. When the decoded form is ambiguous (a decoded `&` or a `=` in a key),
  // `a=1&b=2` and `a=1%26b%3D2` would sign identically, so only the encoded candidate may match.
  if (!(matchEncoded || (matchDecoded && decodedAllowed))) return false;
  const ts = Number(timestamp);
  if (timestamp === undefined || !Number.isSafeInteger(ts)) return false;
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
