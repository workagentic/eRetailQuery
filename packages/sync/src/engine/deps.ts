import type { ConnectorRegistry } from '@erq/connectors';
import type { TenantDb } from '@erq/db';
import type { KeyProvider } from '@erq/shared';
import type { JobQueue, RateLimitPolicy, RateLimiter } from '../ports';

export interface SyncDeps {
  db: TenantDb;
  connectors: ConnectorRegistry;
  limiter: RateLimiter;
  queue: JobQueue;
  keyProvider: KeyProvider;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Per-platform rate-limit overrides. */
  policies?: Record<string, RateLimitPolicy>;
}

export const nowOf = (deps: Pick<SyncDeps, 'now'>): Date => (deps.now ?? (() => new Date()))();
