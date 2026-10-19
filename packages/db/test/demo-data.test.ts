import { describe, expect, it } from 'vitest';
import { classifyAd, daysOfCover, salesVelocity, type AdDay } from '@erq/metrics';
import { money } from '@erq/shared';
import {
  DEMO_STORY,
  applyStory,
  generateDemoData,
  unitContributionCents,
  type DemoData,
  type SeedSku,
} from '../src/demo-data';

const ORG = '00000000-0000-4000-8000-000000000001';
const END = '2026-10-19';
const SHOP = '00000000-0000-4000-8009-000000000001';
const AMZ = '00000000-0000-4000-8009-000000000003';

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Landed cost: $20 to $30, with an older, cheaper cost before 2026-01-01 for every third SKU.
const landedNow = (skuId: string): number => 2000 + (Number(skuId.slice(-12)) % 11) * 100;
const costAt = (skuId: string, date: string): number =>
  Number(skuId.slice(-12)) % 3 === 0 && date < '2026-01-01'
    ? Math.round(landedNow(skuId) * 0.9)
    : landedNow(skuId);

const baseSkus = (): SeedSku[] =>
  Array.from({ length: 200 }, (_, i) => ({
    id: `00000000-0000-4000-8002-${String(i).padStart(12, '0')}`,
    skuCode: `DEMO-${Math.floor(i / 5) + 1}-${(i % 5) + 1}`,
    productId: `00000000-0000-4000-8001-${String(Math.floor(i / 5)).padStart(12, '0')}`,
    sellingPriceCents: 0,
  })).map((sku) => ({ ...sku, sellingPriceCents: Math.round(landedNow(sku.id) * 1.8) - 1 }));

function build(seed = 7): { skus: SeedSku[]; data: DemoData } {
  const skus = applyStory(baseSkus(), landedNow);
  const data = generateDemoData({
    orgId: ORG,
    skus,
    connections: { shopify: SHOP, amazon: AMZ },
    endDate: END,
    days: 365,
    rand: mulberry(seed),
    costAt,
  });
  return { skus, data };
}
const { skus, data } = build();
const day = (iso: unknown) => String(iso instanceof Date ? iso.toISOString() : iso).slice(0, 10);
const skuByCode = (code: string) => skus.find((s) => s.skuCode === code)!;

