import { z } from 'zod';
import { DEVICE_ID_PATTERN } from '../check-in/check-in-rules.js';

const clientEventId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/);

export const crewDeviceIdSchema = z.string().trim().regex(DEVICE_ID_PATTERN).min(8);

export const crewDeviceEnrollSchema = z
  .object({
    deviceId: crewDeviceIdSchema,
    label: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

export const crewDeviceRevokeSchema = z
  .object({ reason: z.string().trim().min(3).max(255) })
  .strict();

export const crewSyncSchema = z
  .object({
    deviceId: crewDeviceIdSchema,
    events: z
      .array(
        z.discriminatedUnion('type', [
          z
            .object({
              clientEventId,
              type: z.literal('PASSENGER_BOARDING'),
              occurredAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
              payload: z.object({ qrPayload: z.string().trim().min(1).max(64) }).strict(),
            })
            .strict(),
          z
            .object({
              clientEventId,
              type: z.literal('TRACKING_CHECKPOINT'),
              occurredAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
              payload: z.object({ routeWaypointId: z.uuid() }).strict(),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(25),
  })
  .strict();

export const crewAssignmentCreateSchema = z
  .object({
    crewIdentityId: z.uuid(),
    expiresAt: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value))
      .optional(),
  })
  .strict();

export const crewAssignmentRevokeSchema = z
  .object({ reason: z.string().trim().min(3).max(255) })
  .strict();
