import { z } from 'zod';

export const financeRevenueTypeSchema = z.enum(['BAGGAGE', 'OPTION', 'OTHER']);
export const financeExpenseTypeSchema = z.enum([
  'FUEL',
  'FERRY',
  'TOLL',
  'CREW',
  'HOTEL',
  'MAINTENANCE',
  'BORDER',
  'INSURANCE',
  'OTHER',
]);

const amountMinor = z.string().regex(/^[1-9][0-9]{0,17}$/);
const currencyCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/)
  .transform((value) => value.toUpperCase());
const occurredAt = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const tripReference = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .transform((value) => value.toUpperCase());
const clientId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/);

export const tripFinanceReferenceSchema = tripReference;

export const revenueCreateSchema = z
  .object({
    type: financeRevenueTypeSchema,
    amountMinor,
    currencyCode,
    currencyMinorUnit: z.number().int().min(0).max(3),
    description: z.string().trim().min(3).max(500),
    occurredAt,
    baggageReference: z
      .string()
      .trim()
      .regex(/^ETG-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/)
      .transform((value) => value.toUpperCase())
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.type === 'BAGGAGE' && !value.baggageReference) {
      context.addIssue({ code: 'custom', path: ['baggageReference'], message: 'required' });
    }
    if (value.type !== 'BAGGAGE' && value.baggageReference) {
      context.addIssue({ code: 'custom', path: ['baggageReference'], message: 'not allowed' });
    }
  })
  .strict();

export const expenseCreateSchema = z
  .object({
    type: financeExpenseTypeSchema,
    amountMinor,
    currencyCode,
    currencyMinorUnit: z.number().int().min(0).max(3),
    description: z.string().trim().min(3).max(500),
    vendorLabel: z.string().trim().min(1).max(160).optional(),
    occurredAt,
  })
  .strict();

export const financeVoidSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

export const refundCreateSchema = z
  .object({
    clientRefundId: clientId,
    amountMinor,
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export const payoutCreateSchema = z
  .object({
    clientPayoutId: clientId,
    amountMinor,
    paidAt: occurredAt,
    note: z.string().trim().min(3).max(500).optional(),
  })
  .strict();

export const paymentReferenceSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => /^ETP-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/.test(value));

export const revenueReferenceSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => /^ETFR-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/.test(value));

export const expenseReferenceSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => /^ETFE-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/.test(value));

export const financeReceiptIdSchema = z.uuid();
