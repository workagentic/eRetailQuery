/** The platform asked us to slow down. The job is re-queued after `retryAfterMs`; no attempt is consumed. */
export class RateLimitedError extends Error {
  override name = 'RateLimitedError';
  constructor(
    readonly retryAfterMs: number,
    message = 'rate limited',
  ) {
    super(message);
    if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) {
      throw new RangeError(`retryAfterMs must be a non-negative number, got ${retryAfterMs}`);
    }
  }
}
/** A retryable failure (network, 5xx). The queue retries with exponential backoff. */
export class TransientError extends Error {
  override name = 'TransientError';
}
/** The stored credentials no longer work. The connection is marked as errored; the owner must reconnect. */
export class AuthError extends Error {
  override name = 'AuthError';
}
/** A failure that retrying cannot fix. The run is marked failed. */
export class PermanentError extends Error {
  override name = 'PermanentError';
}
