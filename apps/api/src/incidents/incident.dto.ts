import { z } from 'zod';
import { DEVICE_ID_PATTERN } from '../check-in/check-in-rules.js';
import { INCIDENT_REFERENCE_PATTERN } from './incident-rules.js';

export const incidentTypeSchema = z.enum([
  'BREAKDOWN',
  'ACCIDENT',
  'DELAY',
  'BORDER',
  'CUSTOMS',
  'POLICE',
  'PASSENGER',
  'HEALTH',
  'BAGGAGE',
  'SECURITY',
  'WEATHER',
  'FERRY',
  'OTHER',
]);
export const incidentSeveritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const incidentStatusSchema = z.enum([
  'OPEN',
  'ASSESSING',
  'ACTION_REQUIRED',
  'MITIGATING',
  'RESOLVED',
  'CLOSED',
]);
export const incidentActionTypeSchema = z.enum([
  'NOTE',
  'ACTION_PLAN',
  'MITIGATION',
  'PASSENGERS_INFORMED',
  'POSTMORTEM',
]);

const clientId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/);
const tripReference = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .transform((value) => value.toUpperCase());
const baggageReference = z
  .string()
  .trim()
  .regex(/^ETG-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/)
  .transform((value) => value.toUpperCase());
const description = z.string().trim().min(10).max(2000);
const locationLabel = z.string().trim().min(1).max(160);

export const incidentOpenStaffSchema = z
  .object({
    tripReference,
    clientEventId: clientId,
    type: incidentTypeSchema,
    severity: incidentSeveritySchema,
    description,
    openedAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
    routeWaypointId: z.uuid().optional(),
    locationLabel: locationLabel.optional(),
    baggageReference: baggageReference.optional(),
    ownerIdentityId: z.uuid().optional(),
  })
  .superRefine((value, context) => {
    if (value.type === 'BAGGAGE' && !value.baggageReference) {
      context.addIssue({ code: 'custom', path: ['baggageReference'], message: 'required' });
    }
    if (value.type !== 'BAGGAGE' && value.baggageReference) {
      context.addIssue({ code: 'custom', path: ['baggageReference'], message: 'not allowed' });
    }
  });

export const incidentCrewReportSchema = z
  .object({
    deviceId: z.string().trim().regex(DEVICE_ID_PATTERN).min(8),
    clientEventId: clientId,
    type: incidentTypeSchema,
    severity: incidentSeveritySchema,
    description,
    openedAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
    routeWaypointId: z.uuid().optional(),
    locationLabel: locationLabel.optional(),
    baggageReference: baggageReference.optional(),
  })
  .superRefine((value, context) => {
    if (value.type === 'BAGGAGE' && !value.baggageReference) {
      context.addIssue({ code: 'custom', path: ['baggageReference'], message: 'required' });
    }
    if (value.type !== 'BAGGAGE' && value.baggageReference) {
      context.addIssue({ code: 'custom', path: ['baggageReference'], message: 'not allowed' });
    }
  });

export const incidentActionSchema = z
  .object({
    clientActionId: clientId,
    type: incidentActionTypeSchema,
    content: z.string().trim().min(3).max(2000),
  })
  .strict();

export const incidentTransitionSchema = z
  .object({
    status: incidentStatusSchema,
    expectedStatus: incidentStatusSchema.optional(),
  })
  .strict();

export const incidentOwnerSchema = z
  .object({
    ownerIdentityId: z.uuid().nullable(),
    reason: z.string().trim().min(3).max(255),
  })
  .strict();

export const incidentListQuerySchema = z
  .object({
    status: incidentStatusSchema.optional(),
    severity: incidentSeveritySchema.optional(),
    type: incidentTypeSchema.optional(),
    tripReference: tripReference.optional(),
    ownerIdentityId: z.uuid().optional(),
    cursor: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const incidentAttachmentIdSchema = z.uuid();

export const incidentReferenceSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => INCIDENT_REFERENCE_PATTERN.test(value), 'invalid incident reference');
