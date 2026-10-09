import type { SyncResource } from '@erq/connectors';

/** How often each resource is polled. Inventory is a full pass every time (the connector ignores updatedSince for it). */
export const SYNC_CADENCE_MS: Record<SyncResource, number> = {
  locations: 15 * 60_000,
  products: 15 * 60_000,
  orders: 15 * 60_000,
  inventory: 60 * 60_000,
};
/** A products pass without the updated_at filter, daily: an edit of only a variant's cost does not bump the product's updated_at. */
export const PRODUCTS_FULL_PASS_MS = 24 * 60 * 60_000;
/** The scheduler starts at most this many connections per tick (oldest due first). */
export const MAX_CONNECTIONS_PER_TICK = 50;
/** The ticker job runs this often. */
export const SYNC_TICK_EVERY_MS = 60_000;
