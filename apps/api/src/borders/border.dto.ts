import { z } from 'zod';
import { DEVICE_ID_PATTERN } from '../check-in/check-in-rules.js';

const clientEventId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/);
export const borderEventType = z.enum([
  'ARRIVED',
  'CONTROL_STARTED',
  'CONTROL_COMPLETED',
  'DEPARTED',
]);
export const borderUuidSchema = z.uuid();

export const borderStaffEventSchema = z
  .object({
    clientEventId,
    routeWaypointId: z.uuid(),
    type: borderEventType,
    occurredAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
  })
  .strict();

export const borderCrewEventSchema = z
  .object({
    deviceId: z.string().trim().regex(DEVICE_ID_PATTERN).min(8),
    clientEventId,
    routeWaypointId: z.uuid(),
    type: borderEventType,
    occurredAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
  })
  .strict();
