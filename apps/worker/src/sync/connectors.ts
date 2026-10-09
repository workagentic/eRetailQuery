import { ConnectorRegistry, createFetchHttpClient, createShopifyConnector } from '@erq/connectors';
import type { HttpClient } from '@erq/connectors';

/**
 * SHOPIFY_API_VERSION: empty or unset means the built-in default; anything else must be YYYY-MM.
 * An invalid value stops the worker at startup instead of failing every sync; the message never
 * echoes the value (a mis-pasted secret must not reach the logs).
 */
export function shopifyApiVersion(env: NodeJS.ProcessEnv): string | undefined {
  const raw = (env.SHOPIFY_API_VERSION ?? '').trim();
  if (raw === '') return undefined;
  if (!/^\d{4}-\d{2}$/.test(raw)) {
    throw new Error('SHOPIFY_API_VERSION must look like 2025-07 (YYYY-MM) or be empty.');
  }
  return raw;
}

/** The connectors the sync worker can run. `http` is injectable so tests never touch the network. */
export function createWorkerConnectors(
  env: NodeJS.ProcessEnv,
  http: HttpClient = createFetchHttpClient(),
): ConnectorRegistry {
  return new ConnectorRegistry().register(
    'shopify',
    createShopifyConnector({ http, apiVersion: shopifyApiVersion(env) }),
  );
}
