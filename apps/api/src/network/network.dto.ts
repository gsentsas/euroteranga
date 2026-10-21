import { ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import { z } from 'zod';

const uuid = z.uuid();
const pageLimit = z.coerce.number().int().min(1).max(100).default(50);
const cursor = uuid.optional();
const name = z.string().trim().min(1).max(160);
const locality = z.string().trim().min(1).max(128);
const timezone = z.string().trim().min(1).max(64);
const latitude = z.number().finite().min(-90).max(90);
const longitude = z.number().finite().min(-180).max(180);

const uppercase = (length: number) =>
  z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(
      z
        .string()
        .length(length)
        .regex(/^[A-Z]+$/),
    );

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

const nonEmptyUpdate = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object(shape)
    .partial()
    .strict()
    .refine((value) => Object.keys(value).length > 0, { message: 'empty update' });

export const networkListQuerySchema = z.object({ limit: pageLimit, cursor }).strict();

const countryFields = {
  iso2: uppercase(2),
  iso3: uppercase(3),
  name,
  active: z.boolean(),
};
export const countryCreateSchema = z.object(countryFields).strict();
export const countryUpdateSchema = nonEmptyUpdate(countryFields);

const stopFields = {
  code,
  name,
  countryId: uuid,
  locality,
  latitude,
  longitude,
  timezone,
  active: z.boolean(),
};
export const stopCreateSchema = z.object(stopFields).strict();
export const stopUpdateSchema = nonEmptyUpdate(stopFields);

export const CHECKPOINT_TYPES = ['BORDER', 'FERRY_TERMINAL', 'PORT', 'TECHNICAL'] as const;
export const TERANGA_STOP_KINDS = [
  'BREAK',
  'MEAL',
  'SHOWER',
  'REST',
  'OVERNIGHT',
  'FUEL',
  'BORDER',
  'FERRY',
  'TECHNICAL',
] as const;
export const TERANGA_FACILITIES = [
  'RESTROOM',
  'SHOWER',
  'FOOD',
  'SECURE_PARKING',
  'FUEL',
] as const;

const facilities = z
  .array(z.enum(TERANGA_FACILITIES))
  .max(TERANGA_FACILITIES.length)
  .transform((values) =>
    [...new Set(values)].sort(
      (left, right) => TERANGA_FACILITIES.indexOf(left) - TERANGA_FACILITIES.indexOf(right),
    ),
  );

const checkpointFields = {
  ...stopFields,
  type: z.enum(CHECKPOINT_TYPES),
  terangaKind: z.enum(TERANGA_STOP_KINDS).optional(),
  travellerVisible: z.boolean().optional(),
  suggestedDwellMinutes: z.number().int().min(5).max(1440).nullable().optional(),
  facilities: facilities.optional(),
};
export const checkpointCreateSchema = z.object(checkpointFields).strict();
export const checkpointUpdateSchema = nonEmptyUpdate(checkpointFields);

const routeFields = { code, name, active: z.boolean() };
export const routeCreateSchema = z.object(routeFields).strict();
export const routeUpdateSchema = nonEmptyUpdate(routeFields);
export const routeVersionCreateSchema = z.object({}).strict();

export const stopWaypointSchema = z
  .object({
    kind: z.literal('STOP'),
    stopId: uuid,
    boardingAllowed: z.boolean().default(false),
    alightingAllowed: z.boolean().default(false),
  })
  .strict();
export const checkpointWaypointSchema = z
  .object({ kind: z.literal('CHECKPOINT'), checkpointId: uuid })
  .strict();
export const replaceWaypointsSchema = z
  .object({
    waypoints: z
      .array(z.discriminatedUnion('kind', [stopWaypointSchema, checkpointWaypointSchema]))
      .max(500),
  })
  .strict();

// OpenAPI request bodies. Runtime validation always uses the Zod schemas above.
export class CountryCreateBody {
  @ApiProperty({ minLength: 2, maxLength: 2, example: 'FR' }) iso2!: string;
  @ApiProperty({ minLength: 3, maxLength: 3, example: 'FRA' }) iso3!: string;
  @ApiProperty({ maxLength: 160 }) name!: string;
  @ApiProperty() active!: boolean;
}

export class CountryUpdateBody {
  @ApiPropertyOptional({ minLength: 2, maxLength: 2 }) iso2?: string;
  @ApiPropertyOptional({ minLength: 3, maxLength: 3 }) iso3?: string;
  @ApiPropertyOptional({ maxLength: 160 }) name?: string;
  @ApiPropertyOptional() active?: boolean;
}

export class StopCreateBody {
  @ApiProperty({ maxLength: 32, example: 'STOP_A' }) code!: string;
  @ApiProperty({ maxLength: 160 }) name!: string;
  @ApiProperty({ format: 'uuid' }) countryId!: string;
  @ApiProperty({ maxLength: 128 }) locality!: string;
  @ApiProperty({ minimum: -90, maximum: 90 }) latitude!: number;
  @ApiProperty({ minimum: -180, maximum: 180 }) longitude!: number;
  @ApiProperty({ maxLength: 64, example: 'Europe/Paris' }) timezone!: string;
  @ApiProperty() active!: boolean;
}

export class StopUpdateBody {
  @ApiPropertyOptional({ maxLength: 32 }) code?: string;
  @ApiPropertyOptional({ maxLength: 160 }) name?: string;
  @ApiPropertyOptional({ format: 'uuid' }) countryId?: string;
  @ApiPropertyOptional({ maxLength: 128 }) locality?: string;
  @ApiPropertyOptional({ minimum: -90, maximum: 90 }) latitude?: number;
  @ApiPropertyOptional({ minimum: -180, maximum: 180 }) longitude?: number;
  @ApiPropertyOptional({ maxLength: 64 }) timezone?: string;
  @ApiPropertyOptional() active?: boolean;
}

export class CheckpointCreateBody extends StopCreateBody {
  @ApiProperty({ enum: CHECKPOINT_TYPES })
  type!: (typeof CHECKPOINT_TYPES)[number];
  @ApiPropertyOptional({ enum: TERANGA_STOP_KINDS })
  terangaKind?: (typeof TERANGA_STOP_KINDS)[number];
  @ApiPropertyOptional({
    description: 'Explicitly include this checkpoint in the traveller-facing itinerary.',
  })
  travellerVisible?: boolean;
  @ApiPropertyOptional({
    nullable: true,
    minimum: 5,
    maximum: 1440,
    description: 'Non-binding planning hint in minutes; never a driver-hours rule.',
  })
  suggestedDwellMinutes?: number | null;
  @ApiPropertyOptional({ enum: TERANGA_FACILITIES, isArray: true })
  facilities?: Array<(typeof TERANGA_FACILITIES)[number]>;
}

export class CheckpointUpdateBody extends StopUpdateBody {
  @ApiPropertyOptional({ enum: CHECKPOINT_TYPES })
  type?: (typeof CHECKPOINT_TYPES)[number];
  @ApiPropertyOptional({ enum: TERANGA_STOP_KINDS })
  terangaKind?: (typeof TERANGA_STOP_KINDS)[number];
  @ApiPropertyOptional() travellerVisible?: boolean;
  @ApiPropertyOptional({ nullable: true, minimum: 5, maximum: 1440 })
  suggestedDwellMinutes?: number | null;
  @ApiPropertyOptional({ enum: TERANGA_FACILITIES, isArray: true })
  facilities?: Array<(typeof TERANGA_FACILITIES)[number]>;
}

export class RouteCreateBody {
  @ApiProperty({ maxLength: 32, example: 'ROUTE_A' }) code!: string;
  @ApiProperty({ maxLength: 160 }) name!: string;
  @ApiProperty() active!: boolean;
}

export class RouteUpdateBody {
  @ApiPropertyOptional({ maxLength: 32 }) code?: string;
  @ApiPropertyOptional({ maxLength: 160 }) name?: string;
  @ApiPropertyOptional() active?: boolean;
}

export class StopWaypointBody {
  @ApiProperty({ enum: ['STOP'] }) kind!: 'STOP';
  @ApiProperty({ format: 'uuid' }) stopId!: string;
  @ApiProperty({ default: false }) boardingAllowed!: boolean;
  @ApiProperty({ default: false }) alightingAllowed!: boolean;
}

export class CheckpointWaypointBody {
  @ApiProperty({ enum: ['CHECKPOINT'] }) kind!: 'CHECKPOINT';
  @ApiProperty({ format: 'uuid' }) checkpointId!: string;
}

export class ReplaceWaypointsBody {
  @ApiProperty({
    type: 'array',
    maxItems: 500,
    items: {
      oneOf: [
        { $ref: getSchemaPath(StopWaypointBody) },
        { $ref: getSchemaPath(CheckpointWaypointBody) },
      ],
      discriminator: { propertyName: 'kind' },
    },
  })
  waypoints!: Array<StopWaypointBody | CheckpointWaypointBody>;
}
