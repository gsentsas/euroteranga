import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';

const uuid = z.uuid();
const pageLimit = z.coerce.number().int().min(1).max(100).default(50);

const STATUSES = ['PLANNED', 'ACTIVE', 'OUT_OF_SERVICE', 'RETIRED'] as const;
const TARGET_STATUSES = ['ACTIVE', 'OUT_OF_SERVICE', 'RETIRED'] as const;

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
    vin: vin.nullable().optional(),
    registrationPlate: registrationPlate.nullable().optional(),
    registrationCountryId: uuid.nullable().optional(),
    manufacturer: label,
    model: label,
    modelYear: modelYear.nullable().optional(),
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

// OpenAPI bodies. Runtime validation always uses the Zod schemas above.
export class VehicleCreateBody {
  @ApiProperty({ maxLength: 32, example: 'BUS_A01' }) code!: string;
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
}

export class VehicleUpdateBody {
  @ApiPropertyOptional({ maxLength: 32 }) code?: string;
  @ApiPropertyOptional({ nullable: true, minLength: 17, maxLength: 17 }) vin?: string | null;
  @ApiPropertyOptional({ nullable: true, maxLength: 16 }) registrationPlate?: string | null;
  @ApiPropertyOptional({ nullable: true, format: 'uuid' }) registrationCountryId?: string | null;
  @ApiPropertyOptional({ maxLength: 80 }) manufacturer?: string;
  @ApiPropertyOptional({ maxLength: 80 }) model?: string;
  @ApiPropertyOptional({ nullable: true, minimum: 1950 }) modelYear?: number | null;
}

export class VehicleStatusBody {
  @ApiProperty({ enum: TARGET_STATUSES }) status!: (typeof TARGET_STATUSES)[number];
  @ApiProperty({ minLength: 3, maxLength: 500 }) reason!: string;
  @ApiPropertyOptional({ enum: STATUSES }) expectedStatus?: (typeof STATUSES)[number];
}
