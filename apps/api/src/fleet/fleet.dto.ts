import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';

const uuid = z.uuid();
const pageLimit = z.coerce.number().int().min(1).max(100).default(50);

const STATUSES = ['PLANNED', 'ACTIVE', 'OUT_OF_SERVICE', 'RETIRED'] as const;
const TARGET_STATUSES = ['ACTIVE', 'OUT_OF_SERVICE', 'RETIRED'] as const;

/** On-board equipment (UI-PUBLIC-2), in the order the website lists them. */
export const VEHICLE_AMENITIES = [
  'AIR_CONDITIONING',
  'RECLINING_SEATS',
  'USB_CHARGING',
  'WIFI',
  'TOILET',
  'ENTERTAINMENT',
  'WHEELCHAIR_ACCESS',
] as const;

export const VEHICLE_MEDIA_KINDS = [
  'EXTERIOR',
  'INTERIOR',
  'SEATS',
  'LUGGAGE_HOLD',
  'EQUIPMENT',
  'CABIN',
  'OTHER',
] as const;

/** Distinct values, stored in the canonical order. */
const amenities = z
  .array(z.enum(VEHICLE_AMENITIES))
  .max(VEHICLE_AMENITIES.length * 2)
  .transform((list) => VEHICLE_AMENITIES.filter((amenity) => list.includes(amenity)));

const code = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(
    z
      .string()
      .min(1)
      .max(32)
      .regex(/^[A-Z0-9][A-Z0-9_-]*$/),
  );

/** Application-level shape only: 17 characters, VIN alphabet (no I, O, Q). */
const vin = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-HJ-NPR-Z0-9]{17}$/));

/**
 * Plate formats differ per country: no worldwide pattern. Trimmed,
 * uppercase, inner whitespace collapsed, no control characters.
 */
const registrationPlate = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, ' ').toUpperCase())
  .pipe(
    z
      .string()
      .min(1)
      .max(16)
      // eslint-disable-next-line no-control-regex
      .regex(/^[^\u0000-\u001F\u007F]+$/),
  );

const label = z.string().trim().min(1).max(80);

/** Operational name used by the teams (e.g. "Teranga 01"), unique when set. */
const operationalName = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1).max(80));

/** Not before 1950, not later than next year (checked per request). */
const modelYear = z
  .number()
  .int()
  .min(1950)
  .refine((year) => year <= new Date().getUTCFullYear() + 1, { message: 'model year too late' });

export const vehicleListQuerySchema = z
  .object({ limit: pageLimit, cursor: uuid.optional(), status: z.enum(STATUSES).optional() })
  .strict();

export const vehicleCreateSchema = z
  .object({
    code,
    name: operationalName.nullable().optional(),
    vin: vin.nullable().optional(),
    registrationPlate: registrationPlate.nullable().optional(),
    registrationCountryId: uuid.nullable().optional(),
    manufacturer: label,
    model: label,
    modelYear: modelYear.nullable().optional(),
    amenities: amenities.optional(),
  })
  .strict();

// status and retiredAt are deliberately absent: they change only through
// POST /vehicles/:id/status. `.strict()` rejects them with 400.
export const vehicleUpdateSchema = vehicleCreateSchema
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'empty update' });

export const vehicleStatusSchema = z
  .object({
    status: z.enum(TARGET_STATUSES),
    reason: z.string().trim().min(3).max(500),
    /** Optional optimistic check: the status the caller based its decision on. */
    expectedStatus: z.enum(STATUSES).optional(),
  })
  .strict();

/** Dedicated operation: the general update never accepts a seat map. */
export const vehicleSeatMapSchema = z
  .object({
    seatMapVersionId: uuid.nullable(),
    /** Seat map the decision was based on (null: none); refused if it moved. */
    expectedSeatMapVersionId: uuid.nullable().optional(),
  })
  .strict();

