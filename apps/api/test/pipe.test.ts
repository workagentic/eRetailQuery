import { describe, expect, it } from 'vitest';
import { createOrgInput } from '@erq/shared';
import { ApiError } from '../src/common/api-error';
import { ZodValidationPipe } from '../src/common/zod-validation.pipe';

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(createOrgInput);
  it('returns parsed data', () => {
    expect(pipe.transform({ name: ' Acme ' })).toEqual({ name: 'Acme' });
  });
  it('throws a 400 ApiError with flattened details', () => {
    try {
      pipe.transform({ name: '' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).getStatus()).toBe(400);
      expect((e as ApiError).code).toBe('validation_failed');
    }
  });
  it('handles undefined bodies', () => {
    expect(() => pipe.transform(undefined)).toThrow(ApiError);
  });
});
