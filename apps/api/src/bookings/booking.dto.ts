import { ApiProperty } from '@nestjs/swagger';
import { z } from 'zod';

const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const STATUSES = ['HELD', 'CONFIRMED', 'EXPIRED', 'CANCELLED'] as const;

export interface SearchCursor {
  departureAt: Date;
  tripId: string;
  originRouteWaypointId: string;
  destinationRouteWaypointId: string;
}

/** Opaque keyset cursor of the public search (base64url JSON, validated). */
export function encodeSearchCursor(cursor: SearchCursor): string {
  return Buffer.from(
    JSON.stringify([
      cursor.departureAt.toISOString(),
      cursor.tripId,
      cursor.originRouteWaypointId,
      cursor.destinationRouteWaypointId,
    ]),
  ).toString('base64url');
}

const searchCursorTuple = z.tuple([z.iso.datetime({ offset: true }), uuid, uuid, uuid]);

const searchCursor = z
  .string()
  .max(400)
  .transform((value, context): SearchCursor => {
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    } catch {
      decoded = null;
    }
    const parsed = searchCursorTuple.safeParse(decoded);
    if (!parsed.success) {
      context.addIssue({ code: 'custom', message: 'invalid cursor' });
      return z.NEVER;
    }
    const [departureAt, tripId, originRouteWaypointId, destinationRouteWaypointId] = parsed.data;
    return {
      departureAt: new Date(departureAt),
      tripId,
      originRouteWaypointId,
      destinationRouteWaypointId,
    };
  });

export const publicStopsQuerySchema = z
  .object({
    query: z.string().trim().min(1).max(64).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: uuid.optional(),
  })
  .strict();

export const bookingSearchQuerySchema = z
  .object({
    originStopId: uuid,
    destinationStopId: uuid,
    departureFrom: instant.optional(),
    departureTo: instant.optional(),
    minAvailableSeats: z.coerce.number().int().min(1).max(20).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: searchCursor.optional(),
  })
  .strict()
  .refine((query) => query.originStopId !== query.destinationStopId, {
    path: ['destinationStopId'],
    message: 'origin and destination must differ',
  })
  .refine(
    (query) =>
      !query.departureFrom || !query.departureTo || query.departureFrom < query.departureTo,
    { path: ['departureTo'], message: 'departureTo must follow departureFrom' },
  );

export const availabilityQuerySchema = z
  .object({ originRouteWaypointId: uuid, destinationRouteWaypointId: uuid })
  .strict();

/**
 * The only authority a customer has: which trip, which journey, which seats.
 * Price, currency, fare, seat labels and identity come from the server.
 * The array bound is an anti-abuse limit; the configured seat limit is
 * enforced by the service (BOOKING_TOO_MANY_SEATS).
 */
export const bookingCreateSchema = z
  .object({
    tripId: uuid,
    originRouteWaypointId: uuid,
    destinationRouteWaypointId: uuid,
    seatMapCellIds: z.array(uuid).min(1).max(100),
  })
  .strict();

export const customerBookingListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    /** Reference of the last booking of the previous page. */
    cursor: z.string().trim().max(16).optional(),
  })
  .strict();

export const customerCancelSchema = z.object({}).strict();

export const staffCancelSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

export const adminBookingListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: uuid.optional(),
    status: z.enum(STATUSES).optional(),
    tripId: uuid.optional(),
    reference: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(z.string().min(1).max(16))
      .optional(),
  })
  .strict();

export type BookingSearchQuery = z.infer<typeof bookingSearchQuerySchema>;
export type BookingCreate = z.infer<typeof bookingCreateSchema>;
export type AdminBookingListQuery = z.infer<typeof adminBookingListQuerySchema>;

/** OpenAPI documentation of the request bodies (validation is done by zod). */
export class BookingCreateBody {
  @ApiProperty({ format: 'uuid' }) tripId!: string;
  @ApiProperty({ format: 'uuid' }) originRouteWaypointId!: string;
  @ApiProperty({ format: 'uuid' }) destinationRouteWaypointId!: string;
  @ApiProperty({ type: [String], format: 'uuid', minItems: 1 }) seatMapCellIds!: string[];
}

export class StaffCancelBody {
  @ApiProperty({ minLength: 3, maxLength: 500 }) reason!: string;
}
