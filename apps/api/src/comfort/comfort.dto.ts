import { z } from 'zod';

const clientEventId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/);

export const comfortUuidSchema = z.uuid();

export const comfortEventTypeSchema = z.enum(['CONFIRMED', 'COMPLETED', 'CANCELLED', 'SKIPPED']);

export const comfortFacilitySchema = z.enum([
  'RESTROOM',
  'SHOWER',
  'FOOD',
  'SECURE_PARKING',
  'FUEL',
]);

export const comfortEventSchema = z
  .object({
    clientEventId,
    routeWaypointId: z.uuid(),
    type: comfortEventTypeSchema,
    occurredAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
    actualFacilities: z.array(comfortFacilitySchema).max(5).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.actualFacilities).size !== value.actualFacilities.length) {
      context.addIssue({
        code: 'custom',
        path: ['actualFacilities'],
        message: 'duplicate facility',
      });
    }
    if (value.type !== 'COMPLETED' && value.actualFacilities.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['actualFacilities'],
        message: 'actual facilities require a completed waypoint',
      });
    }
  });
