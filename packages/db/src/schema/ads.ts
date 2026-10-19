import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { adConnections } from './connections';
import { tenantId } from './tenant';
import { timestamps } from './timestamps';

export const adCampaigns = pgTable(
  'ad_campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    adConnectionId: uuid('ad_connection_id').notNull(),
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull().default('active'),
    objective: text('objective'),
    ...timestamps,
  },
  (t) => [
    unique('ad_campaigns_org_id_uq').on(t.orgId, t.id),
    unique('ad_campaigns_external_uq').on(t.orgId, t.adConnectionId, t.externalId),
    foreignKey({
      columns: [t.orgId, t.adConnectionId],
      foreignColumns: [adConnections.orgId, adConnections.id],
    }).onDelete('cascade'),
  ],
);

/** Campaign-level daily numbers, already bucketed by the ad platform's account day. */
export const adInsightsDaily = pgTable(
  'ad_insights_daily',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: tenantId(),
    campaignId: uuid('campaign_id').notNull(),
    date: date('date', { mode: 'string' }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('USD'),
    spendCents: bigint('spend_cents', { mode: 'number' }).notNull(),
    impressions: integer('impressions').notNull().default(0),
    clicks: integer('clicks').notNull().default(0),
    conversions: integer('conversions').notNull().default(0),
    /** Platform-reported revenue; platforms over-claim, blended ROAS is the honest number. */
    revenueCents: bigint('revenue_cents', { mode: 'number' }).notNull().default(0),
    ...timestamps,
  },
  (t) => [
    unique('ad_insights_daily_uq').on(t.orgId, t.campaignId, t.date),
    foreignKey({
      columns: [t.orgId, t.campaignId],
      foreignColumns: [adCampaigns.orgId, adCampaigns.id],
    }).onDelete('cascade'),
    check(
      'ad_insights_nonneg',
      sql`${t.spendCents} >= 0 and ${t.impressions} >= 0 and ${t.clicks} >= 0 and ${t.conversions} >= 0 and ${t.revenueCents} >= 0`,
    ),
    index('ad_insights_org_date_idx').on(t.orgId, t.date),
  ],
);
