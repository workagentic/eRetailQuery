export interface SinkContext {
  orgId: string;
  connectionId: string;
  syncRunId: string;
  /** IANA timezone of the org; order dates for cost snapshots are computed in it. */
  timezone: string;
  now: Date;
  /** YYYY-MM-DD: effective_from for product costs imported from the platform. */
  costEffectiveFrom: string;
}

export interface SinkResult {
  /** Items applied (inserted or updated). */
  processed: number;
  /** Items that could not be applied (unmapped references) or were stale. */
  skipped: number;
}
