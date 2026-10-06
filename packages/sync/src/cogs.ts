import { and, eq, gte, inArray } from 'drizzle-orm';
import { orderLines, orders, orgs, skuCostComponents, type Tx } from '@erq/db';
import { isCostInEffect, landedCost, type CostComponent } from '@erq/metrics';

export interface CostRow {
  skuId: string;
  componentType: string;
  amountCents: number;
  perUnit: boolean;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** The calendar date of an instant in the org's timezone (YYYY-MM-DD). */
export function toOrgDate(instant: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);
  } catch {
    throw new RangeError(`unknown timezone: ${timeZone}`);
  }
}

export async function loadCostRows(tx: Tx, skuIds: string[]): Promise<Map<string, CostRow[]>> {
  const result = new Map<string, CostRow[]>();
  if (skuIds.length === 0) return result;
  const rows = await tx
    .select({
      skuId: skuCostComponents.skuId,
      componentType: skuCostComponents.componentType,
      amountCents: skuCostComponents.amountCents,
      perUnit: skuCostComponents.perUnit,
      currency: skuCostComponents.currency,
      effectiveFrom: skuCostComponents.effectiveFrom,
      effectiveTo: skuCostComponents.effectiveTo,
    })
    .from(skuCostComponents)
    .where(inArray(skuCostComponents.skuId, skuIds));
  for (const r of rows) {
    const list = result.get(r.skuId) ?? [];
    list.push({ ...r, currency: r.currency.trim() });
    result.set(r.skuId, list);
  }
  return result;
}

/**
 * Landed cost per unit in effect on `placedOn`, or null when it is unknown: no component in effect,
 * a per-batch component in effect, or a component in another currency. Null is never silently zero.
 */
export function snapshotUnitCogs(
  rows: CostRow[] | undefined,
  placedOn: string,
  currency: string,
): number | null {
  if (!rows) return null;
  const inEffect = rows.filter((r) => isCostInEffect(r, placedOn));
  if (inEffect.length === 0) return null;
  if (inEffect.some((r) => !r.perUnit || r.currency !== currency)) return null;
  const components: CostComponent[] = inEffect.map((r) => ({
    componentType: r.componentType,
    amountCents: r.amountCents,
    currency: r.currency,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
  }));
  return landedCost(components, placedOn, currency).cents;
}

/**
 * Recomputes the cost snapshot of every order line of a SKU (optionally only for orders placed at or after `from`).
 * Call it after costs are added or edited. Returns the number of lines whose snapshot changed.
 */
export async function repriceOrderLines(
  tx: Tx,
  args: { orgId: string; skuId: string; from?: Date },
): Promise<number> {
  const [org] = await tx
    .select({ timezone: orgs.timezone })
    .from(orgs)
    .where(eq(orgs.id, args.orgId));
  if (!org) return 0;
  const rows = (await loadCostRows(tx, [args.skuId])).get(args.skuId);
  const lines = await tx
    .select({
      id: orderLines.id,
      snapshot: orderLines.unitCogsCentsSnapshot,
      placedAt: orders.placedAt,
      currency: orders.currency,
    })
    .from(orderLines)
    .innerJoin(orders, and(eq(orders.orgId, orderLines.orgId), eq(orders.id, orderLines.orderId)))
    .where(
      and(
        eq(orderLines.skuId, args.skuId),
        args.from ? gte(orders.placedAt, args.from) : undefined,
      ),
    );
  let changed = 0;
  for (const line of lines) {
    const next = snapshotUnitCogs(
      rows,
      toOrgDate(line.placedAt, org.timezone),
      line.currency.trim(),
    );
    if (next !== line.snapshot) {
      await tx
        .update(orderLines)
        .set({ unitCogsCentsSnapshot: next })
        .where(eq(orderLines.id, line.id));
      changed++;
    }
  }
  return changed;
}