describe('generateDemoData', () => {
  it('is deterministic for the same seed', () => {
    expect(build(7).data).toEqual(data);
    expect(build(8).data).not.toEqual(data);
  });

  it('gives every order net = gross - discount - refund', () => {
    expect(data.orders.length).toBeGreaterThan(3000);
    for (const o of data.orders) {
      expect(o.netCents).toBe(o.grossCents - o.discountCents - (o.refundCents ?? 0));
    }
  });

  it('snapshots the landed cost in effect on the order date on every line', () => {
    const placed = new Map(data.orders.map((o) => [o.id!, day(o.placedAt)]));
    expect(data.orderLines.length).toBeGreaterThan(data.orders.length);
    for (const l of data.orderLines) {
      expect(l.unitCogsCentsSnapshot).toBe(costAt(l.skuId!, placed.get(l.orderId)!));
    }
  });

  it('has orders on both shopify_online and amazon on nearly every one of 365 days', () => {
    for (const channel of ['shopify_online', 'amazon'] as const) {
      const days = new Set(
        data.orders.filter((o) => o.channel === channel).map((o) => day(o.placedAt)),
      );
      expect(days.size).toBeGreaterThanOrEqual(350);
    }
  });

  it('charges amazon orders a referral fee near 15% and a fulfillment cost', () => {
    const amz = data.orders.filter((o) => o.channel === 'amazon' && o.status !== 'cancelled');
    const fee = amz.reduce((a, o) => a + (o.marketplaceFeeCents ?? 0), 0);
    const base = amz.reduce((a, o) => a + o.grossCents - o.discountCents, 0);
    expect(fee / base).toBeGreaterThan(0.14);
    expect(fee / base).toBeLessThan(0.16);
    expect(amz.every((o) => (o.fulfillmentCostCents ?? 0) > 0)).toBe(true);
    expect(amz.every((o) => (o.paymentFeeCents ?? 0) === 0)).toBe(true);
  });

  it('prices the planted underpriced SKU below landed x 1.5 but above landed', () => {
    const s = skuByCode(DEMO_STORY.underpricedSkuCode);
    expect(s.sellingPriceCents).toBeLessThan(landedNow(s.id) * 1.5);
    expect(s.sellingPriceCents).toBeGreaterThan(landedNow(s.id));
  });

  it('makes the amazon-loss SKU lose money on amazon and earn on shopify_online', () => {
    const s = skuByCode(DEMO_STORY.amazonLossSkuCode);
    const landed = landedNow(s.id);
    expect(unitContributionCents('amazon', s.sellingPriceCents, landed)).toBeLessThan(0);
    expect(unitContributionCents('shopify_online', s.sellingPriceCents, landed)).toBeGreaterThan(
      0,
    );
  });

  it('leaves the three planted SKUs with days of cover below the 7-day buffer', () => {
    const cutoff = (n: number) => {
      const d = new Date(`${END}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - n + 1);
      return d.toISOString().slice(0, 10);
    };
    const orderDay = new Map(data.orders.map((o) => [o.id!, day(o.placedAt)]));
    for (const code of DEMO_STORY.lowStockSkuCodes) {
      const s = skuByCode(code);
      const units = (n: number) =>
        data.orderLines
          .filter((l) => l.skuId === s.id && orderDay.get(l.orderId)! >= cutoff(n))
          .reduce((a, l) => a + l.quantity, 0);
      const velocity = salesVelocity({ units7: units(7), units30: units(30), units90: units(90) });
      const onHand = data.inventoryLevels
        .filter((l) => l.skuId === s.id)
        .reduce((a, l) => a + l.onHand, 0);
      const cover = daysOfCover(onHand, velocity);
      expect(cover).not.toBeNull();
      expect(cover!).toBeLessThan(7);
    }
  });

  it('creates one warehouse and one fba location with a level for every SKU in each', () => {
    expect(data.locations.map((l) => l.type).sort()).toEqual(['fba', 'warehouse']);
    expect(data.inventoryLevels).toHaveLength(skus.length * 2);
  });

  describe('ad stories', () => {
    const live = data.orders.filter((o) => o.status !== 'cancelled');
    const liveIds = new Set(live.map((o) => o.id));
    const net = live.reduce((a, o) => a + o.netCents, 0);
    const cogs = data.orderLines
      .filter((l) => liveIds.has(l.orderId))
      .reduce((a, l) => a + (l.unitCogsCentsSnapshot ?? 0) * l.quantity, 0);
    const fees = live.reduce(
      (a, o) =>
        a +
        (o.paymentFeeCents ?? 0) +
        (o.marketplaceFeeCents ?? 0) +
        (o.fulfillmentCostCents ?? 0),
      0,
    );
    const contributionBeforeAds = Math.round(((net - cogs - fees) / net) * 10000);

    const flagFor = (name: string) => {
      const c = data.adCampaigns.find((x) => x.name === name)!;
      const rows = data.adInsights
        .filter((r) => r.campaignId === c.id)
        .sort((a, b) => (a.date < b.date ? -1 : 1))
        .slice(-14);
      const days: AdDay[] = rows.map((r) => ({
        date: r.date,
        spend: money(r.spendCents, 'USD'),
        impressions: r.impressions ?? 0,
        clicks: r.clicks ?? 0,
        conversions: r.conversions ?? 0,
        revenue: money(r.revenueCents ?? 0, 'USD'),
      }));
      return classifyAd({ days, contributionBeforeAds });
    };

    it('has a healthy contribution before ads', () => {
      expect(contributionBeforeAds).toBeGreaterThan(1500);
    });
    it('classifies the planted Meta campaign as losing', () => {
      expect(flagFor(DEMO_STORY.losingCampaignName).code).toBe('losing');
    });
    it('classifies the planted Google campaign as winning', () => {
      expect(flagFor(DEMO_STORY.winningCampaignName).code).toBe('winning');
    });
    it('has 8 campaigns on meta, google and amazon_ads with 365 days of insights each', () => {
      expect(new Set(data.adConnections.map((c) => c.platform))).toEqual(
        new Set(['meta', 'google', 'amazon_ads']),
      );
      expect(data.adCampaigns).toHaveLength(8);
      expect(data.adInsights).toHaveLength(8 * 365);
    });
  });
});
