import { sql } from 'drizzle-orm';
import { money, type Money } from '@erq/shared';
import { buildPnl, type Pnl } from '@erq/metrics';
import type { Tx } from '../tenant-db';
import type { ChannelFilter, ReportRange, SalesChannelName } from './types';

/** One currency per org in Phase 1 (docs/sync.md); every report is in USD until FX exists. */
export const REPORT_CURRENCY = 'USD';

export interface OrderAgg {
  date: string;
  channel: SalesChannelName;
  orders: number;
  gross: number;
  discount: number;
  refund: number;
  paymentFee: number;
  marketplaceFee: number;
  fulfillment: number;
  cogs: number;
  /** Order lines with no cost snapshot; their cost is not in `cogs`. */
  missingCogsLines: number;
}
export interface AdAgg {
  date: string;
  platform: string;
  spend: number;
  revenue: number;
}

/** Ad spend is attributed to the channel it sells on: Amazon Ads to amazon, everything else to Shopify online. */
export const adPlatformChannel = (platform: string): SalesChannelName =>
  platform === 'amazon_ads' ? 'amazon' : 'shopify_online';

const num = (v: unknown): number => Number(v ?? 0);

export async function loadOrgTimezone(tx: Tx): Promise<string> {
  const res = await tx.execute(
    sql`select timezone from orgs where id = current_setting('app.org_id')::uuid`,
  );
  return String((res.rows[0] as { timezone?: string } | undefined)?.timezone ?? 'UTC');
}

export const channelMatches = (filter: ChannelFilter, channel: SalesChannelName): boolean =>
  filter === 'all' || (filter === 'shopify_online' ? channel === 'shopify_online' : channel === 'amazon');

/** Non-cancelled, non-test orders bucketed by org-timezone day and channel. */
export async function loadOrderAgg(
  tx: Tx,
  p: { range: ReportRange; channel: ChannelFilter; tz: string },
): Promise<OrderAgg[]> {
  const { range, tz } = p;
  const res = await tx.execute(sql`
    with o as (
      select id, channel, (placed_at at time zone ${tz})::date as d, gross_cents, discount_cents, refund_cents,
             payment_fee_cents, marketplace_fee_cents, fulfillment_cost_cents
      from orders
      where status <> 'cancelled' and not is_test
        and placed_at >= ${range.from}::date - interval '2 days'
        and placed_at < ${range.to}::date + interval '3 days'
    ), od as (
      select * from o where d between ${range.from}::date and ${range.to}::date
    ), lines as (
      select l.order_id,
             coalesce(sum(l.unit_cogs_cents_snapshot * l.quantity), 0) as cogs,
             count(*) filter (where l.unit_cogs_cents_snapshot is null) as missing
      from order_lines l where l.order_id in (select id from od) group by l.order_id
    )
    select od.d::text as date, od.channel::text as channel, count(*) as orders,
           sum(od.gross_cents) as gross, sum(od.discount_cents) as discount, sum(od.refund_cents) as refund,
           sum(od.payment_fee_cents) as payment_fee, sum(od.marketplace_fee_cents) as marketplace_fee,
           sum(od.fulfillment_cost_cents) as fulfillment,
           coalesce(sum(lines.cogs), 0) as cogs, coalesce(sum(lines.missing), 0) as missing
    from od left join lines on lines.order_id = od.id
    group by 1, 2 order by 1, 2`);
  return (res.rows as Record<string, unknown>[])
    .map((r) => ({
      date: String(r.date),
      channel: String(r.channel) as SalesChannelName,
      orders: num(r.orders),
      gross: num(r.gross),
      discount: num(r.discount),
      refund: num(r.refund),
      paymentFee: num(r.payment_fee),
      marketplaceFee: num(r.marketplace_fee),
      fulfillment: num(r.fulfillment),
      cogs: num(r.cogs),
      missingCogsLines: num(r.missing),
    }))
    .filter((r) => channelMatches(p.channel, r.channel));
}

/** Campaign insights summed by day and platform. */
export async function loadAdAgg(
  tx: Tx,
  p: { range: ReportRange; channel: ChannelFilter },
): Promise<AdAgg[]> {
  const res = await tx.execute(sql`
    select i.date::text as date, c.platform::text as platform,
           sum(i.spend_cents) as spend, sum(i.revenue_cents) as revenue
    from ad_insights_daily i
    join ad_campaigns k on k.org_id = i.org_id and k.id = i.campaign_id
    join ad_connections c on c.org_id = k.org_id and c.id = k.ad_connection_id
    where i.date between ${p.range.from}::date and ${p.range.to}::date
    group by 1, 2 order by 1, 2`);
  return (res.rows as Record<string, unknown>[])
    .map((r) => ({
      date: String(r.date),
      platform: String(r.platform),
      spend: num(r.spend),
      revenue: num(r.revenue),
    }))
    .filter((r) => channelMatches(p.channel, adPlatformChannel(r.platform)));
}

const sum = <T>(rows: T[], f: (r: T) => number): number => rows.reduce((a, r) => a + f(r), 0);

/** Fulfillment cost (pick, pack and outbound shipping, or the FBA fee) is reported on the shipping line. */
export function buildPeriodPnl(
  orders: OrderAgg[],
  ads: AdAgg[],
): { pnl: Pnl; orderCount: number; costComplete: boolean } {
  const c = REPORT_CURRENCY;
  const byPlatform: Record<string, Money> = {};
  for (const a of ads) {
    byPlatform[a.platform] = money((byPlatform[a.platform]?.cents ?? 0) + a.spend, c);
  }
  const pnl = buildPnl({
    currency: c,
    grossSales: money(sum(orders, (o) => o.gross), c),
    discounts: money(sum(orders, (o) => o.discount), c),
    refunds: money(sum(orders, (o) => o.refund), c),
    cogs: money(sum(orders, (o) => o.cogs), c),
    shipping: money(sum(orders, (o) => o.fulfillment), c),
    pickPack: money(0, c),
    paymentFees: money(sum(orders, (o) => o.paymentFee), c),
    marketplaceFees: money(sum(orders, (o) => o.marketplaceFee), c),
    adSpendByPlatform: byPlatform,
    otherOpex: money(0, c),
  });
  return {
    pnl,
    orderCount: sum(orders, (o) => o.orders),
    costComplete: orders.every((o) => o.missingCogsLines === 0),
  };
}
