import { sql } from 'drizzle-orm';
import {
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { storeConnections } from './connections';
import { tenantId } from './tenant';
import { timestamps } from './timestamps';

export const alertSeverity = pgEnum('alert_severity', ['low', 'medium', 'high']);

/** Something the owner should look at. Messages are fixed texts, never raw error text. */
export const alerts = pgTable(
  'alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    type: text('type').notNull(),
    severity: alertSeverity('severity').notNull(),
    storeConnectionId: uuid('store_connection_id'),
    /** What the alert is about, for example `webhook_event:<id>`; one open alert per (type, entity). */
    entityRef: text('entity_ref').notNull(),
    message: text('message').notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique('alerts_org_id_uq').on(t.orgId, t.id),
    foreignKey({
      columns: [t.orgId, t.storeConnectionId],
      foreignColumns: [storeConnections.orgId, storeConnections.id],
    }).onDelete('cascade'),
    uniqueIndex('alerts_open_uq')
      .on(t.orgId, t.type, t.entityRef)
      .where(sql`${t.resolvedAt} is null`),
    index('alerts_org_open_idx')
      .on(t.orgId, t.storeConnectionId)
      .where(sql`${t.resolvedAt} is null`),
  ],
);
