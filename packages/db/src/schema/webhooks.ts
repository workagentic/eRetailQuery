import {
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { storeConnections, storePlatform } from './connections';
import { tenantId } from './tenant';
import { timestamps } from './timestamps';

export const webhookEventStatus = pgEnum('webhook_event_status', [
  'received',
  'processing',
  'processed',
  'failed',
  'ignored',
  'deferred',
]);

/** One-time OAuth state. Only the SHA-256 of the nonce is stored; the nonce itself exists only in the redirect. */
export const oauthStates = pgTable(
  'oauth_states',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    userId: uuid('user_id').notNull(),
    platform: storePlatform('platform').notNull(),
    shop: text('shop').notNull(),
    nonceHash: text('nonce_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('oauth_states_nonce_uq').on(t.nonceHash),
    index('oauth_states_org_expires_idx').on(t.orgId, t.expiresAt),
  ],
);

/** A received webhook delivery. Payloads are tenant data: never log them. */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    storeConnectionId: uuid('store_connection_id').notNull(),
    topic: text('topic').notNull(),
    externalEventId: text('external_event_id').notNull(),
    payload: jsonb('payload').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    status: webhookEventStatus('status').notNull().default('received'),
    error: text('error'),
    ...timestamps,
  },
  (t) => [
    unique('webhook_events_org_id_uq').on(t.orgId, t.id),
    foreignKey({
      columns: [t.orgId, t.storeConnectionId],
      foreignColumns: [storeConnections.orgId, storeConnections.id],
    }).onDelete('cascade'),
    uniqueIndex('webhook_events_dedupe_uq').on(t.orgId, t.storeConnectionId, t.externalEventId),
    index('webhook_events_status_received_idx').on(t.status, t.receivedAt),
  ],
);
