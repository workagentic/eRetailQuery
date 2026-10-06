import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NormalizedInventoryLevel } from '@erq/connectors';
import { inventoryLevels, inventoryMovements, locations, skuChannelListings, type Tx } from '@erq/db';
import type { SinkContext, SinkResult } from './context';
import { dedupeLatest } from './util';

export async function upsertInventory(tx: Tx, ctx: SinkContext, items: NormalizedInventoryLevel[]): Promise<SinkResult> {
  const unique = dedupeLatest(items, (i) => `${i.externalVariantId}@${i.locationExternalId}`, (i) => i.updatedAt);
  if (unique.length === 0) return { processed: 0, skipped: 0 };

  const variantIds = [...new Set(unique.map((i) => i.externalVariantId))];
  const locationIds = [...new Set(unique.map((i) => i.locationExternalId))];
  const listings = await tx
    .select({ externalVariantId: skuChannelListings.externalVariantId, skuId: skuChannelListings.skuId })
    .from(skuChannelListings)
    .where(and(eq(skuChannelListings.storeConnectionId, ctx.connectionId), inArray(skuChannelListings.externalVariantId, variantIds)));
  const locs = await tx
    .select({ externalId: locations.externalId, id: locations.id })
    .from(locations)
    .where(and(eq(locations.storeConnectionId, ctx.connectionId), inArray(locations.externalId, locationIds)));
  const skuByVariant = new Map(listings.map((l) => [l.externalVariantId, l.skuId]));
  const locByExternal = new Map(locs.flatMap((l) => (l.externalId ? [[l.externalId, l.id] as const] : [])));

  const skuIds = [...new Set(skuByVariant.values())];
  const locIds = [...new Set(locByExternal.values())];
  const existing =
    skuIds.length && locIds.length
      ? await tx
          .select({ skuId: inventoryLevels.skuId, locationId: inventoryLevels.locationId, onHand: inventoryLevels.onHand, updatedAt: inventoryLevels.externalUpdatedAt })
          .from(inventoryLevels)
          .where(and(inArray(inventoryLevels.skuId, skuIds), inArray(inventoryLevels.locationId, locIds)))
      : [];
  const existingByKey = new Map(existing.map((e) => [`${e.skuId}:${e.locationId}`, e]));

  let processed = 0;
  let skipped = 0;
  for (const item of unique) {
    const skuId = skuByVariant.get(item.externalVariantId);
    const locationId = locByExternal.get(item.locationExternalId);
    if (!skuId || !locationId) {
      skipped++;
      continue;
    }
    const prev = existingByKey.get(`${skuId}:${locationId}`);
    if (prev?.updatedAt && prev.updatedAt > item.updatedAt) {
      skipped++;
      continue;
    }
    await tx
      .insert(inventoryLevels)
      .values({
        orgId: ctx.orgId, skuId, locationId, onHand: item.onHand, reserved: item.reserved, incoming: item.incoming,
        externalUpdatedAt: item.updatedAt,
      })
      .onConflictDoUpdate({
        target: [inventoryLevels.orgId, inventoryLevels.skuId, inventoryLevels.locationId],
        set: {
          onHand: sql`excluded.on_hand`, reserved: sql`excluded.reserved`, incoming: sql`excluded.incoming`,
          externalUpdatedAt: sql`excluded.external_updated_at`,
        },
      });
    const delta = item.onHand - (prev?.onHand ?? 0);
    if (delta !== 0) {
      await tx
        .insert(inventoryMovements)
        .values({
          orgId: ctx.orgId, skuId, locationId, delta, reason: 'sync_correction', refType: 'sync',
          refId: `${ctx.syncRunId}:${item.updatedAt.toISOString()}`, occurredAt: item.updatedAt,
        })
        .onConflictDoNothing();
    }
    processed++;
  }
  return { processed, skipped };
}
