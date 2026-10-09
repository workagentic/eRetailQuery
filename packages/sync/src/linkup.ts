import { and, eq, isNull } from 'drizzle-orm';
import { orderLines, orders, orgs, skuChannelListings, type TenantDb, type Tx } from '@erq/db';
import { loadCostRows, snapshotUnitCogs, toOrgDate } from './cogs';

export const LINKUP_BATCH_SIZE = 500;
/** 200 batches of 500 lines is 100 000 lines per call; the rest waits for the next products run. */
export const LINKUP_MAX_BATCHES = 200;

async function linkBatch(
  tx: Tx,
  args: { orgId: string; connectionId: string },
  batchSize: number,
): Promise<number> {
  const [org] = await tx
    .select({ timezone: orgs.timezone })
    .from(orgs)
    .where(eq(orgs.id, args.orgId));
  if (!org) return 0;
  const candidates = await tx
    .select({
      lineId: orderLines.id,
      skuId: skuChannelListings.skuId,
      snapshot: orderLines.unitCogsCentsSnapshot,
      placedAt: orders.placedAt,
      currency: orders.currency,
    })
    .from(orderLines)
    .innerJoin(orders, and(eq(orders.orgId, orderLines.orgId), eq(orders.id, orderLines.orderId)))
    .innerJoin(
      skuChannelListings,
      and(
        eq(skuChannelListings.orgId, orders.orgId),
        eq(skuChannelListings.storeConnectionId, orders.storeConnectionId),
        eq(skuChannelListings.externalVariantId, orderLines.externalVariantId),
      ),
    )
    .where(
      and(
        eq(orders.orgId, args.orgId),
        eq(orders.storeConnectionId, args.connectionId),
        isNull(orderLines.skuId),
      ),
    )
    .orderBy(orderLines.id)
    .limit(batchSize);
  if (candidates.length === 0) return 0;
  const costRows = await loadCostRows(tx, [...new Set(candidates.map((c) => c.skuId))]);
  let linked = 0;
  for (const c of candidates) {
    // The snapshot is historical: an existing one wins; otherwise the cost in effect on the ORDER date.
    const snapshot =
      c.snapshot ??
      snapshotUnitCogs(
        costRows.get(c.skuId),
        toOrgDate(c.placedAt, org.timezone),
        c.currency.trim(),
      );
    const updated = await tx
      .update(orderLines)
      .set({ skuId: c.skuId, unitCogsCentsSnapshot: snapshot })
      // The sku_id IS NULL guard makes a concurrent writer's link win instead of being overwritten.
      .where(
        and(
          eq(orderLines.orgId, args.orgId),
          eq(orderLines.id, c.lineId),
          isNull(orderLines.skuId),
        ),
      )
      .returning({ id: orderLines.id });
    linked += updated.length;
  }
  return linked;
}

/**
 * Links order lines that were imported before their variant existed. Set-based and idempotent; each batch is
 * its own tenant transaction so no long transaction holds locks; ends when a batch is not full (which also
 * ends a call that makes no progress) or after `maxBatches`.
 */
export async function linkOrderLines(
  db: Pick<TenantDb, 'withTenant'>,
  args: { orgId: string; connectionId: string },
  opts: { batchSize?: number; maxBatches?: number } = {},
): Promise<{ linked: number }> {
  const batchSize = opts.batchSize ?? LINKUP_BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? LINKUP_MAX_BATCHES;
  let linked = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const n = await db.withTenant(args.orgId, (tx) => linkBatch(tx, args, batchSize));
    linked += n;
    if (n < batchSize) break;
  }
  return { linked };
}
