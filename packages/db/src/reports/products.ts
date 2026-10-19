import { sql } from 'drizzle-orm';
import { landedCost, skuPricing, type CostComponent, type FulfillmentAssumptions } from '@erq/metrics';
import { money } from '@erq/shared';
import type { Tx } from '../tenant-db';
import { REPORT_CURRENCY, loadOrderAgg, loadOrgTimezone } from './aggregate';
import type { ChannelFilter, ReportRange } from './types';

export interface ProductRow {
  skuId: string;
  skuCode: string;
  title: string;
  category: string | null;
  priceCents: number;
  /** Landed cost in effect on asOf; null when the SKU has no cost components. */
  landedCents: number | null;
  markupBps: number | null;
  marginBps: number | null;
  idealLowCents: number | null;
  idealHighCents: number | null;
  pricingStatus: 'underpriced' | 'healthy' | 'premium' | 'no_cost';
  /** The markup looks fine but each sale loses money after fees and shipping. */
  contributionNegative: boolean;
  /** What one unit sold alone earns after cost of goods, fees and fulfillment at the current price; null without a cost. */
  contributionCents: number | null;
  unitsSold: number;
  revenueCents: number;
  /** Revenue minus cost of goods minus allocated fees; null when the SKU has no cost. Refunds are not netted out here. */
  profitCents: number | null;
  message: string;
}

const num = (v: unknown): number => Number(v ?? 0);
const bps = (part: number, whole: number): number =>
  whole <= 0 ? 0 : Math.round((part * 10000) / whole);

/** Per-SKU price health and sales profit for a range. Fee assumptions come from the channel's own orders. */
export async function getProducts(
  tx: Tx,
  p: { range: ReportRange; channel: ChannelFilter; asOf: string },
): Promise<ProductRow[]> {
  const tz = await loadOrgTimezone(tx);

  const skuRows = (
    await tx.execute(sql`
      select s.id, s.sku_code, s.selling_price_cents, pr.title, pr.category
      from skus s join products pr on pr.org_id = s.org_id and pr.id = s.product_id`)
  ).rows as Record<string, unknown>[];

  const costRows = (
    await tx.execute(sql`
      select sku_id, component_type, amount_cents, currency, effective_from::text as effective_from,
             effective_to::text as effective_to, per_unit
      from sku_cost_components`)
  ).rows as Record<string, unknown>[];
  const costsBySku = new Map<string, CostComponent[]>();
  for (const c of costRows) {
    const list = costsBySku.get(String(c.sku_id)) ?? [];
    list.push({
      componentType: String(c.component_type),
      amountCents: num(c.amount_cents),
      currency: String(c.currency),
      effectiveFrom: String(c.effective_from),
      effectiveTo: c.effective_to === null ? null : String(c.effective_to),
      perUnit: Boolean(c.per_unit),
    });
    costsBySku.set(String(c.sku_id), list);
  }

  const channelClause = p.channel === 'all' ? sql`true` : sql`o.channel = ${p.channel}::sales_channel`;
  const salesRows = (
    await tx.execute(sql`
      select l.sku_id,
             sum(l.quantity) as units,
             sum(l.unit_price_cents * l.quantity - l.discount_cents) as revenue,
             sum(coalesce(l.unit_cogs_cents_snapshot, 0) * l.quantity) as cogs,
             sum((o.payment_fee_cents + o.marketplace_fee_cents + o.fulfillment_cost_cents)::numeric
                 * (l.unit_price_cents * l.quantity) / nullif(o.gross_cents, 0)) as fees
      from order_lines l
      join orders o on o.org_id = l.org_id and o.id = l.order_id
      where l.sku_id is not null and o.status <> 'cancelled' and not o.is_test
        and (o.placed_at at time zone ${tz})::date between ${p.range.from}::date and ${p.range.to}::date
        and ${channelClause}
      group by l.sku_id`)
  ).rows as Record<string, unknown>[];
  const salesBySku = new Map(salesRows.map((r) => [String(r.sku_id), r]));

  // Fee assumptions from the channel's own orders: percent of price plus a fixed amount per unit.
  const agg = await loadOrderAgg(tx, { range: p.range, channel: p.channel, tz });
  const t = agg.reduce(
    (a, o) => ({
      base: a.base + o.gross - o.discount,
      payment: a.payment + o.paymentFee,
      marketplace: a.marketplace + o.marketplaceFee,
      fulfillment: a.fulfillment + o.fulfillment,
      units: a.units + o.units,
    }),
    { base: 0, payment: 0, marketplace: 0, fulfillment: 0, units: 0 },
  );
  const fulfillment: FulfillmentAssumptions = {
    fixed: {
      outboundShipping: money(t.units > 0 ? Math.round(t.fulfillment / t.units) : 0, REPORT_CURRENCY),
    },
    percentOfPrice: {
      paymentFee: bps(t.payment, t.base),
      marketplaceFee: bps(t.marketplace, t.base),
    },
  };

  const rows = skuRows.map((s): ProductRow => {
    const skuId = String(s.id);
    const price = money(num(s.selling_price_cents), REPORT_CURRENCY);
    const components = costsBySku.get(skuId) ?? [];
    const landed = landedCost(components, p.asOf, REPORT_CURRENCY);
    const hasCost = landed.cents > 0;
    const pricing = skuPricing({ price, landed, fulfillment });
    const sale = salesBySku.get(skuId);
    const revenue = num(sale?.revenue);
    const profit = hasCost ? Math.round(revenue - num(sale?.cogs) - num(sale?.fees)) : null;
    const code = pricing.status.code === 'unknown' ? 'no_cost' : pricing.status.code;
    return {
      skuId,
      skuCode: String(s.sku_code),
      title: String(s.title),
      category: s.category === null ? null : String(s.category),
      priceCents: price.cents,
      landedCents: hasCost ? landed.cents : null,
      markupBps: hasCost ? pricing.markup : null,
      marginBps: hasCost ? pricing.margin : null,
      idealLowCents: pricing.idealRange?.low.cents ?? null,
      idealHighCents: pricing.idealRange?.high.cents ?? null,
      pricingStatus: code,
      contributionNegative: hasCost && pricing.contribution.cents < 0,
      contributionCents: hasCost ? pricing.contribution.cents : null,
      unitsSold: num(sale?.units),
      revenueCents: revenue,
      profitCents: profit,
      message: pricing.warning?.explanation ?? pricing.status.explanation,
    };
  });

  return rows.sort((a, b) => {
    if (a.profitCents === null && b.profitCents === null) return a.skuCode.localeCompare(b.skuCode);
    if (a.profitCents === null) return 1;
    if (b.profitCents === null) return -1;
    return b.profitCents - a.profitCents;
  });
}
