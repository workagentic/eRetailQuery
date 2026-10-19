import { sql } from 'drizzle-orm';
import { classifyAd, type AdDay, type AdFlagCode } from '@erq/metrics';
import { formatMoney, money } from '@erq/shared';
import type { Tx } from '../tenant-db';
import {
  REPORT_CURRENCY,
  adPlatformChannel,
  buildPeriodPnl,
  loadOrderAgg,
  loadOrgTimezone,
} from './aggregate';
import { addDays } from './range';
import type { ReportRange, SalesChannelName } from './types';

export interface AdCampaignRow {
  id: string;
  name: string;
  platform: string;
  spendCents: number;
  platformRevenueCents: number;
  /** Platform-reported revenue over spend; null when nothing was spent. */
  roas: number | null;
  flag: AdFlagCode;
  /** Why the flag fired, in plain English. */
  reason: string;
  /** What to do about it. */
  action: string;
  estimatedDailyLossCents: number | null;
}

export interface AdsReport {
  currency: string;
  totals: {
    spendCents: number;
    platformRevenueCents: number;
    /** Net sales over ad spend: the honest overall number. Null when nothing was spent. */
    blendedRoas: number | null;
    /** Revenue the ad platforms claim over spend; platforms can overlap and over-claim. */
    platformRoas: number | null;
  };
  byPlatform: {
    platform: string;
    spendCents: number;
    platformRevenueCents: number;
    roas: number | null;
    /** Platform-claimed revenue times the contribution margin, minus spend; null without cost data. */
    netAfterAdsCents: number | null;
  }[];
  campaigns: AdCampaignRow[];
  /** True when there was no cost data to compute a break-even ROAS, so generic bands were used. */
  usedGenericBands: boolean;
  /** False when some sold units have no cost on record, so break-even ROAS is flattered. */
  costComplete: boolean;
}

const num = (v: unknown): number => Number(v ?? 0);
const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);
const RANK: Record<AdFlagCode, number> = { losing: 0, watch: 1, winning: 2, learning: 3 };

function actionFor(flag: AdFlagCode, lossCents: number | null): string {
  switch (flag) {
    case 'losing':
      return lossCents !== null && lossCents > 0
        ? `Pause this campaign or cut its budget. It loses about ${formatMoney(money(lossCents, REPORT_CURRENCY))} a day.`
        : 'Pause this campaign or cut its budget.';
    case 'watch':
      return 'Keep an eye on it and do not add budget yet.';
    case 'winning':
      return 'Scale it: raise the budget in small steps of 10 to 20 percent.';
    case 'learning':
      return 'Wait for more data before judging it.';
  }
}

