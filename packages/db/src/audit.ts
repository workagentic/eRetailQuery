import { auditLog } from './schema';
import type { Tx } from './tenant-db';

export interface AuditEntry {
  orgId: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
}

export async function insertAudit(tx: Tx, e: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    orgId: e.orgId,
    actorUserId: e.actorUserId,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    beforeJson: e.before ?? null,
    afterJson: e.after ?? null,
  });
}
