import { sql } from 'drizzle-orm';
import { blendedRoas } from '@erq/metrics';
import type { Money } from '@erq/shared';
import type { Tx } from '../tenant-db';
import {
  REPORT_CURRENCY,
  adPlatformChannel,
  buildPeriodPnl,
  loadAdAgg,
  loadOrderAgg,
  loadOrgTimezone,
} from './aggregate';
import { addDays, daysBetween } from './range';
import type { ChannelFilter, Compared, ReportRange, SalesChannelName } from './types';

export interface Overview {
  currency: string;
  /** Last day with orders (org timezone), or the end of the range when there are none. */
  asOf: string;
  kpis: {
    revenue: Compared<Money>;
    orders: Compared<number>;
    adSpend: Compared<Money>;
    /** Net sales over total ad spend (MER); null when there is no ad spend. */
    blendedRoas: Compared<number | null>;
    estimatedProfit: Compared<Money>;
    marginBps: Compared<number | null>;
  };
  /** Where the period's net sales went. The five parts add up to netSalesCents (profit may be negative). */
  breakdown: {
    netSalesCents: number;
    cogsCents: number;
    fulfillmentCents: number;
    /** Payment processing plus marketplace fees. */
    feesCents: number;
    adSpendCents: number;
    profitCents: number;
  };
  /** One entry per day in the range, zero-filled so charts stay continuous. */
  daily: { date: string; revenue: number; profit: number; adSpend: number; orders: number }[];
  byChannel: {
    channel: SalesChannelName;
    revenue: Money;
    profit: Money;
    marginBps: number | null;
  }[];
  costComplete: boolean;
}

/** The newest day that has an order, in the org timezone; null for an org with no orders. */
export async function getDataEndDate(tx: Tx): Promise<string | null> {
  const tz = await loadOrgTimezone(tx);
  const res = await tx.execute(
    sql`select (max(placed_at) at time zone ${tz})::date::text as d from orders where not is_test`,
  );
  return (res.rows[0] as { d: string | null } | undefined)?.d ?? null;
}

export async function getOverview(
  tx: Tx,
  p: { range: ReportRange; previous: ReportRange; channel: ChannelFilter },
): Promise<Overview> {
  const tz = await loadOrgTimezone(tx);
  const load = async (range: ReportRange) => ({
    orders: await loadOrderAgg(tx, { range, channel: p.channel, tz }),
    ads: await loadAdAgg(tx, { range, channel: p.channel }),
  });
  const cur = await load(p.range);
  const prev = await load(p.previous);
  const curPnl = buildPeriodPnl(cur.orders, cur.ads);
  const prevPnl = buildPeriodPnl(prev.orders, prev.ads);

  const roasOf = (x: ReturnType<typeof buildPeriodPnl>) =>
    blendedRoas(x.pnl.netSales, x.pnl.adSpend.total);
  const kpis: Overview['kpis'] = {
    revenue: { value: curPnl.pnl.netSales, previous: prevPnl.pnl.netSales },
    orders: { value: curPnl.orderCount, previous: prevPnl.orderCount },
    adSpend: { value: curPnl.pnl.adSpend.total, previous: prevPnl.pnl.adSpend.total },
    blendedRoas: { value: roasOf(curPnl), previous: roasOf(prevPnl) },
    estimatedProfit: {
      value: curPnl.pnl.netContributionAfterMarketing,
      previous: prevPnl.pnl.netContributionAfterMarketing,
    },
    marginBps: {
      value: curPnl.pnl.marginsBps.netContributionAfterMarketing,
      previous: prevPnl.pnl.marginsBps.netContributionAfterMarketing,
    },
  };

  const days = daysBetween(p.range.from, p.range.to) + 1;
  const daily = Array.from({ length: days }, (_, i) => {
    const date = addDays(p.range.from, i);
    const o = cur.orders.filter((x) => x.date === date);
    const spend = cur.ads.filter((x) => x.date === date).reduce((a, x) => a + x.spend, 0);
    const revenue = o.reduce((a, x) => a + x.gross - x.discount - x.refund, 0);
    const costs = o.reduce(
      (a, x) => a + x.cogs + x.paymentFee + x.marketplaceFee + x.fulfillment,
      0,
    );
    const orders = o.reduce((a, x) => a + x.orders, 0);
    return { date, revenue, profit: revenue - costs - spend, adSpend: spend, orders };
  });

  const channels = [...new Set(cur.orders.map((o) => o.channel))].sort();
  const byChannel = channels.map((channel) => {
    const x = buildPeriodPnl(
      cur.orders.filter((o) => o.channel === channel),
      cur.ads.filter((a) => adPlatformChannel(a.platform) === channel),
    );
    return {
      channel,
      revenue: x.pnl.netSales,
      profit: x.pnl.netContributionAfterMarketing,
      marginBps: x.pnl.marginsBps.netContributionAfterMarketing,
    };
  });

  const asOf = (await getDataEndDate(tx)) ?? p.range.to;
  const pnl = curPnl.pnl;
  const breakdown = {
    netSalesCents: pnl.netSales.cents,
    cogsCents: pnl.cogs.cents,
    fulfillmentCents: pnl.fulfillment.cents,
    feesCents: pnl.paymentFees.cents + pnl.marketplaceFees.cents,
    adSpendCents: pnl.adSpend.total.cents,
    profitCents: pnl.netContributionAfterMarketing.cents,
  };
  return {
    currency: REPORT_CURRENCY,
    asOf,
    kpis,
    breakdown,
    daily,
    byChannel,
    costComplete: curPnl.costComplete,
  };
}
