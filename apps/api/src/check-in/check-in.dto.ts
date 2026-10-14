import { z } from 'zod';
import { DEVICE_ID_PATTERN, SEAT_LABEL_PATTERN } from './check-in-rules.js';

const reference = (prefix: 'ETB' | 'ETV') =>
  z
    .string()
    .trim()
    .toUpperCase()
    .regex(new RegExp(`^${prefix}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$`));

/** Only the label of a seat already booked on the same booking. */
export const seatAssignmentSchema = z
  .object({ seatLabel: z.string().trim().toUpperCase().regex(SEAT_LABEL_PATTERN) })
  .strict();

/**
 * Check-in takes no input: every gate is derived on the server. Any status,
 * actor, compliance or override field is refused by the strict schema.
 */
export const checkInSchema = z.object({}).strict();

export const boardingResolveSchema = z
  .object({ qrPayload: z.string().trim().min(1).max(64) })
  .strict();

export const boardingScanSchema = z
  .object({
    qrPayload: z.string().trim().min(1).max(64),
    deviceId: z.string().trim().regex(DEVICE_ID_PATTERN),
    clientEventId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/)
      .optional(),
    occurredAt: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value))
      .optional(),
  })
  .strict()
  .refine((value) => !value.clientEventId || value.occurredAt, {
    path: ['occurredAt'],
    message: 'occurredAt is required with clientEventId',
  });

export const CHECK_IN_FILTER_STATUSES = ['CHECKED_IN', 'NOT_CHECKED_IN'] as const;
export const BOARDING_FILTER_STATUSES = ['BOARDED', 'NOT_BOARDED'] as const;

export const checkInListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(25).default(25),
    /** Opaque keyset cursor: "<bookingId>.<passengerId>" of the last row. */
    cursor: z
      .string()
      .regex(/^[0-9a-f-]{36}\.[0-9a-f-]{36}$/)
      .optional(),
    tripReference: z.string().trim().toUpperCase().max(32).optional(),
    bookingReference: reference('ETB').optional(),
    passengerReference: reference('ETV').optional(),
    checkInStatus: z.enum(CHECK_IN_FILTER_STATUSES).optional(),
    boardingStatus: z.enum(BOARDING_FILTER_STATUSES).optional(),
  })
  .strict();

export type SeatAssignmentInput = z.infer<typeof seatAssignmentSchema>;
export type BoardingScanInput = z.infer<typeof boardingScanSchema>;
export type CheckInListQuery = z.infer<typeof checkInListQuerySchema>;
