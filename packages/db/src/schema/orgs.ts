import { char, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps } from './timestamps';

export const orgs = pgTable('orgs', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  reportingCurrency: char('reporting_currency', { length: 3 }).notNull().default('USD'),
  timezone: text('timezone').notNull().default('America/New_York'),
  ...timestamps,
});
