import type { SyncResource } from '@erq/connectors';

export type SyncMode = 'backfill' | 'incremental';

/** The rest of an `all` sync: resources run one after another in dependency order. */
export interface SyncChain {
  resources: SyncResource[];
  mode: SyncMode;
  /** ISO timestamp for backfill runs, otherwise null. */
  since: string | null;
}

/** Only ids travel through the queue. Never credentials. */
export interface SyncPageJob {
  orgId: string;
  connectionId: string;
  resource: SyncResource;
  syncRunId: string;
  then?: SyncChain;
  /** Set when the resumer re-enqueued this job: its chain is lost, so it must not record connection health. */
  resumed?: true;
}

export interface RateLimitPolicy {
  capacity: number;
  refillPerSecond: number;
  costPerPage: number;
}
export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterMs: number };
export interface RateLimiter {
  take(key: string, cost: number, policy: RateLimitPolicy): Promise<RateLimitDecision>;
}

export interface JobQueue {
  enqueue(job: SyncPageJob, opts?: { delayMs?: number }): Promise<void>;
}

export type PageResult =
  | { kind: 'next'; job: SyncPageJob }
  | { kind: 'done'; followUp?: SyncPageJob }
  | { kind: 'delayed'; delayMs: number }
  | { kind: 'failed'; reason: string };
