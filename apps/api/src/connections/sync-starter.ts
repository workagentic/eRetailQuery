import { Inject, Injectable } from '@nestjs/common';
import type { TenantDb } from '@erq/db';
import { enqueueSync, ordersBackfillSince } from '@erq/sync';
import { TENANT_DB } from '../db/db.module';
import type { SyncQueuePort } from './sync-queue';
import { SYNC_QUEUE_PORT } from './tokens';

export type SyncStartResult = 'started' | 'already_running' | 'unavailable';

@Injectable()
export class SyncStarter {
  constructor(
    @Inject(TENANT_DB) private readonly db: TenantDb,
    @Inject(SYNC_QUEUE_PORT) private readonly queue: SyncQueuePort,
  ) {}

  /** Starts the full resource chain. `scopes` are the stored (granted) scopes, which size the orders window. */
  async start(args: {
    orgId: string;
    connectionId: string;
    scopes: readonly string[];
    mode?: 'backfill' | 'incremental';
  }): Promise<SyncStartResult> {
    if (!this.queue.available) return 'unavailable';
    const mode = args.mode ?? 'backfill';
    const now = () => new Date();
    const result = await enqueueSync(
      { db: this.db, queue: this.queue, now },
      {
        orgId: args.orgId,
        connectionId: args.connectionId,
        resources: 'all',
        mode,
        since: mode === 'backfill' ? ordersBackfillSince(args.scopes, now()) : undefined,
      },
    );
    return result.started ? 'started' : 'already_running';
  }
}
