import { z } from 'zod';
import { normalizeCargoWeightKg } from './cargo-rules.js';

export const CARGO_DIRECTIONS = ['PAR_DKR', 'DKR_PAR'] as const;
export const CARGO_LIFECYCLES = [
  'QUOTE',
  'BOOKED',
  'RECEIVED',
  'INSPECTED',
  'ASSIGNED',
  'LOADED',
  'DEPARTED',
  'IN_TRANSIT',
  'ARRIVED',
  'AVAILABLE',
  'DELIVERED',
  'REFUSED',
  'CANCELLED',
] as const;
export const CARGO_EXCEPTIONS = ['HELD', 'CUSTOMS_HOLD', 'DAMAGED'] as const;
export const CARGO_OPERATIONAL_EVENTS = [
  'BOOKED',
  'RECEIVED',
  'INSPECTED',
  'LOADED',
  'DEPARTED',
  'IN_TRANSIT',
  'ARRIVED',
  'AVAILABLE',
  'DELIVERED',
  'REFUSED',
  'CANCELLED',
  'HELD',
  'CUSTOMS_HOLD',
  'DAMAGED',
  'EXCEPTION_RESOLVED',
] as const;

const bookingReference = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^ETB-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/);
const customerIdentityId = z.uuid();
const tripReference = z.string().trim().toUpperCase().min(1).max(32);
const vehicleCode = z.string().trim().toUpperCase().min(1).max(32);
const occurredAt = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const expectedAt = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const clientEventId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/)
  .optional();
const weightKg = z.string().transform((value, context) => {
  const normalized = normalizeCargoWeightKg(value);
  if (!normalized) {
    context.addIssue({ code: 'custom', message: 'invalid exact weight' });
    return z.NEVER;
  }
  return normalized;
});
const dimensionsCm = z
  .object({
    length: z.coerce.number().int().min(1).max(2000),
    width: z.coerce.number().int().min(1).max(2000),
    height: z.coerce.number().int().min(1).max(2000),
  })
  .strict();
const declaredValue = z
  .object({
    amountMinor: z.string().regex(/^(0|[1-9][0-9]{0,17})$/),
    currencyCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/),
    currencyMinorUnit: z.coerce.number().int().min(0).max(3),
  })
  .strict();

const cargoEditable = {
  senderName: z.string().trim().min(1).max(160),
  senderContact: z.string().trim().min(1).max(200),
  recipientName: z.string().trim().min(1).max(160),
  recipientContact: z.string().trim().min(1).max(200),
  weightKg,
  volumeLiters: z.coerce.number().int().min(1).max(1_000_000),
  packageCount: z.coerce.number().int().min(1).max(9_999),
  dimensionsCm: dimensionsCm.nullable().optional(),
  declaredContents: z.string().trim().min(1).max(500),
  declaredValue: declaredValue.nullable().optional(),
  fragile: z.boolean(),
  professional: z.boolean(),
  pickupRequired: z.boolean(),
  deliveryRequired: z.boolean(),
} as const;

export const cargoCreateSchema = z
  .object({
    direction: z.enum(CARGO_DIRECTIONS),
    bookingReference: bookingReference.optional(),
    customerIdentityId: customerIdentityId.optional(),
    ...cargoEditable,
  })
  .strict();

export const cargoUpdateSchema = z
  .object({
    senderName: cargoEditable.senderName.optional(),
    senderContact: cargoEditable.senderContact.optional(),
    recipientName: cargoEditable.recipientName.optional(),
    recipientContact: cargoEditable.recipientContact.optional(),
    weightKg: cargoEditable.weightKg.optional(),
    volumeLiters: cargoEditable.volumeLiters.optional(),
    packageCount: cargoEditable.packageCount.optional(),
    dimensionsCm: cargoEditable.dimensionsCm,
    declaredContents: cargoEditable.declaredContents.optional(),
    declaredValue: cargoEditable.declaredValue,
    fragile: cargoEditable.fragile.optional(),
    professional: cargoEditable.professional.optional(),
    pickupRequired: cargoEditable.pickupRequired.optional(),
    deliveryRequired: cargoEditable.deliveryRequired.optional(),
    expectedUpdatedAt: expectedAt.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'expectedUpdatedAt'), {
    message: 'at least one cargo field must change',
  });

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

export const cargoEventSchema = idempotentEventFields
  .safeExtend({ type: z.enum(CARGO_OPERATIONAL_EVENTS) })
  .strict();

export const cargoQrResolveSchema = z
  .object({ qrPayload: z.string().trim().min(1).max(64) })
  .strict();

export const cargoScanSchema = cargoEventSchema
  .safeExtend({ qrPayload: z.string().trim().min(1).max(64) })
  .strict();

export const cargoAssignmentSchema = z
  .object({
    tripReference,
    vehicleCode,
    occurredAt: occurredAt.optional(),
    expectedTripReference: tripReference.nullable().optional(),
    expectedVehicleCode: vehicleCode.nullable().optional(),
  })
  .strict();

export const cargoListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.uuid().optional(),
    reference: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^ETC-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/)
      .optional(),
    bookingReference: bookingReference.optional(),
    tripReference: tripReference.optional(),
    vehicleCode: vehicleCode.optional(),
    direction: z.enum(CARGO_DIRECTIONS).optional(),
    lifecycleStatus: z.enum(CARGO_LIFECYCLES).optional(),
    exceptionStatus: z.enum(CARGO_EXCEPTIONS).optional(),
    createdFrom: occurredAt.optional(),
    createdTo: occurredAt.optional(),
  })
  .strict()
  .refine(
    (value) => !value.createdFrom || !value.createdTo || value.createdFrom < value.createdTo,
    { path: ['createdTo'], message: 'createdTo must follow createdFrom' },
  );

export type CargoCreateInput = z.infer<typeof cargoCreateSchema>;
export type CargoUpdateInput = z.infer<typeof cargoUpdateSchema>;
export type CargoEventInput = z.infer<typeof cargoEventSchema>;
export type CargoScanInput = z.infer<typeof cargoScanSchema>;
export type CargoAssignmentInput = z.infer<typeof cargoAssignmentSchema>;
export type CargoListQuery = z.infer<typeof cargoListQuerySchema>;