export async function getAds(
  tx: Tx,
  p: { range: ReportRange; asOf: string },
): Promise<AdsReport> {
  const tz = await loadOrgTimezone(tx);

  // Contribution before ads per sales channel; an ad platform is judged on the channel it sells on.
  const orders = await loadOrderAgg(tx, { range: p.range, channel: 'all', tz });
  const contribution = (channel: SalesChannelName | null): number | null => {
    const x = buildPeriodPnl(
      orders.filter((o) => channel === null || o.channel === channel),
      [],
    );
    return x.pnl.marginsBps.contributionMargin;
  };
  const allOrders = buildPeriodPnl(orders, []);

  const totalsRows = (
    await tx.execute(sql`
      select k.id, k.name, c.platform::text as platform, sum(i.spend_cents) as spend, sum(i.revenue_cents) as revenue
      from ad_campaigns k
      join ad_connections c on c.org_id = k.org_id and c.id = k.ad_connection_id
      left join ad_insights_daily i on i.org_id = k.org_id and i.campaign_id = k.id
        and i.date between ${p.range.from}::date and ${p.range.to}::date
      group by k.id, k.name, c.platform`)
  ).rows as Record<string, unknown>[];

  const flagFrom = addDays(p.asOf, -13);
  const dailyRows = (
    await tx.execute(sql`
      select campaign_id, date::text as date, spend_cents, impressions, clicks, conversions, revenue_cents
      from ad_insights_daily where date between ${flagFrom}::date and ${p.asOf}::date`)
  ).rows as Record<string, unknown>[];
  const dailyByCampaign = new Map<string, Map<string, Record<string, unknown>>>();
  for (const d of dailyRows) {
    const id = String(d.campaign_id);
    const m = dailyByCampaign.get(id) ?? new Map();
    m.set(String(d.date), d);
    dailyByCampaign.set(id, m);
  }

  let anyGeneric = false;
  const campaigns: AdCampaignRow[] = totalsRows.map((t) => {
    const id = String(t.id);
    const platform = String(t.platform);
    const have = dailyByCampaign.get(id) ?? new Map();
    const flagDays: AdDay[] = Array.from({ length: 14 }, (_, i) => {
      const date = addDays(flagFrom, i);
      const d = have.get(date);
      return {
        date,
        spend: money(num(d?.spend_cents), REPORT_CURRENCY),
        impressions: num(d?.impressions),
        clicks: num(d?.clicks),
        conversions: num(d?.conversions),
        revenue: money(num(d?.revenue_cents), REPORT_CURRENCY),
      };
    });
    const flag = classifyAd({
      days: flagDays,
      contributionBeforeAds: contribution(adPlatformChannel(platform)),
    });
    const margin = contribution(adPlatformChannel(platform));
    // Generic bands mean "no usable cost data". A channel that loses money before ads is a different case:
    // costs are known, and any ad spend there only adds to the loss, whatever the ROAS.
    if (flag.usedGenericBands && margin === null) anyGeneric = true;
    const spend = num(t.spend);
    const revenue = num(t.revenue);
    const everySaleLoses = margin !== null && margin <= 0 && flag.code !== 'learning';
    const dailySpend =
      flag.facts.daysUsed > 0 ? Math.round(flag.facts.spend.cents / flag.facts.daysUsed) : 0;
    const code: AdFlagCode = everySaleLoses ? 'losing' : flag.code;
    const loss = everySaleLoses ? dailySpend : (flag.estimatedDailyLoss?.cents ?? null);
    return {
      id,
      name: String(t.name),
      platform,
      spendCents: spend,
      platformRevenueCents: revenue,
      roas: ratio(revenue, spend),
      flag: code,
      reason: everySaleLoses
        ? 'Every sale on the channel this ad sells on loses money before ads (after cost of goods, fees and fulfillment), so ad spend only adds to the loss.'
        : flag.explanation,
      action: actionFor(code, loss),
      estimatedDailyLossCents: loss,
    };
  });
  campaigns.sort((a, b) => RANK[a.flag] - RANK[b.flag] || b.spendCents - a.spendCents);

  const platforms = [...new Set(campaigns.map((c) => c.platform))].sort();
  const byPlatform = platforms.map((platform) => {
    const rows = campaigns.filter((c) => c.platform === platform);
    const spend = rows.reduce((a, c) => a + c.spendCents, 0);
    const revenue = rows.reduce((a, c) => a + c.platformRevenueCents, 0);
    const margin = contribution(adPlatformChannel(platform));
    return {
      platform,
      spendCents: spend,
      platformRevenueCents: revenue,
      roas: ratio(revenue, spend),
      netAfterAdsCents: margin === null ? null : Math.round((revenue * margin) / 10000) - spend,
    };
  });

  const spendTotal = campaigns.reduce((a, c) => a + c.spendCents, 0);
  const revenueTotal = campaigns.reduce((a, c) => a + c.platformRevenueCents, 0);
  return {
    currency: REPORT_CURRENCY,
    totals: {
      spendCents: spendTotal,
      platformRevenueCents: revenueTotal,
      blendedRoas: ratio(allOrders.pnl.netSales.cents, spendTotal),
      platformRoas: ratio(revenueTotal, spendTotal),
    },
    byPlatform,
    campaigns,
    usedGenericBands: anyGeneric,
    costComplete: allOrders.costComplete,
  };
}
