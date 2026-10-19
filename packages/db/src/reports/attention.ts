import { formatMoney, money } from '@erq/shared';
import type { Tx } from '../tenant-db';
import { REPORT_CURRENCY } from './aggregate';
import { getAds } from './ads';
import { getInventory } from './inventory';
import { getProducts } from './products';
import type { ReportRange } from './types';

export interface AttentionItem {
  kind: 'losing_ad' | 'underpriced' | 'amazon_loss' | 'low_stock';
  severity: 1 | 2 | 3;
  title: string;
  /** Why this fired, in plain English. */
  why: string;
  /** What to do about it. */
  action: string;
  href: string;
  /** Rough dollars at stake, in cents, used to rank items. */
  stakeCents: number;
}

/** Days of sales lost if a fast seller runs out before a restock arrives (the unknown-lead-time default). */
const RESTOCK_DAYS = 14;

const usd = (cents: number): string => formatMoney(money(Math.round(cents), REPORT_CURRENCY));
const severityFor = (stake: number): AttentionItem['severity'] =>
  stake >= 50_000 ? 3 : stake >= 10_000 ? 2 : 1;

/** The five things an owner should look at first, ranked by dollars at stake. Composes the other reports. */
export async function getAttention(
  tx: Tx,
  p: { range: ReportRange; previous: ReportRange; asOf: string },
): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];

  const ads = await getAds(tx, { range: p.range, asOf: p.asOf });
  for (const c of ads.campaigns.filter((x) => x.flag === 'losing')) {
    const stake = (c.estimatedDailyLossCents ?? 0) * 7;
    items.push({
      kind: 'losing_ad',
      severity: severityFor(stake),
      title: `${c.name} is losing money`,
      why: c.reason,
      action: c.action,
      href: '/ads',
      stakeCents: stake,
    });
  }

  const all = await getProducts(tx, { range: p.range, channel: 'all', asOf: p.asOf });
  const underpriced = all.filter((x) => x.pricingStatus === 'underpriced' && x.unitsSold > 0);
  for (const s of underpriced) {
    const stake = Math.max(0, (s.idealLowCents ?? s.priceCents) - s.priceCents) * s.unitsSold;
    items.push({
      kind: 'underpriced',
      severity: severityFor(stake),
      title: `${s.title} (${s.skuCode}) is underpriced`,
      why: `${s.message} It sold ${s.unitsSold} units at this price in the period.`,
      action: `Raise the price to at least ${usd(s.idealLowCents ?? s.priceCents)}.`,
      href: '/products',
      stakeCents: stake,
    });
  }

  const amazon = await getProducts(tx, { range: p.range, channel: 'amazon', asOf: p.asOf });
  // A SKU already listed as underpriced is not reported twice; its low price is the cause.
  const listed = new Set(underpriced.map((x) => x.skuId));
  const losers = amazon
    .filter((x) => x.contributionNegative && x.unitsSold > 0 && !listed.has(x.skuId))
    .map((x) => ({ ...x, stake: Math.max(0, -(x.contributionCents ?? 0)) * x.unitsSold }))
    .sort((x, y) => y.stake - x.stake);
  if (losers.length > 0) {
    const stake = losers.reduce((a, x) => a + x.stake, 0);
    const names = losers
      .slice(0, 3)
      .map((x) => `${x.title} (${x.skuCode}) loses ${usd(-(x.contributionCents ?? 0))} a unit`)
      .join(', ');
    items.push({
      kind: 'amazon_loss',
      severity: severityFor(stake),
      title: `${losers.length} ${losers.length === 1 ? 'product loses' : 'products lose'} money on Amazon`,
      why: `After Amazon fees and fulfillment, each sale costs more than it earns: ${names}.`,
      action: 'Raise the Amazon price, or stop selling these there.',
      href: '/products?channel=amazon',
      stakeCents: stake,
    });
  }

  const inventory = await getInventory(tx, { asOf: p.asOf });
  if (inventory.lowStock.length > 0) {
    const low = inventory.lowStock;
    const stake = low.reduce(
      (a, s) => a + s.velocityPerDay * s.priceCents * Math.max(0, RESTOCK_DAYS - (s.daysOfCover ?? 0)),
      0,
    );
    const names = low
      .slice(0, 3)
      .map((s) => `${s.title} (${s.daysOfCover === null ? 'no sales' : `${Math.floor(s.daysOfCover)} days left`})`)
      .join(', ');
    items.push({
      kind: 'low_stock',
      severity: severityFor(stake),
      title: `${low.length} ${low.length === 1 ? 'product is' : 'products are'} about to run out`,
      why: `At the current sales pace these run out before a restock can arrive: ${names}.`,
      action: 'Reorder now so you do not lose sales.',
      href: '/inventory',
      stakeCents: Math.round(stake),
    });
  }

  return items.sort((a, b) => b.stakeCents - a.stakeCents).slice(0, 5);
}
