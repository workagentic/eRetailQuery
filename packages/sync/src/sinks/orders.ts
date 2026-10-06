import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NormalizedOrder } from '@erq/connectors';
import { orderLines, orders, refundLines, refunds, skuChannelListings, type Tx } from '@erq/db';
import { loadCostRows, snapshotUnitCogs, toOrgDate } from '../cogs';
import type { SinkContext, SinkResult } from './context';
import { dedupeLatest } from './util';

export async function upsertOrders(tx: Tx, ctx: SinkContext, items: NormalizedOrder[]): Promise<SinkResult> {
  const unique = dedupeLatest(items, (o) => o.externalId, (o) => o.updatedAt);
  if (unique.length === 0) return { processed: 0, skipped: 0 };

  const existing = await tx
    .select({ externalOrderId: orders.externalOrderId, externalUpdatedAt: orders.externalUpdatedAt })
    .from(orders)
    .where(and(eq(orders.storeConnectionId, ctx.connectionId), inArray(orders.externalOrderId, unique.map((o) => o.externalId))));
  const storedUpdatedAt = new Map(existing.map((e) => [e.externalOrderId, e.externalUpdatedAt]));

  const variantIds = [...new Set(unique.flatMap((o) => o.lines.flatMap((l) => (l.externalVariantId ? [l.externalVariantId] : []))))];
  const listings = variantIds.length
    ? await tx
        .select({ externalVariantId: skuChannelListings.externalVariantId, skuId: skuChannelListings.skuId })
        .from(skuChannelListings)
        .where(and(eq(skuChannelListings.storeConnectionId, ctx.connectionId), inArray(skuChannelListings.externalVariantId, variantIds)))
    : [];
  const skuByVariant = new Map(listings.map((l) => [l.externalVariantId, l.skuId]));
  const costRows = await loadCostRows(tx, [...new Set(skuByVariant.values())]);

  let processed = 0;
  let skipped = 0;
  for (const order of unique) {
    const stored = storedUpdatedAt.get(order.externalId);
    if (stored && stored > order.updatedAt) {
      skipped++;
      continue;
    }
    const refundCents = order.refunds.reduce((sum, r) => sum + r.amountCents, 0);
    const [row] = await tx
      .insert(orders)
      .values({
        orgId: ctx.orgId, storeConnectionId: ctx.connectionId, externalOrderId: order.externalId, channel: order.channel,
        status: order.status, placedAt: order.placedAt, cancelledAt: order.cancelledAt, currency: order.currency,
        grossCents: order.grossCents, discountCents: order.discountCents, shippingChargedCents: order.shippingChargedCents,
        taxCents: order.taxCents, refundCents, netCents: order.grossCents - order.discountCents - refundCents,
        customerExternalId: order.customerExternalId, utmSource: order.utmSource, utmMedium: order.utmMedium,
        utmCampaign: order.utmCampaign, landingSite: order.landingSite, isTest: order.isTest, externalUpdatedAt: order.updatedAt,
      })
      .onConflictDoUpdate({
        target: [orders.orgId, orders.storeConnectionId, orders.externalOrderId],
        set: {
          channel: sql`excluded.channel`, status: sql`excluded.status`, placedAt: sql`excluded.placed_at`,
          cancelledAt: sql`excluded.cancelled_at`, currency: sql`excluded.currency`, grossCents: sql`excluded.gross_cents`,
          discountCents: sql`excluded.discount_cents`, shippingChargedCents: sql`excluded.shipping_charged_cents`,
          taxCents: sql`excluded.tax_cents`, refundCents: sql`excluded.refund_cents`, netCents: sql`excluded.net_cents`,
          customerExternalId: sql`excluded.customer_external_id`, utmSource: sql`excluded.utm_source`,
          utmMedium: sql`excluded.utm_medium`, utmCampaign: sql`excluded.utm_campaign`, landingSite: sql`excluded.landing_site`,
          isTest: sql`excluded.is_test`, externalUpdatedAt: sql`excluded.external_updated_at`,
        },
        setWhere: sql`excluded.external_updated_at >= ${orders.externalUpdatedAt}`,
      })
      .returning({ id: orders.id });
    if (!row) {
      skipped++;
      continue;
    }

    const placedOn = toOrgDate(order.placedAt, ctx.timezone);
    const lineValues = dedupeLatest(order.lines, (l) => l.externalLineId).map((l) => {
      const skuId = l.externalVariantId ? (skuByVariant.get(l.externalVariantId) ?? null) : null;
      return {
        orgId: ctx.orgId, orderId: row.id, skuId, externalLineId: l.externalLineId, externalVariantId: l.externalVariantId,
        title: l.title, quantity: l.quantity, unitPriceCents: l.unitPriceCents, discountCents: l.discountCents,
        unitCogsCentsSnapshot: skuId ? snapshotUnitCogs(costRows.get(skuId), placedOn, order.currency) : null,
      };
    });
    if (lineValues.length > 0) {
      await tx
        .insert(orderLines)
        .values(lineValues)
        .onConflictDoUpdate({
          target: [orderLines.orgId, orderLines.orderId, orderLines.externalLineId],
          set: {
            externalVariantId: sql`excluded.external_variant_id`, title: sql`excluded.title`, quantity: sql`excluded.quantity`,
            unitPriceCents: sql`excluded.unit_price_cents`, discountCents: sql`excluded.discount_cents`,
            skuId: sql`coalesce(excluded.sku_id, ${orderLines.skuId})`,
            // A snapshot is historical: once set it never changes (repriceOrderLines is the explicit way to recompute).
            unitCogsCentsSnapshot: sql`coalesce(${orderLines.unitCogsCentsSnapshot}, excluded.unit_cogs_cents_snapshot)`,
          },
        });
    }

    if (order.refunds.length > 0) {
      const lineRows = await tx.select({ id: orderLines.id, externalLineId: orderLines.externalLineId }).from(orderLines).where(eq(orderLines.orderId, row.id));
      const lineIdByExternal = new Map(lineRows.map((l) => [l.externalLineId, l.id]));
      for (const refund of dedupeLatest(order.refunds, (r) => r.externalId)) {
        const [saved] = await tx
          .insert(refunds)
          .values({
            orgId: ctx.orgId, orderId: row.id, externalRefundId: refund.externalId, refundedAt: refund.refundedAt,
            amountCents: refund.amountCents, shippingRefundCents: refund.shippingRefundCents, restock: refund.restock,
          })
          .onConflictDoUpdate({
            target: [refunds.orgId, refunds.orderId, refunds.externalRefundId],
            set: {
              refundedAt: sql`excluded.refunded_at`, amountCents: sql`excluded.amount_cents`,
              shippingRefundCents: sql`excluded.shipping_refund_cents`, restock: sql`excluded.restock`,
            },
          })
          .returning({ id: refunds.id });
        const rl = refund.lines.flatMap((l) => {
          const orderLineId = lineIdByExternal.get(l.externalLineId);
          return orderLineId ? [{ orgId: ctx.orgId, refundId: saved!.id, orderLineId, quantity: l.quantity, amountCents: l.amountCents }] : [];
        });
        if (rl.length > 0) {
          await tx
            .insert(refundLines)
            .values(rl)
            .onConflictDoUpdate({
              target: [refundLines.orgId, refundLines.refundId, refundLines.orderLineId],
              set: { quantity: sql`excluded.quantity`, amountCents: sql`excluded.amount_cents` },
            });
        }
      }
      await tx
        .update(orderLines)
        .set({ refundedQuantity: sql`coalesce((select sum(${refundLines.quantity}) from ${refundLines} where ${refundLines.orderLineId} = ${orderLines.id}), 0)::int` })
        .where(eq(orderLines.orderId, row.id));
    }
    processed++;
  }
  return { processed, skipped };
}
