import { sql } from 'drizzle-orm';
import type { NormalizedLocation } from '@erq/connectors';
import { locations, type Tx } from '@erq/db';
import type { SinkContext, SinkResult } from './context';
import { dedupeLatest } from './util';

export async function upsertLocations(
  tx: Tx,
  ctx: SinkContext,
  items: NormalizedLocation[],
): Promise<SinkResult> {
  const unique = dedupeLatest(items, (l) => l.externalId);
  if (unique.length === 0) return { processed: 0, skipped: 0 };
  await tx
    .insert(locations)
    .values(
      unique.map((l) => ({
        orgId: ctx.orgId,
        storeConnectionId: ctx.connectionId,
        externalId: l.externalId,
        name: l.name,
        type: l.type,
        address: l.address,
        source: 'shopify' as const,
        isActive: l.isActive,
      })),
    )
    .onConflictDoUpdate({
      target: [locations.orgId, locations.storeConnectionId, locations.externalId],
      targetWhere: sql`${locations.externalId} is not null`,
      set: {
        name: sql`excluded.name`,
        type: sql`excluded.type`,
        address: sql`excluded.address`,
        isActive: sql`excluded.is_active`,
      },
    });
  return { processed: unique.length, skipped: 0 };
}
