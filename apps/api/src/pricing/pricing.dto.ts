import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';
import { MAX_AMOUNT_MINOR } from './fare-entries.js';

const uuid = z.uuid();
const pageLimit = z.coerce.number().int().min(1).max(100).default(50);

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
const name = z.string().trim().min(1).max(160);

/** Three letters, uppercased; no fixed ISO 4217 list. */
const currencyCode = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{3}$/));

/** Exact integer in the currency's minor unit (no floating point). */
const amountMinor = z.number().int().min(1).max(MAX_AMOUNT_MINOR);

export const fareTableListQuerySchema = z
  .object({
    limit: pageLimit,
    cursor: uuid.optional(),
    active: z.enum(['true', 'false']).optional(),
    routeId: uuid.optional(),
  })
  .strict();

export const fareTableCreateSchema = z
  .object({
    code,
    name,
    routeId: uuid,
    currencyCode,
    currencyMinorUnit: z.number().int().min(0).max(3),
    active: z.boolean(),
  })
  .strict();

// Route and currency are the economic identity: never updatable. `.strict()`
// rejects them (and the code) with 400.
export const fareTableUpdateSchema = z
  .object({ name, active: z.boolean() })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'empty update' });

export const fareTableVersionCreateSchema = z.object({ routeVersionId: uuid }).strict();
export const fareTablePublishSchema = z.object({}).strict();

export const fareTableFaresSchema = z
  .object({
    fares: z
      .array(
        z
          .object({
            originRouteWaypointId: uuid,
            destinationRouteWaypointId: uuid,
            amountMinor,
          })
          .strict(),
      )
      .max(5000),
  })
  .strict();

// OpenAPI bodies. Runtime validation always uses the Zod schemas above.
export class FareTableCreateBody {
  @ApiProperty({ maxLength: 32, example: 'ROUTE_TEST_EUR' }) code!: string;
  @ApiProperty({ maxLength: 160 }) name!: string;
  @ApiProperty({ format: 'uuid' }) routeId!: string;
  @ApiProperty({ minLength: 3, maxLength: 3, example: 'EUR' }) currencyCode!: string;
  @ApiProperty({ minimum: 0, maximum: 3, example: 2, description: 'EUR 2, XOF 0.' })
  currencyMinorUnit!: number;
  @ApiProperty() active!: boolean;
}

export class FareTableUpdateBody {
  @ApiPropertyOptional({ maxLength: 160 }) name?: string;
  @ApiPropertyOptional() active?: boolean;
}

export class FareTableVersionCreateBody {
  @ApiProperty({ format: 'uuid', description: 'A published version of the fare table route.' })
  routeVersionId!: string;
}

export class FareBody {
  @ApiProperty({ format: 'uuid' }) originRouteWaypointId!: string;
  @ApiProperty({ format: 'uuid' }) destinationRouteWaypointId!: string;
  @ApiProperty({
    minimum: 1,
    maximum: MAX_AMOUNT_MINOR,
    example: 12550,
    description: 'Minor units (EUR 125,50 = 12550).',
  })
  amountMinor!: number;
}

export class FareTableFaresBody {
  @ApiProperty({
    type: [FareBody],
    description: 'The complete (possibly partial) matrix of the draft.',
  })
  fares!: FareBody[];
}
