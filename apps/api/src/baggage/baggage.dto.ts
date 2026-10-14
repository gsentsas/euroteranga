import { z } from 'zod';
import { normalizeWeightKg } from './baggage-rules.js';

export const BAGGAGE_TYPES = ['SUITCASE', 'TRAVEL_BAG', 'BOX', 'OTHER'] as const;
export const BAGGAGE_LIFECYCLES = [
  'REGISTERED',
  'CHECKED_IN',
  'LOADED',
  'IN_TRANSIT',
  'ARRIVED',
  'DELIVERED',
  'REMOVED',
] as const;
export const BAGGAGE_EXCEPTIONS = ['MISSING', 'DAMAGED', 'HELD_BY_CUSTOMS'] as const;
export const BAGGAGE_OPERATIONAL_EVENTS = [
  'CHECKED_IN',
  'LOADED',
  'IN_TRANSIT',
  'ARRIVED',
  'DELIVERED',
  'MISSING',
  'DAMAGED',
  'HELD_BY_CUSTOMS',
  'EXCEPTION_RESOLVED',
  'REMOVED',
] as const;

const reference = (prefix: 'ETB' | 'ETV' | 'ETG') =>
  z
    .string()
    .trim()
    .toUpperCase()
    .regex(new RegExp(`^${prefix}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$`));
const occurredAt = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const clientEventId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/)
  .optional();

export const baggageRegistrationSchema = z.object({ type: z.enum(BAGGAGE_TYPES) }).strict();

export const adminBaggageRegistrationSchema = z
  .object({
    bookingReference: reference('ETB'),
    passengerReference: reference('ETV'),
    type: z.enum(BAGGAGE_TYPES),
  })
  .strict();

const idempotentEventFields = z
  .object({
    occurredAt: occurredAt.optional(),
    routeWaypointId: z.uuid().nullable().optional(),
    clientEventId,
  })
  .refine((value) => !value.clientEventId || value.occurredAt, {
    path: ['occurredAt'],
    message: 'occurredAt is required with clientEventId',
  });

export const baggageWeightSchema = idempotentEventFields
  .safeExtend({
    measuredWeightKg: z.string().transform((value, context) => {
      const normalized = normalizeWeightKg(value);
      if (!normalized) {
        context.addIssue({ code: 'custom', message: 'invalid exact weight' });
        return z.NEVER;
      }
      return normalized;
    }),
  })
  .strict();

export const baggageEventSchema = idempotentEventFields
  .safeExtend({ type: z.enum(BAGGAGE_OPERATIONAL_EVENTS) })
  .strict();

export const baggageScanSchema = baggageEventSchema
  .safeExtend({ qrPayload: z.string().trim().min(1).max(64) })
  .strict();

export const baggageQrResolveSchema = z
  .object({ qrPayload: z.string().trim().min(1).max(64) })
  .strict();

export const baggageListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.uuid().optional(),
    reference: reference('ETG').optional(),
    bookingReference: reference('ETB').optional(),
    passengerReference: reference('ETV').optional(),
    tripReference: z.string().trim().toUpperCase().max(32).optional(),
    type: z.enum(BAGGAGE_TYPES).optional(),
    lifecycleStatus: z.enum(BAGGAGE_LIFECYCLES).optional(),
    exceptionStatus: z.enum(BAGGAGE_EXCEPTIONS).optional(),
    createdFrom: occurredAt.optional(),
    createdTo: occurredAt.optional(),
  })
  .strict()
  .refine(
    (value) => !value.createdFrom || !value.createdTo || value.createdFrom < value.createdTo,
    { path: ['createdTo'], message: 'createdTo must follow createdFrom' },
  );

export type BaggageRegistration = z.infer<typeof baggageRegistrationSchema>;
export type AdminBaggageRegistration = z.infer<typeof adminBaggageRegistrationSchema>;
export type BaggageWeightInput = z.infer<typeof baggageWeightSchema>;
export type BaggageEventInput = z.infer<typeof baggageEventSchema>;
export type BaggageScanInput = z.infer<typeof baggageScanSchema>;
export type BaggageListQuery = z.infer<typeof baggageListQuerySchema>;
