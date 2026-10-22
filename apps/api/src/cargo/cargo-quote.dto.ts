import { z } from 'zod';

const amountMinor = z.string().regex(/^[1-9][0-9]{0,17}$/);
const expectedUpdatedAt = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

export const cargoQuoteLineSchema = z
  .object({
    kind: z.enum(['CHARGE', 'DISCOUNT']),
    label: z.string().trim().min(1).max(160),
    amountMinor,
    notes: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const lines = z.array(cargoQuoteLineSchema).min(1).max(100);

export const cargoQuoteCreateSchema = z
  .object({
    currencyCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/),
    currencyMinorUnit: z.coerce.number().int().min(0).max(3),
    lines,
  })
  .strict();

export const cargoQuoteLinesSchema = z
  .object({
    lines,
    expectedUpdatedAt: expectedUpdatedAt.optional(),
  })
  .strict();

export const cargoQuoteTransitionSchema = z
  .object({ expectedUpdatedAt: expectedUpdatedAt.optional() })
  .strict();

export const cargoQuoteCancelSchema = z
  .object({
    expectedUpdatedAt: expectedUpdatedAt.optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export type CargoQuoteCreateInput = z.infer<typeof cargoQuoteCreateSchema>;
export type CargoQuoteLinesInput = z.infer<typeof cargoQuoteLinesSchema>;
export type CargoQuoteTransitionInput = z.infer<typeof cargoQuoteTransitionSchema>;
export type CargoQuoteCancelInput = z.infer<typeof cargoQuoteCancelSchema>;
