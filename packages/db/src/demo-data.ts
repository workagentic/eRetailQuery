import * as s from './schema';

/**
 * Pure generator for the demo business: orders and fees on Shopify and Amazon, inventory and ad insights,
 * with a planted story (a losing Meta campaign, a winning Google campaign, an underpriced bestseller,
 * three SKUs about to run out and one SKU that only loses money on Amazon). Deterministic for a given
 * `rand`. Money is integer cents.
 */

export interface SeedSku {
  id: string;
  skuCode: string;
  productId: string;
  sellingPriceCents: number;
}
/** Landed cost per unit in effect on a YYYY-MM-DD date. */
export type CostAt = (skuId: string, date: string) => number;
export type DemoChannel = 'shopify_online' | 'amazon';

export const DEMO_STORY = {
  losingCampaignName: 'Meta - Prospecting Broad',
  winningCampaignName: 'Google - Shopping Bestsellers',
  underpricedSkuCode: 'DEMO-1-1',
  amazonLossSkuCode: 'DEMO-5-1',
  lowStockSkuCodes: ['DEMO-2-1', 'DEMO-3-1', 'DEMO-4-1'],
} as const;

/** Fee model, kept in one place so the generator and the tests agree. */
export const FEE_MODEL = {
  shopifyPaymentBps: 290,
  shopifyPaymentFixedCents: 30,
  shopifyFulfillmentCents: 500,
  shopifyFulfillmentExtraUnitCents: 150,
  amazonReferralBps: 1500,
  amazonFbaPerUnitCents: 550,
} as const;

const pct = (cents: number, bps: number): number => Math.round((cents * bps) / 10000);

/** Contribution of one unit sold alone in an order, before ad spend. */
export function unitContributionCents(
  channel: DemoChannel,
  priceCents: number,
  landedCents: number,
): number {
  if (channel === 'amazon') {
    return (
      priceCents -
      landedCents -
      pct(priceCents, FEE_MODEL.amazonReferralBps) -
      FEE_MODEL.amazonFbaPerUnitCents
    );
  }
  return (
    priceCents -
    landedCents -
    pct(priceCents, FEE_MODEL.shopifyPaymentBps) -
    FEE_MODEL.shopifyPaymentFixedCents -
    FEE_MODEL.shopifyFulfillmentCents
  );
}

/** Reprices the planted SKUs. Everything else keeps its price. */
export function applyStory(skus: SeedSku[], landedNow: (skuId: string) => number): SeedSku[] {
  return skus.map((sku) => {
    const landed = landedNow(sku.id);
    if (sku.skuCode === DEMO_STORY.underpricedSkuCode) {
      return { ...sku, sellingPriceCents: Math.round(landed * 1.15) };
    }
    if (sku.skuCode === DEMO_STORY.amazonLossSkuCode) {
      // Loses about $1.50 a unit on Amazon (15% referral + FBA fee) while still earning on Shopify.
      const target = landed + FEE_MODEL.amazonFbaPerUnitCents - 150;
      return {
        ...sku,
        sellingPriceCents: Math.ceil(target / (1 - FEE_MODEL.amazonReferralBps / 10000)),
      };
    }
    return sku;
  });
}

export type OrderRow = typeof s.orders.$inferInsert;
export type OrderLineRow = typeof s.orderLines.$inferInsert;
export type LocationRow = typeof s.locations.$inferInsert;
export type InventoryLevelRow = typeof s.inventoryLevels.$inferInsert;
export type AdConnectionRow = typeof s.adConnections.$inferInsert;
export type AdCampaignRow = typeof s.adCampaigns.$inferInsert;
export type AdInsightRow = typeof s.adInsightsDaily.$inferInsert;

export interface DemoData {
  orders: OrderRow[];
  orderLines: OrderLineRow[];
  locations: LocationRow[];
  inventoryLevels: InventoryLevelRow[];
  adConnections: AdConnectionRow[];
  adCampaigns: AdCampaignRow[];
  adInsights: AdInsightRow[];
}

export interface GenerateInput {
  orgId: string;
  skus: SeedSku[];
  connections: { shopify: string; amazon: string };
  /** Last day of data, YYYY-MM-DD (inclusive). */
  endDate: string;
  days: number;
  rand: () => number;
  costAt: CostAt;
}

const uuid = (group: string, n: number): string =>
  `00000000-0000-4000-${group}-${String(n).padStart(12, '0')}`;

function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const WEEKDAY = [0.9, 1.0, 1.0, 1.0, 1.05, 1.1, 0.85]; // Sunday first
const MONTH = [0.9, 0.95, 1, 1, 1, 1, 1, 1, 1, 1.1, 1.4, 1.5]; // January first
function demand(date: string, index: number, days: number): number {
  const d = new Date(`${date}T00:00:00Z`);
  const growth = 0.85 + (0.3 * index) / Math.max(days - 1, 1);
  return WEEKDAY[d.getUTCDay()]! * MONTH[d.getUTCMonth()]! * growth;
}

