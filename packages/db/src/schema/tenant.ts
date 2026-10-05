import { uuid } from 'drizzle-orm/pg-core';
import { orgs } from './orgs';

/** The org_id column every tenant table carries. */
export const tenantId = () =>
  uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' });
