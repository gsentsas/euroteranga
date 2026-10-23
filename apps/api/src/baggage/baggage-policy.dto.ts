import { z } from 'zod';
import { normalizeWeightKg } from './baggage-rules.js';

const uuid = z.uuid();
const code = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().min(2).max(32).regex(/^[A-Z0-9][A-Z0-9_-]*$/));
const name = z.string().trim().min(1).max(160);
const currencyCode = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{3}$/));
const exactWeight = z.string().transform((value, context) => {
  const normalized = normalizeWeightKg(value);
  if (!normalized) {
    context.addIssue({ code: 'custom', message: 'invalid exact weight' });
    return z.NEVER;
  }
  return normalized;
});
const moneyMinor = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n, 'amount out of range');

export const baggagePolicyListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: uuid.optional(),
    active: z.enum(['true', 'false']).optional(),
  })
  .strict();

export const baggagePolicyCreateSchema = z
  .object({
    code,
    name,
    currencyCode,
    currencyMinorUnit: z.number().int().min(0).max(3),
    active: z.boolean(),
  })
  .strict();

export const baggagePolicyUpdateSchema = z
  .object({
    name: name.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'empty update' });

export const baggagePolicyVersionCreateSchema = z
  .object({
    fareTableVersionId: uuid,
    includedPieces: z.number().int().min(0).max(20),
    includedWeightKgPerPiece: exactWeight,
  })
  .strict();

export const baggagePolicyTiersSchema = z
  .object({
    tiers: z
      .array(
        z
          .object({
            code,
            label: name,
            maxExcessWeightKg: exactWeight,
            chargeMinor: moneyMinor,
            position: z.number().int().min(0).max(999),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

export const baggagePolicyPublishSchema = z.object({}).strict();

export type BaggagePolicyListQuery = z.infer<typeof baggagePolicyListQuerySchema>;
export type BaggagePolicyCreateInput = z.infer<typeof baggagePolicyCreateSchema>;
export type BaggagePolicyUpdateInput = z.infer<typeof baggagePolicyUpdateSchema>;
export type BaggagePolicyVersionCreateInput = z.infer<typeof baggagePolicyVersionCreateSchema>;
export type BaggagePolicyTiersInput = z.infer<typeof baggagePolicyTiersSchema>;
