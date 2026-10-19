import 'server-only';
import { getDataEndDate, resolveRange, type ReportRange, type TenantDb } from '@erq/db';
import { loadAppContext } from './app-context';
import { getTenantDb } from './db';
import { parseFilters, type Filters, type SearchParams } from './filters';

export interface ReportContext {
  orgId: string;
  orgName: string;
  filters: Filters;
  /** The newest day with orders; reports are anchored here instead of the wall clock. */
  asOf: string;
  range: ReportRange;
  previous: ReportRange;
  db: TenantDb;
}

/** Everything a report page needs before it queries: the active org, the filters and the date ranges. */
export async function loadReportContext(searchParams: SearchParams): Promise<ReportContext> {
  const { active } = await loadAppContext();
  const filters = parseFilters(searchParams);
  const db = getTenantDb();
  const latest = await db.withTenant(active.orgId, (tx) => getDataEndDate(tx));
  const asOf = latest ?? new Date().toISOString().slice(0, 10);
  const { current, previous } = resolveRange(filters.preset, asOf);
  return { orgId: active.orgId, orgName: active.name, filters, asOf, range: current, previous, db };
}
