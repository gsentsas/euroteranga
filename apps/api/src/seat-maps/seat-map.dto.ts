import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';

const uuid = z.uuid();
const pageLimit = z.coerce.number().int().min(1).max(100).default(50);
const KINDS = ['SEAT', 'AISLE', 'DRIVER', 'DOOR', 'TOILET', 'STAIRS', 'OTHER'] as const;

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

/** No worldwide numbering convention: trimmed, uppercase, 1-8 characters. */
const seatLabel = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,7}$/));

export const seatMapListQuerySchema = z
  .object({
    limit: pageLimit,
    cursor: uuid.optional(),
    active: z.enum(['true', 'false']).optional(),
  })
  .strict();

export const seatMapCreateSchema = z.object({ code, name, active: z.boolean() }).strict();
export const seatMapUpdateSchema = z
  .object({ code, name, active: z.boolean() })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'empty update' });
export const seatMapVersionCreateSchema = z.object({}).strict();

/** Bounds: 4 decks, 100 rows, 20 columns (as in the database). */
export const seatMapCellsSchema = z
  .object({
    cells: z
      .array(
        z
          .object({
            deck: z.number().int().min(1).max(4),
            row: z.number().int().min(1).max(100),
            column: z.number().int().min(1).max(20),
            kind: z.enum(KINDS),
            seatLabel: seatLabel.nullable().optional(),
          })
          .strict(),
      )
      .max(8000),
  })
  .strict();

// OpenAPI bodies. Runtime validation always uses the Zod schemas above.
export class SeatMapCreateBody {
  @ApiProperty({ maxLength: 32, example: 'COACH_TEST_A' }) code!: string;
  @ApiProperty({ maxLength: 160 }) name!: string;
  @ApiProperty() active!: boolean;
}

export class SeatMapUpdateBody {
  @ApiPropertyOptional({ maxLength: 32 }) code?: string;
  @ApiPropertyOptional({ maxLength: 160 }) name?: string;
  @ApiPropertyOptional() active?: boolean;
}

export class SeatMapCellBody {
  @ApiProperty({ minimum: 1, maximum: 4 }) deck!: number;
  @ApiProperty({ minimum: 1, maximum: 100 }) row!: number;
  @ApiProperty({ minimum: 1, maximum: 20 }) column!: number;
  @ApiProperty({ enum: KINDS }) kind!: (typeof KINDS)[number];
  @ApiPropertyOptional({ nullable: true, maxLength: 8, description: 'Required for SEAT only.' })
  seatLabel?: string | null;
}

export class SeatMapCellsBody {
  @ApiProperty({ type: [SeatMapCellBody], description: 'The complete layout of the draft.' })
  cells!: SeatMapCellBody[];
}
