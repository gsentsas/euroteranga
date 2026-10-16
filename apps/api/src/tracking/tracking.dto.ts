import { z } from 'zod';

export const trackingUuidSchema = z.string().uuid();
const uuid = trackingUuidSchema;
const clientEventId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/);
const timestamp = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));

export const trackingVisibilitySchema = z.enum([
  'HIDDEN',
  'CHECKPOINT_ONLY',
  'APPROXIMATE',
  'PRECISE',
]);

export const trackingDeviceCreateSchema = z
  .object({
    vehicleId: uuid,
    providerKey: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .transform((value) => value.toUpperCase())
      .pipe(z.string().regex(/^[A-Z][A-Z0-9_.-]{1,63}$/)),
    externalId: z.string().trim().min(1).max(128),
  })
  .strict();

export const trackingConfigSchema = z
  .object({
    enabled: z.boolean(),
    visibility: trackingVisibilitySchema,
    trackingDeviceId: uuid.nullable(),
  })
  .strict();

export const trackingObservationSchema = z
  .object({
    source: z.enum(['CHECKPOINT', 'OPS']),
    clientEventId: clientEventId.optional(),
    observedAt: timestamp,
    routeWaypointId: uuid.optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    accuracyMeters: z.number().min(0).max(999999).optional(),
    speedKph: z.number().min(0).max(999999).optional(),
    headingDegrees: z.number().min(0).lt(360).optional(),
    label: z.string().trim().min(1).max(160).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.latitude === undefined) !== (value.longitude === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['latitude'],
        message: 'latitude and longitude must be supplied together',
      });
    }
    if (value.source === 'CHECKPOINT' && !value.routeWaypointId) {
      context.addIssue({
        code: 'custom',
        path: ['routeWaypointId'],
        message: 'routeWaypointId is required for CHECKPOINT',
      });
    }
  });

export const trackingCrewCheckpointSchema = z
  .object({
    deviceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/),
    clientEventId,
    routeWaypointId: uuid,
    occurredAt: timestamp,
  })
  .strict();

export const trackingTokenIssueSchema = z.object({ expiresAt: timestamp.optional() }).strict();

export const trackingTokenRevokeSchema = z
  .object({ reason: z.string().trim().min(3).max(255) })
  .strict();
