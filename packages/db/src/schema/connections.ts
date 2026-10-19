import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenantId } from './tenant';
import { timestamps } from './timestamps';

export const storePlatform = pgEnum('store_platform', ['shopify', 'woocommerce', 'amazon']);
export const adPlatform = pgEnum('ad_platform', ['meta', 'google', 'tiktok', 'amazon_ads']);
export const connectionStatus = pgEnum('connection_status', [
  'pending',
  'active',
  'error',
  'disconnected',
  'demo',
]);
export const connectionKind = pgEnum('connection_kind', ['store', 'ad']);
export const syncStatus = pgEnum('sync_status', ['running', 'succeeded', 'failed']);

export const storeConnections = pgTable(
  'store_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    platform: storePlatform('platform').notNull(),
    externalAccountId: text('external_account_id').notNull(),
    status: connectionStatus('status').notNull().default('pending'),
    encryptedCredentials: text('encrypted_credentials'), // AES-256-GCM via @erq/shared crypto
    scopes: text('scopes').array(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    /** Non-secret mirror of the expiry times inside the encrypted credentials, so SQL can find aging tokens. */
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    lastError: text('last_error'),
    ...timestamps,
  },
  (t) => [
    unique('store_connections_org_platform_acct_uq').on(t.orgId, t.platform, t.externalAccountId),
    unique('store_connections_org_id_uq').on(t.orgId, t.id),
    uniqueIndex('store_connections_active_shop_uq')
      .on(t.platform, t.externalAccountId)
      .where(sql`${t.status} not in ('disconnected', 'demo')`),
  ],
);

export const adConnections = pgTable(
  'ad_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    platform: adPlatform('platform').notNull(),
    externalAccountId: text('external_account_id').notNull(),
    status: connectionStatus('status').notNull().default('pending'),
    encryptedCredentials: text('encrypted_credentials'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),
    ...timestamps,
  },
  (t) => [
    unique('ad_connections_org_platform_acct_uq').on(t.orgId, t.platform, t.externalAccountId),
    unique('ad_connections_org_id_uq').on(t.orgId, t.id),
  ],
);

export const syncRuns = pgTable(
  'sync_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    connectionKind: connectionKind('connection_kind').notNull(),
    connectionId: uuid('connection_id').notNull(), // polymorphic: store_connections or ad_connections
    type: text('type').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    status: syncStatus('status').notNull().default('running'),
    recordsProcessed: integer('records_processed').notNull().default(0),
    error: text('error'),
    ...timestamps,
  },
  (t) => [index('sync_runs_org_created_idx').on(t.orgId, t.createdAt)],
);
