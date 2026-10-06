import { and, eq, inArray } from 'drizzle-orm';
import type { NormalizedProduct } from '@erq/connectors';
import { products, skuChannelListings, skuCostComponents, skus, type Tx } from '@erq/db';
import type { SinkContext, SinkResult } from './context';
import { dedupeLatest } from './util';

export async function upsertProducts(
  tx: Tx,
  ctx: SinkContext,
  items: NormalizedProduct[],
): Promise<SinkResult> {
  let processed = 0;
  let skipped = 0;
  for (const product of dedupeLatest(
    items,
    (p) => p.externalId,
    (p) => p.updatedAt,
  )) {
    if (product.variants.length === 0) {
      skipped++;
      continue;
    }
    await upsertProduct(tx, ctx, product);
    processed++;
  }
  return { processed, skipped };
}

async function upsertProduct(tx: Tx, ctx: SinkContext, product: NormalizedProduct): Promise<void> {
  const variants = dedupeLatest(
    product.variants,
    (v) => v.externalId,
    (v) => v.updatedAt,
  );
  const existing = await tx
    .select({
      externalVariantId: skuChannelListings.externalVariantId,
      skuId: skuChannelListings.skuId,
      listingUpdatedAt: skuChannelListings.externalUpdatedAt,
      productId: skus.productId,
    })
    .from(skuChannelListings)
    .innerJoin(
      skus,
      and(eq(skus.orgId, skuChannelListings.orgId), eq(skus.id, skuChannelListings.skuId)),
    )
    .where(
      and(
        eq(skuChannelListings.storeConnectionId, ctx.connectionId),
        inArray(
          skuChannelListings.externalVariantId,
          variants.map((v) => v.externalId),
        ),
      ),
    );
  const byVariant = new Map(existing.map((e) => [e.externalVariantId, e]));

  let productId: string | undefined = existing[0]?.productId;
  if (productId) {
    const newest = existing.reduce<Date | null>(
      (m, e) => (e.listingUpdatedAt && (!m || e.listingUpdatedAt > m) ? e.listingUpdatedAt : m),
      null,
    );
    if (!newest || product.updatedAt >= newest) {
      await tx
        .update(products)
        .set({
          title: product.title,
          brand: product.brand,
          category: product.category,
          status: product.status,
        })
        .where(eq(products.id, productId));
    }
  }
  const ensureProduct = async (): Promise<string> => {
    if (!productId) {
      const [created] = await tx
        .insert(products)
        .values({
          orgId: ctx.orgId,
          title: product.title,
          brand: product.brand,
          category: product.category,
          status: product.status,
        })
        .returning({ id: products.id });
      productId = created!.id;
    }
    return productId;
  };

  for (const variant of variants) {
    const listing = byVariant.get(variant.externalId);
    let skuId: string;
    if (listing) {
      skuId = listing.skuId;
      if (!listing.listingUpdatedAt || variant.updatedAt >= listing.listingUpdatedAt) {
        await tx
          .update(skus)
          .set({
            sellingPriceCents: variant.priceCents,
            compareAtPriceCents: variant.compareAtPriceCents,
            barcode: variant.barcode,
            currency: variant.currency,
          })
          .where(eq(skus.id, skuId));
        await tx
          .update(skuChannelListings)
          .set({
            channelPriceCents: variant.priceCents,
            currency: variant.currency,
            externalProductId: product.externalId,
            externalUpdatedAt: variant.updatedAt,
          })
          .where(
            and(
              eq(skuChannelListings.storeConnectionId, ctx.connectionId),
              eq(skuChannelListings.externalVariantId, variant.externalId),
            ),
          );
      }
    } else {
      const skuCode = variant.skuCode?.trim() || `shopify-${variant.externalId}`;
      const [linked] = await tx.select({ id: skus.id }).from(skus).where(eq(skus.skuCode, skuCode));
      if (linked) {
        skuId = linked.id;
      } else {
        const [created] = await tx
          .insert(skus)
          .values({
            orgId: ctx.orgId,
            productId: await ensureProduct(),
            skuCode,
            barcode: variant.barcode,
            sellingPriceCents: variant.priceCents,
            compareAtPriceCents: variant.compareAtPriceCents,
            currency: variant.currency,
          })
          .returning({ id: skus.id });
        skuId = created!.id;
      }
      await tx.insert(skuChannelListings).values({
        orgId: ctx.orgId,
        skuId,
        storeConnectionId: ctx.connectionId,
        externalProductId: product.externalId,
        externalVariantId: variant.externalId,
        channelPriceCents: variant.priceCents,
        currency: variant.currency,
        externalUpdatedAt: variant.updatedAt,
      });
    }

    if (variant.unitCostCents !== null) {
      const [hasCost] = await tx
        .select({ id: skuCostComponents.id })
        .from(skuCostComponents)
        .where(
          and(
            eq(skuCostComponents.skuId, skuId),
            eq(skuCostComponents.componentType, 'product_cost'),
          ),
        )
        .limit(1);
      if (!hasCost) {
        await tx.insert(skuCostComponents).values({
          orgId: ctx.orgId,
          skuId,
          componentType: 'product_cost',
          amountCents: variant.unitCostCents,
          perUnit: true,
          currency: variant.currency,
          effectiveFrom: ctx.costEffectiveFrom,
          effectiveTo: null,
        });
      }
    }
  }
}
