import { sql } from 'drizzle-orm';
import { salesVelocity, stockFlags } from '@erq/metrics';
import type { Tx } from '../tenant-db';
import { loadOrgTimezone } from './aggregate';
import { addDays } from './range';

export interface StockRow {
  skuId: string;
  skuCode: string;
  title: string;
  priceCents: number;
  available: number;
  velocityPerDay: number;
  /** Null when nothing sells. */
  daysOfCover: number | null;
  flag: 'low' | 'overstock' | 'dead';
  reason: string;
  action: string;
}

export interface InventoryReport {
  lowStock: StockRow[];
  overstock: StockRow[];
  dead: StockRow[];
  /** Available units per location and what they cost to buy (units times landed cost). */
  byLocation: { location: string; units: number; valueCents: number }[];
}

const num = (v: unknown): number => Number(v ?? 0);
const byCover = (a: StockRow, b: StockRow, dir: 1 | -1): number =>
  a.daysOfCover === null && b.daysOfCover === null
    ? 0
    : a.daysOfCover === null
      ? 1
      : b.daysOfCover === null
        ? -1
        : dir * (a.daysOfCover - b.daysOfCover);

/** Stock health per SKU from stock on hand and the trailing 7, 30 and 90 days of sales ending asOf. */
export async function getInventory(tx: Tx, p: { asOf: string }): Promise<InventoryReport> {
  const tz = await loadOrgTimezone(tx);
  const d7 = addDays(p.asOf, -6);
  const d30 = addDays(p.asOf, -29);
  const d90 = addDays(p.asOf, -89);

  const levelRows = (
    await tx.execute(sql`
      select il.sku_id, loc.name as location, il.on_hand, il.reserved, s.sku_code, s.selling_price_cents, pr.title
      from inventory_levels il
      join locations loc on loc.org_id = il.org_id and loc.id = il.location_id
      join skus s on s.org_id = il.org_id and s.id = il.sku_id
      join products pr on pr.org_id = s.org_id and pr.id = s.product_id`)
  ).rows as Record<string, unknown>[];

  const salesRows = (
    await tx.execute(sql`
      select l.sku_id,
             coalesce(sum(l.quantity) filter (where o.d >= ${d7}::date), 0) as units7,
             coalesce(sum(l.quantity) filter (where o.d >= ${d30}::date), 0) as units30,
             coalesce(sum(l.quantity), 0) as units90
      from order_lines l
      join (select id, (placed_at at time zone ${tz})::date as d from orders
            where status <> 'cancelled' and not is_test) o on o.id = l.order_id
      where l.sku_id is not null and o.d between ${d90}::date and ${p.asOf}::date
      group by l.sku_id`)
  ).rows as Record<string, unknown>[];
  const sales = new Map(salesRows.map((r) => [String(r.sku_id), r]));

  const landedRows = (
    await tx.execute(sql`
      select sku_id, sum(amount_cents) as landed from sku_cost_components
      where per_unit and effective_from <= ${p.asOf}::date and (effective_to is null or ${p.asOf}::date < effective_to)
      group by sku_id`)
  ).rows as Record<string, unknown>[];
  const landed = new Map(landedRows.map((r) => [String(r.sku_id), num(r.landed)]));

  const bySku = new Map<string, { row: Record<string, unknown>; available: number }>();
  const locations = new Map<string, { units: number; valueCents: number }>();
  for (const l of levelRows) {
    const skuId = String(l.sku_id);
    const available = Math.max(0, num(l.on_hand) - num(l.reserved));
    const entry = bySku.get(skuId) ?? { row: l, available: 0 };
    entry.available += available;
    bySku.set(skuId, entry);
    const loc = locations.get(String(l.location)) ?? { units: 0, valueCents: 0 };
    loc.units += available;
    loc.valueCents += available * (landed.get(skuId) ?? 0);
    locations.set(String(l.location), loc);
  }

  const lowStock: StockRow[] = [];
  const overstock: StockRow[] = [];
  const dead: StockRow[] = [];
  for (const [skuId, { row, available }] of bySku) {
    const s = sales.get(skuId);
    const velocity = salesVelocity({
      units7: num(s?.units7),
      units30: num(s?.units30),
      units90: num(s?.units90),
    });
    const flags = stockFlags({ available, velocity, unitsSold90: num(s?.units90) });
    const base = {
      skuId,
      skuCode: String(row.sku_code),
      title: String(row.title),
      priceCents: num(row.selling_price_cents),
      available,
      velocityPerDay: velocity,
      daysOfCover: flags.facts.daysOfCover,
    };
    if (flags.low.fired) {
      lowStock.push({ ...base, flag: 'low', reason: flags.low.explanation, action: 'Reorder now' });
    }
    if (flags.overstock.fired) {
      overstock.push({
        ...base,
        flag: 'overstock',
        reason: flags.overstock.explanation,
        action: 'Run a promotion and hold off reordering',
      });
    }
    if (flags.dead.fired) {
      dead.push({
        ...base,
        flag: 'dead',
        reason: flags.dead.explanation,
        action: 'Discount it or bundle it to clear the stock',
      });
    }
  }

  lowStock.sort((a, b) => byCover(a, b, 1));
  overstock.sort((a, b) => byCover(a, b, -1));
  dead.sort((a, b) => b.available - a.available);
  const byLocation = [...locations.entries()]
    .map(([location, v]) => ({ location, ...v }))
    .sort((a, b) => a.location.localeCompare(b.location));
  return { lowStock, overstock, dead, byLocation };
}