interface CampaignPlan {
  name: string;
  platform: 'meta' | 'google' | 'amazon_ads';
  objective: string;
  spendPerDayCents: number;
  roas: number;
}
const CAMPAIGNS: CampaignPlan[] = [
  { name: DEMO_STORY.losingCampaignName, platform: 'meta', objective: 'conversions', spendPerDayCents: 22000, roas: 1.9 },
  { name: 'Meta - Retargeting', platform: 'meta', objective: 'conversions', spendPerDayCents: 9000, roas: 5.2 },
  { name: 'Meta - Lookalike Buyers', platform: 'meta', objective: 'conversions', spendPerDayCents: 12000, roas: 4.6 },
  { name: DEMO_STORY.winningCampaignName, platform: 'google', objective: 'shopping', spendPerDayCents: 18000, roas: 8.0 },
  { name: 'Google - Performance Max', platform: 'google', objective: 'pmax', spendPerDayCents: 15000, roas: 5.0 },
  { name: 'Google - Brand Search', platform: 'google', objective: 'search', spendPerDayCents: 4000, roas: 9.5 },
  { name: 'Amazon - Sponsored Products Auto', platform: 'amazon_ads', objective: 'sponsored_products', spendPerDayCents: 8000, roas: 5.5 },
  { name: 'Amazon - Sponsored Brands', platform: 'amazon_ads', objective: 'sponsored_brands', spendPerDayCents: 6000, roas: 3.2 },
];
const AD_ACCOUNT: Record<CampaignPlan['platform'], string> = {
  meta: 'act-demo-meta',
  google: 'gads-demo',
  amazon_ads: 'amzads-demo',
};

