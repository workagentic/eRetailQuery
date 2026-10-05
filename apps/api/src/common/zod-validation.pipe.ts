import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { ApiError } from './api-error';

export class ZodValidationPipe<T extends z.ZodTypeAny> implements PipeTransform<
  unknown,
  z.infer<T>
> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ApiError(
        400,
        'validation_failed',
        'Request validation failed',
        result.error.flatten(),
      );
    }
    return result.data;
  }
}
