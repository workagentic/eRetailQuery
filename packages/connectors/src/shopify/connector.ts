// packages/connectors/src/shopify/connector.ts
// The Shopify store connector: one fetchPage per resource over the Admin GraphQL API.
// Connections are created by the OAuth install flow, and webhooks are handled by the worker.
import { PermanentError } from '../errors';
import type { SyncResource } from '../normalized';
import type {
  Connection,
  ConnectionContext,
  FetchOptions,
  Page,
  ResourceItems,
  StoreConnector,
} from '../types';
import { createShopifyGraphqlClient, type ShopifyGraphqlClientOptions } from './graphql';
import { fetchInventory } from './inventory';
import { fetchLocations } from './locations';
import { fetchOrders } from './orders';
import { fetchProducts } from './products';

/** `sleep` (tests only) replaces the timer used to wait out a THROTTLED query in place. */
export function createShopifyConnector(opts: ShopifyGraphqlClientOptions): StoreConnector {
  const gql = createShopifyGraphqlClient(opts);
  return {
    async connect(): Promise<Connection> {
      throw new PermanentError('Shopify connections are created through the install flow.');
    },
    async fetchPage<R extends SyncResource>(
      ctx: ConnectionContext,
      resource: R,
      cursor: string | null,
      options: FetchOptions,
    ): Promise<Page<ResourceItems[R]>> {
      const g = { externalAccountId: ctx.externalAccountId, credentials: ctx.credentials };
      // Each branch returns the page of its own resource; the cast only reconciles the generic.
      const page = ((): Promise<Page<ResourceItems[SyncResource]>> => {
        switch (resource) {
          case 'locations':
            return fetchLocations(gql, g, cursor);
          case 'products':
            return fetchProducts(gql, g, cursor, options);
          case 'inventory':
            return fetchInventory(gql, g, cursor, options);
          case 'orders':
            return fetchOrders(gql, g, cursor, options);
          default:
            return Promise.reject(new PermanentError('Unknown Shopify resource.'));
        }
      })();
      return page as Promise<Page<ResourceItems[R]>>;
    },
    async handleWebhook(): Promise<void> {
      // Webhooks are verified and queued by the API and processed by the worker, not here.
    },
  };
}