export function generateDemoData(input: GenerateInput): DemoData {
  const { orgId, skus, rand, costAt, endDate, days } = input;
  const startDate = addDays(endDate, -(days - 1));

  // Popularity: a long tail, with the planted SKUs among the bestsellers.
  const storyCodes = new Set<string>([
    DEMO_STORY.underpricedSkuCode,
    DEMO_STORY.amazonLossSkuCode,
    ...DEMO_STORY.lowStockSkuCodes,
  ]);
  const weights = skus.map((sku) => (storyCodes.has(sku.skuCode) ? 8 : 0.2 + 3 * rand() ** 3));
  const total = weights.reduce((a, w) => a + w, 0);
  const pickSku = (): SeedSku => {
    let r = rand() * total;
    for (let i = 0; i < skus.length; i++) {
      r -= weights[i]!;
      if (r <= 0) return skus[i]!;
    }
    return skus[skus.length - 1]!;
  };

  const orders: OrderRow[] = [];
  const orderLines: OrderLineRow[] = [];
  let orderN = 0;
  let lineN = 0;
  for (let i = 0; i < days; i++) {
    const date = addDays(startDate, i);
    const factor = demand(date, i, days);
    for (const [channel, connectionId, mean] of [
      ['shopify_online', input.connections.shopify, 8.4],
      ['amazon', input.connections.amazon, 5.6],
    ] as const) {
      const count = Math.max(1, Math.round(mean * factor * (0.7 + 0.6 * rand())));
      for (let k = 0; k < count; k++) {
        orderN++;
        const orderId = uuid('8003', orderN);
        const placedAt = new Date(
          `${date}T${String(8 + Math.floor(rand() * 15)).padStart(2, '0')}:${String(Math.floor(rand() * 60)).padStart(2, '0')}:00Z`,
        );
        const lineCount = 1 + Math.floor(rand() * 3 * rand() + 0.2);
        const discounted = rand() < 0.1;
        const cancelled = rand() < 0.015;
        const refunded = !cancelled && rand() < 0.04;
        let gross = 0;
        let discount = 0;
        let units = 0;
        let refund = 0;
        for (let j = 0; j < lineCount; j++) {
          lineN++;
          const sku = pickSku();
          const quantity = rand() < 0.8 ? 1 : rand() < 0.6 ? 2 : 3;
          const lineGross = sku.sellingPriceCents * quantity;
          const lineDiscount = discounted ? Math.round(lineGross * 0.1) : 0;
          gross += lineGross;
          discount += lineDiscount;
          units += quantity;
          const refundThis = refunded && j === 0;
          if (refundThis) {
            refund += sku.sellingPriceCents - Math.round(lineDiscount / quantity);
          }
          orderLines.push({
            id: uuid('8004', lineN),
            orgId,
            orderId,
            skuId: sku.id,
            externalLineId: `L${lineN}`,
            title: sku.skuCode,
            quantity,
            unitPriceCents: sku.sellingPriceCents,
            discountCents: lineDiscount,
            refundedQuantity: refundThis ? 1 : 0,
            unitCogsCentsSnapshot: costAt(sku.id, date),
          });
        }
        const base = gross - discount;
        const isAmazon = channel === 'amazon';
        orders.push({
          id: orderId,
          orgId,
          storeConnectionId: connectionId,
          externalOrderId: `${isAmazon ? 'AMZ' : 'SH'}-${orderN}`,
          channel,
          status: cancelled ? 'cancelled' : 'closed',
          placedAt,
          cancelledAt: cancelled ? placedAt : null,
          currency: 'USD',
          grossCents: gross,
          discountCents: discount,
          shippingChargedCents: 0,
          taxCents: 0,
          refundCents: refund,
          netCents: gross - discount - refund,
          paymentFeeCents: cancelled || isAmazon ? 0 : pct(base, FEE_MODEL.shopifyPaymentBps) + FEE_MODEL.shopifyPaymentFixedCents,
          marketplaceFeeCents: cancelled || !isAmazon ? 0 : pct(base, FEE_MODEL.amazonReferralBps),
          fulfillmentCostCents: cancelled
            ? 0
            : isAmazon
              ? FEE_MODEL.amazonFbaPerUnitCents * units
              : FEE_MODEL.shopifyFulfillmentCents + FEE_MODEL.shopifyFulfillmentExtraUnitCents * (units - 1),
          externalUpdatedAt: placedAt,
        });
      }
    }
  }

  // Inventory: stock sized from the same weighted velocity the app uses (7, 30 and 90 days, 50/30/20),
  // so ordinary SKUs hold 35 to 125 days of cover and only the planted SKUs are about to run out.
  const since7 = addDays(endDate, -6);
  const since30 = addDays(endDate, -29);
  const since90 = addDays(endDate, -89);
  const orderDay = new Map(orders.map((o) => [o.id!, (o.placedAt as Date).toISOString().slice(0, 10)]));
  const units = new Map<string, { u7: number; u30: number; u90: number }>();
  for (const l of orderLines) {
    const d = orderDay.get(l.orderId)!;
    if (d < since90) continue;
    const u = units.get(l.skuId!) ?? { u7: 0, u30: 0, u90: 0 };
    u.u90 += l.quantity;
    if (d >= since30) u.u30 += l.quantity;
    if (d >= since7) u.u7 += l.quantity;
    units.set(l.skuId!, u);
  }
  const weightedVelocity = (skuId: string): number => {
    const u = units.get(skuId);
    return u ? 0.5 * (u.u7 / 7) + 0.3 * (u.u30 / 30) + 0.2 * (u.u90 / 90) : 0;
  };
  const lowStock = new Set<string>(DEMO_STORY.lowStockSkuCodes);
  const locations: LocationRow[] = [
    { id: uuid('8005', 1), orgId, name: 'Main warehouse', type: 'warehouse', source: 'manual' },
    { id: uuid('8005', 2), orgId, name: 'Amazon FBA', type: 'fba', source: 'manual' },
  ];
  const inventoryLevels: InventoryLevelRow[] = [];
  skus.forEach((sku, idx) => {
    const velocity = weightedVelocity(sku.id);
    let onHand: number;
    if (lowStock.has(sku.skuCode)) onHand = Math.max(1, Math.floor(velocity * 2.5));
    else if (velocity === 0) onHand = idx % 7 === 0 ? 0 : 5 + Math.floor(rand() * 60);
    else if (idx % 25 === 0) onHand = Math.ceil(velocity * 300);
    else onHand = Math.ceil(velocity * (35 + Math.floor(rand() * 90)));
    const fba = Math.floor(onHand / 4);
    inventoryLevels.push(
      { orgId, skuId: sku.id, locationId: locations[0]!.id!, onHand: onHand - fba, reserved: 0, incoming: 0 },
      { orgId, skuId: sku.id, locationId: locations[1]!.id!, onHand: fba, reserved: 0, incoming: 0 },
    );
  });

  // Ads: one connection per platform, eight campaigns, one row per campaign per day.
  const platforms = ['meta', 'google', 'amazon_ads'] as const;
  const adConnections: AdConnectionRow[] = platforms.map((platform, i) => ({
    id: uuid('8007', i + 1),
    orgId,
    platform,
    externalAccountId: AD_ACCOUNT[platform],
    status: 'demo',
  }));
  const adCampaigns: AdCampaignRow[] = CAMPAIGNS.map((c, i) => ({
    id: uuid('8006', i + 1),
    orgId,
    adConnectionId: adConnections[platforms.indexOf(c.platform)]!.id!,
    externalId: `camp-${i + 1}`,
    name: c.name,
    objective: c.objective,
  }));
  const adInsights: AdInsightRow[] = [];
  CAMPAIGNS.forEach((c, ci) => {
    for (let i = 0; i < days; i++) {
      const date = addDays(startDate, i);
      const spend = Math.round(c.spendPerDayCents * demand(date, i, days) * (0.85 + 0.3 * rand()));
      const revenue = Math.round(spend * c.roas * (0.88 + 0.24 * rand()));
      const impressions = Math.round((spend / 100) * 80);
      adInsights.push({
        orgId,
        campaignId: adCampaigns[ci]!.id!,
        date,
        currency: 'USD',
        spendCents: spend,
        impressions,
        clicks: Math.round(impressions * 0.014),
        conversions: Math.round(revenue / 4500),
        revenueCents: revenue,
      });
    }
  });

  return { orders, orderLines, locations, inventoryLevels, adConnections, adCampaigns, adInsights };
}
