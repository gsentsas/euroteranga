import { ApiProperty } from '@nestjs/swagger';
import { z } from 'zod';
import {
  PAYMENT_METHOD_CODES,
  PAYMENT_PROVIDER_CODES,
  PAYER_COUNTRIES,
  PRESENTMENT_CURRENCY_CODES,
} from './payment-catalog.js';

const STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;

/** An ISO 3166-1 alpha-2 code; whether it is a payer country is the service's answer. */
const countryCode = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}$/));

/**
 * The booking is in the path; the customer chooses a quote and confirms its
 * method. The amount, currency and provider come from that server-side
 * quote, never from the client. The Idempotency-Key header stays optional.
 */
export const paymentCreateSchema = z
  .object({
    quoteId: z.uuid(),
    paymentMethod: z.enum(PAYMENT_METHOD_CODES),
  })
  .strict();

export type PaymentCreate = z.infer<typeof paymentCreateSchema>;

export const paymentOptionsQuerySchema = z.object({ payerCountry: countryCode }).strict();

/** Intentions only: the server computes every amount, the currency and the rate. */
export const paymentQuoteCreateSchema = z
  .object({
    payerCountry: countryCode,
    paymentMethod: z.enum(PAYMENT_METHOD_CODES),
  })
  .strict();

export type PaymentQuoteCreate = z.infer<typeof paymentQuoteCreateSchema>;

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
    provider: z.enum(PAYMENT_PROVIDER_CODES).optional(),
    method: z.enum(PAYMENT_METHOD_CODES).optional(),
    payerCountry: z.enum(PAYER_COUNTRIES).optional(),
    currency: z.enum(PRESENTMENT_CURRENCY_CODES).optional(),
    createdFrom: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value))
      .optional(),
    createdTo: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value))
      .optional(),
    bookingReference: upperReference(16).optional(),
    paymentReference: upperReference(16).optional(),
  })
  .strict()
  .refine(
    (value) => !value.createdFrom || !value.createdTo || value.createdFrom < value.createdTo,
    {
      path: ['createdTo'],
      message: 'createdTo must follow createdFrom',
    },
  );

export type AdminPaymentListQuery = z.infer<typeof adminPaymentListQuerySchema>;

export class StaffPaymentCancelBody {
  @ApiProperty({ minLength: 3, maxLength: 500 }) reason!: string;
}

export class PaymentCreateBody {
  @ApiProperty({ format: 'uuid' }) quoteId!: string;
  @ApiProperty({ enum: PAYMENT_METHOD_CODES }) paymentMethod!: string;
}

export class PaymentQuoteCreateBody {
  @ApiProperty({ enum: PAYER_COUNTRIES }) payerCountry!: string;
  @ApiProperty({ enum: PAYMENT_METHOD_CODES }) paymentMethod!: string;
}
