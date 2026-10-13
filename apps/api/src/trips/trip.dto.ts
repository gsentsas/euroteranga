import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';

const uuid = z.uuid();
const pageLimit = z.coerce.number().int().min(1).max(100).default(50);
const STATUSES = ['DRAFT', 'SCHEDULED', 'CANCELLED'] as const;

/** ISO 8601 with an explicit offset (e.g. 2030-01-15T08:00:00Z); stored in UTC. */
const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

const reason = z.string().trim().min(3).max(500);

/** Public reference: trimmed, uppercase, 3-32 characters. */
const reference = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(
    z
      .string()
      .min(3)
      .max(32)
      .regex(/^[A-Z0-9][A-Z0-9_-]*$/),
  );

export const tripListQuerySchema = z
  .object({
    limit: pageLimit,
    cursor: uuid.optional(),
    status: z.enum(STATUSES).optional(),
    routeId: uuid.optional(),
    routeVersionId: uuid.optional(),
    departureFrom: instant.optional(),
    departureTo: instant.optional(),
  })
  .strict();

export const tripCreateSchema = z
  .object({ reference, routeVersionId: uuid, vehicleId: uuid.nullable().optional() })
  .strict();

export const tripTimetableSchema = z
  .object({
    timings: z
      .array(
        z
          .object({
            routeWaypointId: uuid,
            plannedArrivalAt: instant.nullable(),
            plannedDepartureAt: instant.nullable(),
          })
          .strict(),
      )
      .min(2)
      .max(500),
  })
  .strict();

export const tripScheduleSchema = z.object({}).strict();

export const tripCancelSchema = z
  .object({ reason, expectedStatus: z.enum(STATUSES).optional() })
  .strict();

export const tripVehicleSchema = z
  .object({
    vehicleId: uuid.nullable(),
    /** Vehicle the decision was based on (null: none); refused if it moved. */
    expectedVehicleId: uuid.nullable().optional(),
    /** Required when the trip is SCHEDULED. */
    reason: reason.optional(),
  })
  .strict();

/** Dedicated operation, DRAFT trips only. */
export const tripSeatMapSchema = z
  .object({
    seatMapVersionId: uuid.nullable(),
    /** Seat map the decision was based on (null: none); refused if it moved. */
    expectedSeatMapVersionId: uuid.nullable().optional(),
  })
  .strict();

/** Dedicated operation, DRAFT trips only. */
export const tripFareTableSchema = z
  .object({
    fareTableVersionId: uuid.nullable(),
    /** Pricing the decision was based on (null: none); refused if it moved. */
    expectedFareTableVersionId: uuid.nullable().optional(),
  })
  .strict();

/** Server-side fare resolution query (exact pair, no fallback). */
export const tripFareQuerySchema = z
  .object({ originRouteWaypointId: uuid, destinationRouteWaypointId: uuid })
  .strict();

// OpenAPI bodies. Runtime validation always uses the Zod schemas above.
export class TripCreateBody {
  @ApiProperty({ maxLength: 32, example: 'ET-TEST-2030-0001' }) reference!: string;
  @ApiProperty({ format: 'uuid', description: 'A published route version.' })
  routeVersionId!: string;
  @ApiPropertyOptional({ nullable: true, format: 'uuid', description: 'An ACTIVE vehicle.' })
  vehicleId?: string | null;
}

export class TripTimingBody {
  @ApiProperty({ format: 'uuid' }) routeWaypointId!: string;
  @ApiProperty({ nullable: true, format: 'date-time', description: 'UTC (ISO 8601 with offset).' })
  plannedArrivalAt!: string | null;
  @ApiProperty({ nullable: true, format: 'date-time', description: 'UTC (ISO 8601 with offset).' })
  plannedDepartureAt!: string | null;
}

export class TripTimetableBody {
  @ApiProperty({ type: [TripTimingBody], description: 'One timing per route waypoint.' })
  timings!: TripTimingBody[];
}

export class TripCancelBody {
  @ApiProperty({ minLength: 3, maxLength: 500 }) reason!: string;
  @ApiPropertyOptional({ enum: STATUSES }) expectedStatus?: (typeof STATUSES)[number];
}

export class TripVehicleBody {
  @ApiProperty({ nullable: true, format: 'uuid', description: 'null removes the vehicle.' })
  vehicleId!: string | null;
  @ApiPropertyOptional({ nullable: true, format: 'uuid' }) expectedVehicleId?: string | null;
  @ApiPropertyOptional({ minLength: 3, maxLength: 500, description: 'Required once SCHEDULED.' })
  reason?: string;
}

export class TripSeatMapBody {
  @ApiProperty({
    nullable: true,
    format: 'uuid',
    description: 'A PUBLISHED version; null removes it.',
  })
  seatMapVersionId!: string | null;
  @ApiPropertyOptional({ nullable: true, format: 'uuid' }) expectedSeatMapVersionId?: string | null;
}

export class TripFareTableBody {
  @ApiProperty({
    nullable: true,
    format: 'uuid',
    description: 'A PUBLISHED version; null removes it.',
  })
  fareTableVersionId!: string | null;
  @ApiPropertyOptional({ nullable: true, format: 'uuid' }) expectedFareTableVersionId?:
    string | null;
}
