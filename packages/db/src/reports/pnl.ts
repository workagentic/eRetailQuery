import { comparePnl, type Pnl, type PnlComparison } from '@erq/metrics';
import { formatMoney, money } from '@erq/shared';
import type { Tx } from '../tenant-db';
import {
  REPORT_CURRENCY,
  adPlatformChannel,
  buildPeriodPnl,
  loadAdAgg,
  loadOrderAgg,
  loadOrgTimezone,
  type AdAgg,
  type OrderAgg,
} from './aggregate';
import type { ChannelFilter, ReportRange, SalesChannelName } from './types';

export interface MonthlyPnl {
  month: string;
  currency: string;
  current: Pnl;
  previous: Pnl;
  /** Null when the same month a year earlier has no orders and no ad spend. */
  sameMonthLastYear: Pnl | null;
  comparison: PnlComparison;
  byChannel: { channel: SalesChannelName; pnl: Pnl }[];
  byAdPlatform: { platform: string; spendCents: number; platformRevenueCents: number }[];
  /** False when some sold units have no cost on record, so profit lines ignore their cost of goods. */
  costComplete: boolean;
  /** Plain-English call-outs such as "Meta spent $20.00 and reports $60.00 in sales". */
  callouts: string[];
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const CHANNEL_LABEL: Record<SalesChannelName, string> = {
  shopify_online: 'Shopify',
  shopify_pos: 'Shopify POS',
  amazon: 'Amazon',
};
const PLATFORM_LABEL: Record<string, string> = {
  meta: 'Meta',
  google: 'Google',
  tiktok: 'TikTok',
  amazon_ads: 'Amazon Ads',
};
const usd = (cents: number): string => formatMoney(money(Math.abs(cents), REPORT_CURRENCY));

function monthRange(month: string): ReportRange {
  const m = MONTH_RE.exec(month);
  if (!m) throw new RangeError(`month must be YYYY-MM, got ${month}`);
  const from = `${month}-01`;
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).toISOString().slice(0, 10);
  return { from, to: last };
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

export async function getMonthlyPnl(
  tx: Tx,
  p: { month: string; channel: ChannelFilter },
): Promise<MonthlyPnl> {
  const range = monthRange(p.month);
  const tz = await loadOrgTimezone(tx);
  const load = async (r: ReportRange) => ({
    orders: await loadOrderAgg(tx, { range: r, channel: p.channel, tz }),
    ads: await loadAdAgg(tx, { range: r, channel: p.channel }),
  });
  const cur = await load(range);
  const prev = await load(monthRange(shiftMonth(p.month, -1)));
  const year = await load(monthRange(shiftMonth(p.month, -12)));

  const current = buildPeriodPnl(cur.orders, cur.ads);
  const previous = buildPeriodPnl(prev.orders, prev.ads);
  const hadYearData = year.orders.length > 0 || year.ads.length > 0;

  const channels = [
    ...new Set<SalesChannelName>([
      ...cur.orders.map((o) => o.channel),
      ...cur.ads.map((a) => adPlatformChannel(a.platform)),
    ]),
  ].sort();
  const byChannel = channels.map((channel) => ({
    channel,
    pnl: buildPeriodPnl(
      cur.orders.filter((o: OrderAgg) => o.channel === channel),
      cur.ads.filter((a: AdAgg) => adPlatformChannel(a.platform) === channel),
    ).pnl,
  }));

  const platforms = [...new Set(cur.ads.map((a) => a.platform))].sort();
  const byAdPlatform = platforms.map((platform) => {
    const rows = cur.ads.filter((a) => a.platform === platform);
    return {
      platform,
      spendCents: rows.reduce((a, r) => a + r.spend, 0),
      platformRevenueCents: rows.reduce((a, r) => a + r.revenue, 0),
    };
  });

  const callouts: string[] = [];
  for (const c of byChannel) {
    const net = c.pnl.netContributionAfterMarketing.cents;
    callouts.push(`${CHANNEL_LABEL[c.channel]} ${net >= 0 ? 'earned' : 'lost'} ${usd(net)} after ads this month.`);
  }
  for (const a of byAdPlatform) {
    callouts.push(
      `${PLATFORM_LABEL[a.platform] ?? a.platform} spent ${usd(a.spendCents)} and reports ${usd(a.platformRevenueCents)} in sales.`,
    );
  }

  return {
    month: p.month,
    currency: REPORT_CURRENCY,
    current: current.pnl,
    previous: previous.pnl,
    sameMonthLastYear: hadYearData ? buildPeriodPnl(year.orders, year.ads).pnl : null,
    comparison: comparePnl(current.pnl, previous.pnl),
    byChannel,
    byAdPlatform,
    costComplete: current.costComplete,
    callouts,
  };
}