/** Atomic replacement of the main photograph and the ordered gallery. */
export const vehicleMediaSchema = z
  .object({
    primaryMediaId: uuid.nullable(),
    gallery: z
      .array(
        z
          .object({
            mediaId: uuid,
            kind: z.enum(VEHICLE_MEDIA_KINDS).nullable().optional(),
          })
          .strict(),
      )
      .max(6),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.gallery.forEach((item, index) => {
      const id = item.mediaId.toLowerCase();
      if (id === value.primaryMediaId?.toLowerCase()) {
        ctx.addIssue({
          code: 'custom',
          path: ['gallery', index, 'mediaId'],
          message: 'primary image cannot also be in the gallery',
        });
      }
      if (seen.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['gallery', index, 'mediaId'],
          message: 'duplicate gallery image',
        });
      }
      seen.add(id);
    });
  });

// OpenAPI bodies. Runtime validation always uses the Zod schemas above.
export class VehicleCreateBody {
  @ApiProperty({ maxLength: 32, example: 'BUS_A01' }) code!: string;
  @ApiPropertyOptional({
    nullable: true,
    maxLength: 80,
    example: 'Teranga 01',
    description: 'Operational name used by the teams; unique when set.',
  })
  name?: string | null;
  @ApiPropertyOptional({
    nullable: true,
    minLength: 17,
    maxLength: 17,
    description: 'Shape check only (17 characters, no I/O/Q); no check digit validation.',
  })
  vin?: string | null;
  @ApiPropertyOptional({
    nullable: true,
    maxLength: 16,
    description: 'Free format per country; must be sent with registrationCountryId.',
  })
  registrationPlate?: string | null;
  @ApiPropertyOptional({ nullable: true, format: 'uuid' }) registrationCountryId?: string | null;
  @ApiProperty({ maxLength: 80 }) manufacturer!: string;
  @ApiProperty({ maxLength: 80 }) model!: string;
  @ApiPropertyOptional({ nullable: true, minimum: 1950 }) modelYear?: number | null;
  @ApiPropertyOptional({
    enum: VEHICLE_AMENITIES,
    isArray: true,
    description: 'Equipment actually on board, shown on the public website.',
  })
  amenities?: Array<(typeof VEHICLE_AMENITIES)[number]>;
}

export class VehicleUpdateBody {
  @ApiPropertyOptional({ maxLength: 32 }) code?: string;
  @ApiPropertyOptional({ nullable: true, maxLength: 80 }) name?: string | null;
  @ApiPropertyOptional({ nullable: true, minLength: 17, maxLength: 17 }) vin?: string | null;
  @ApiPropertyOptional({ nullable: true, maxLength: 16 }) registrationPlate?: string | null;
  @ApiPropertyOptional({ nullable: true, format: 'uuid' }) registrationCountryId?: string | null;
  @ApiPropertyOptional({ maxLength: 80 }) manufacturer?: string;
  @ApiPropertyOptional({ maxLength: 80 }) model?: string;
  @ApiPropertyOptional({ nullable: true, minimum: 1950 }) modelYear?: number | null;
  @ApiPropertyOptional({ enum: VEHICLE_AMENITIES, isArray: true })
  amenities?: Array<(typeof VEHICLE_AMENITIES)[number]>;
}

export class VehicleStatusBody {
  @ApiProperty({ enum: TARGET_STATUSES }) status!: (typeof TARGET_STATUSES)[number];
  @ApiProperty({ minLength: 3, maxLength: 500 }) reason!: string;
  @ApiPropertyOptional({ enum: STATUSES }) expectedStatus?: (typeof STATUSES)[number];
}

export class VehicleSeatMapBody {
  @ApiProperty({
    nullable: true,
    format: 'uuid',
    description: 'A PUBLISHED version; null removes it.',
  })
  seatMapVersionId!: string | null;
  @ApiPropertyOptional({ nullable: true, format: 'uuid' }) expectedSeatMapVersionId?: string | null;
}

export class VehicleMediaItemBody {
  @ApiProperty({ format: 'uuid' }) mediaId!: string;
  @ApiPropertyOptional({ enum: VEHICLE_MEDIA_KINDS, nullable: true })
  kind?: (typeof VEHICLE_MEDIA_KINDS)[number] | null;
}

export class VehicleMediaBody {
  @ApiProperty({ format: 'uuid', nullable: true }) primaryMediaId!: string | null;
  @ApiProperty({ type: [VehicleMediaItemBody], maxItems: 6 }) gallery!: VehicleMediaItemBody[];
}
