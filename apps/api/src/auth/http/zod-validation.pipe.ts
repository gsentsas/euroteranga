import { type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { AuthErrors } from './public-api-error.js';

/**
 * Validates a request body with a zod schema. The error lists field names
 * only; submitted values (passwords, tokens) are never echoed.
 */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))].filter(
        Boolean,
      );
      throw AuthErrors.validation(fields);
    }
    return result.data;
  }
}
