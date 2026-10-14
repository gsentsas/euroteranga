import { ApiProperty } from '@nestjs/swagger';
import { z } from 'zod';

const STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;

/**
 * No business field: the booking is in the path, the amount, currency and
 * provider come from the server. The Idempotency-Key header is optional.
 */
export const paymentCreateSchema = z.object({}).strict();

export const paymentCancelSchema = z.object({}).strict();

export const staffPaymentCancelSchema = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .strict();

const upperReference = (max: number) =>
  z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().min(1).max(max));

export const adminPaymentListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.uuid().optional(),
    status: z.enum(STATUSES).optional(),
    bookingReference: upperReference(16).optional(),
    paymentReference: upperReference(16).optional(),
  })
  .strict();

export type AdminPaymentListQuery = z.infer<typeof adminPaymentListQuerySchema>;

export class StaffPaymentCancelBody {
  @ApiProperty({ minLength: 3, maxLength: 500 }) reason!: string;
}
