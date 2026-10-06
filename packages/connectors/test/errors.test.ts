import { describe, expect, it } from 'vitest';
import { AuthError, PermanentError, RateLimitedError, TransientError } from '../src/errors';

describe('typed errors', () => {
  it('carry names, messages and are distinguishable with instanceof', () => {
    const rl = new RateLimitedError(1500);
    expect(rl).toBeInstanceOf(Error);
    expect(rl).toBeInstanceOf(RateLimitedError);
    expect(rl).not.toBeInstanceOf(TransientError);
    expect(rl.retryAfterMs).toBe(1500);
    expect(rl.name).toBe('RateLimitedError');
    expect(new TransientError('boom').message).toBe('boom');
    expect(new AuthError('revoked')).toBeInstanceOf(Error);
    expect(new PermanentError('bad').name).toBe('PermanentError');
  });
  it('rejects a negative or non-finite retry-after', () => {
    expect(() => new RateLimitedError(-1)).toThrow(RangeError);
    expect(() => new RateLimitedError(Number.NaN)).toThrow(RangeError);
  });
});
