// https://shopify.dev/docs/api/admin-graphql/latest/mutations/webhookSubscriptionCreate
// The privacy topics (customers/data_request, customers/redact, shop/redact) are configured with the app, not per shop.
import { AuthError, TransientError } from '../errors';
import { isValidShopDomain } from './domain';
import type { HttpClient } from './http';

export const SHOPIFY_DATA_WEBHOOK_TOPICS = [
  'app/uninstalled',
  'orders/create',
  'orders/updated',
  'orders/cancelled',
  'refunds/create',
  'products/create',
  'products/update',
  'products/delete',
  'inventory_levels/update',
] as const;

const MUTATION = `mutation Subscribe($topic: WebhookSubscriptionTopic!, $url: URL!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: { callbackUrl: $url, format: JSON }) {
    userErrors { field message }
  }
}`;

/** `orders/create` becomes `ORDERS_CREATE`, `inventory_levels/update` becomes `INVENTORY_LEVELS_UPDATE`. */
export const topicToEnum = (topic: string): string => topic.replace(/\//g, '_').toUpperCase();

export async function registerWebhooks(
  http: HttpClient,
  p: {
    shop: string;
    accessToken: string;
    callbackUrl: string;
    apiVersion: string;
    topics?: readonly string[];
  },
): Promise<{ registered: string[]; failed: string[] }> {
  if (!isValidShopDomain(p.shop)) throw new RangeError('invalid shop domain');
  const registered: string[] = [];
  const failed: string[] = [];
  for (const topic of p.topics ?? SHOPIFY_DATA_WEBHOOK_TOPICS) {
    const res = await http.request({
      method: 'POST',
      url: `https://${p.shop}/admin/api/${p.apiVersion}/graphql.json`,
      headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': p.accessToken },
      body: JSON.stringify({
        query: MUTATION,
        variables: { topic: topicToEnum(topic), url: p.callbackUrl },
      }),
    });
    if (res.status === 401 || res.status === 403)
      throw new AuthError('Shopify rejected the access token');
    if (res.status >= 500) throw new TransientError('Shopify is temporarily unavailable');
    if (res.status !== 200) {
      failed.push(topic);
      continue;
    }
    try {
      const json = JSON.parse(res.body) as {
        errors?: unknown;
        data?: { webhookSubscriptionCreate?: { userErrors?: { message?: string }[] } };
      };
      const result = json.data?.webhookSubscriptionCreate;
      const onlyDuplicates = (result?.userErrors ?? []).every((e) =>
        /already been taken/i.test(e.message ?? ''),
      );
      if (!json.errors && result && onlyDuplicates) registered.push(topic);
      else failed.push(topic);
    } catch {
      failed.push(topic);
    }
  }
  return { registered, failed };
}
