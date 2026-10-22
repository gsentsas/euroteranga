import { z } from 'zod';

const timestamp = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

export const cargoTrackingTokenCreateSchema = z
  .object({
    expiresAt: timestamp.optional(),
  })
  .strict();

export const cargoTrackingTokenRevokeSchema = z
  .object({
    reason: z.string().trim().min(3).max(255),
  })
  .strict();

export type CargoTrackingTokenCreateInput = z.infer<typeof cargoTrackingTokenCreateSchema>;
export type CargoTrackingTokenRevokeInput = z.infer<typeof cargoTrackingTokenRevokeSchema>;
