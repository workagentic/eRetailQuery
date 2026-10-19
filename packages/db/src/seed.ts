import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import * as s from './schema';
import { applyStory, generateDemoData, type SeedSku } from './demo-data';

export const DEMO_ORG_ID = '00000000-0000-4000-8000-000000000001';
export const DEMO_STORE_IDS = {
  shopify: '00000000-0000-4000-8009-000000000001',
  woocommerce: '00000000-0000-4000-8009-000000000002',
  amazon: '00000000-0000-4000-8009-000000000003',
} as const;
export const DEMO_USER_IDS = {
  owner: '00000000-0000-4000-8000-0000000000a1',
  analyst: '00000000-0000-4000-8000-0000000000a2',
  viewer: '00000000-0000-4000-8000-0000000000a3',
} as const;

// mulberry32: tiny deterministic PRNG so the demo data is identical on every run.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CATEGORIES = ['Apparel', 'Home', 'Beauty', 'Outdoor', 'Kitchen', 'Pets', 'Fitness', 'Toys'];
const VARIANTS = ['Small', 'Medium', 'Large', 'XL', 'One Size'];
const PRODUCT_COUNT = 40; // x 5 variants = 200 SKUs

function chunks<T>(rows: T[], size = 1000): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** Defaults to the 365 days ending yesterday (UTC), so reseed shortly before a demo. */
export async function seedDemoOrg(
  ownerUrl: string,
  opts: { endDate?: string; days?: number } = {},
): Promise<void> {
  const endDate =
    opts.endDate ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const pool = new Pool({ connectionString: ownerUrl, max: 1 });
  const db = drizzle(pool, { schema: s });
  const rand = rng(42);
  try {
    await db.transaction(async (tx) => {
      await tx.delete(s.orgs).where(eq(s.orgs.id, DEMO_ORG_ID)); // cascades to all demo tenant rows
      await tx.insert(s.orgs).values({ id: DEMO_ORG_ID, name: 'Demo Outfitters', slug: 'demo' });
      await tx.insert(s.orgMembers).values([
        { orgId: DEMO_ORG_ID, userId: DEMO_USER_IDS.owner, role: 'owner' },
        { orgId: DEMO_ORG_ID, userId: DEMO_USER_IDS.analyst, role: 'analyst' },
        { orgId: DEMO_ORG_ID, userId: DEMO_USER_IDS.viewer, role: 'viewer' },
      ]);
      await tx.insert(s.subscriptions).values({ orgId: DEMO_ORG_ID, plan: 'free' });
      await tx.insert(s.storeConnections).values([
        {
          id: DEMO_STORE_IDS.shopify,
          orgId: DEMO_ORG_ID,
          platform: 'shopify',
          externalAccountId: 'demo-shopify',
          status: 'demo',
        },
        {
          id: DEMO_STORE_IDS.woocommerce,
          orgId: DEMO_ORG_ID,
          platform: 'woocommerce',
          externalAccountId: 'demo-woo',
          status: 'demo',
        },
        {
          id: DEMO_STORE_IDS.amazon,
          orgId: DEMO_ORG_ID,
          platform: 'amazon',
          externalAccountId: 'demo-amazon',
          status: 'demo',
        },
      ]);

      const productRows: (typeof s.products.$inferInsert)[] = [];
      const skuRows: (typeof s.skus.$inferInsert)[] = [];
      const costRows: (typeof s.skuCostComponents.$inferInsert)[] = [];
      for (let p = 0; p < PRODUCT_COUNT; p++) {
        const productId = `00000000-0000-4000-8001-${String(p).padStart(12, '0')}`;
        productRows.push({
          id: productId,
          orgId: DEMO_ORG_ID,
          title: `Demo Product ${p + 1}`,
          brand: 'Demo Co',
          category: CATEGORIES[p % CATEGORIES.length],
        });
        const baseCost = 400 + Math.floor(rand() * 5600);
        VARIANTS.forEach((variant, v) => {
          const skuId = `00000000-0000-4000-8002-${String(p * 5 + v).padStart(12, '0')}`;
          const productCost = baseCost + v * 25;
          const freight = Math.round(productCost * (0.05 + rand() * 0.1));
          const packaging = 50 + Math.floor(rand() * 200);
          const duties = rand() < 0.5 ? Math.round(productCost * (0.05 + rand() * 0.2)) : 0;
          const landed = productCost + freight + packaging + duties;
          const price = Math.round((landed * (1.5 + rand() * 0.6)) / 100) * 100 - 1;
          skuRows.push({
            id: skuId,
            orgId: DEMO_ORG_ID,
            productId,
            skuCode: `DEMO-${p + 1}-${v + 1}`,
            sellingPriceCents: Math.max(price, landed + 1),
          });
          const base = { orgId: DEMO_ORG_ID, skuId, perUnit: true };
          if (rand() < 0.3) {
            // Supplier price increase: older cost closed out, newer cost open-ended.
            costRows.push({
              ...base,
              componentType: 'product_cost',
              amountCents: Math.round(productCost * 0.9),
              effectiveFrom: '2025-01-01',
              effectiveTo: '2025-07-01',
            });
            costRows.push({
              ...base,
              componentType: 'product_cost',
              amountCents: productCost,
              effectiveFrom: '2025-07-01',
            });
          } else {
            costRows.push({
              ...base,
              componentType: 'product_cost',
              amountCents: productCost,
              effectiveFrom: '2025-01-01',
            });
          }
          costRows.push({
            ...base,
            componentType: 'inbound_freight',
            amountCents: freight,
            effectiveFrom: '2025-01-01',
          });
          costRows.push({
            ...base,
            componentType: 'packaging',
            amountCents: packaging,
            effectiveFrom: '2025-01-01',
          });
          if (duties > 0)
            costRows.push({
              ...base,
              componentType: 'duties_tariffs',
              amountCents: duties,
              effectiveFrom: '2025-01-01',
            });
        });
      }
      // Time-versioned landed cost: every component in effect on the date, from <= date < to.
      const costsBySku = new Map<string, (typeof s.skuCostComponents.$inferInsert)[]>();
      for (const c of costRows) {
        const list = costsBySku.get(c.skuId) ?? [];
        list.push(c);
        costsBySku.set(c.skuId, list);
      }
      const costAt = (skuId: string, date: string): number =>
        (costsBySku.get(skuId) ?? [])
          .filter((c) => c.effectiveFrom <= date && (!c.effectiveTo || date < c.effectiveTo))
          .reduce((a, c) => a + c.amountCents, 0);
      const today = new Date().toISOString().slice(0, 10);
      const storySkus = applyStory(
        skuRows.map((r) => ({
          id: r.id!,
          skuCode: r.skuCode,
          productId: r.productId,
          sellingPriceCents: r.sellingPriceCents,
        })) satisfies SeedSku[],
        (skuId) => costAt(skuId, today),
      );
      const priceById = new Map(storySkus.map((x) => [x.id, x.sellingPriceCents]));
      for (const r of skuRows) r.sellingPriceCents = priceById.get(r.id!)!;

      await tx.insert(s.products).values(productRows);
      await tx.insert(s.skus).values(skuRows);
      await tx.insert(s.skuCostComponents).values(costRows);

      const demo = generateDemoData({
        orgId: DEMO_ORG_ID,
        skus: storySkus,
        connections: { shopify: DEMO_STORE_IDS.shopify, amazon: DEMO_STORE_IDS.amazon },
        endDate,
        days: opts.days ?? 365,
        rand: rng(4242),
        costAt,
      });
      for (const c of chunks(demo.orders)) await tx.insert(s.orders).values(c);
      for (const c of chunks(demo.orderLines)) await tx.insert(s.orderLines).values(c);
      await tx.insert(s.locations).values(demo.locations);
      for (const c of chunks(demo.inventoryLevels)) await tx.insert(s.inventoryLevels).values(c);
      await tx.insert(s.adConnections).values(demo.adConnections);
      await tx.insert(s.adCampaigns).values(demo.adCampaigns);
      for (const c of chunks(demo.adInsights)) await tx.insert(s.adInsightsDaily).values(c);
    });
  } finally {
    await pool.end();
  }
}
