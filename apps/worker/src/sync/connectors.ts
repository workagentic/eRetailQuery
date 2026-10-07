import { ConnectorRegistry, createFetchHttpClient, createShopifyConnector } from '@erq/connectors';
import type { HttpClient } from '@erq/connectors';

/** The connectors the sync worker can run. `http` is injectable so tests never touch the network. */
export function createWorkerConnectors(
  env: NodeJS.ProcessEnv,
  http: HttpClient = createFetchHttpClient(),
): ConnectorRegistry {
  return new ConnectorRegistry().register(
    'shopify',
    createShopifyConnector({ http, apiVersion: env.SHOPIFY_API_VERSION || undefined }),
  );
}
