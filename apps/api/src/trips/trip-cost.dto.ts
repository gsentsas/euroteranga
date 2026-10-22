import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';

export const TRIP_COST_STATUSES = ['DRAFT', 'ESTIMATED', 'LOCKED'] as const;
export const TRIP_COST_CATEGORIES = [
  'FUEL',
  'TOLLS',
  'FERRY',
  'BORDER_FEES',
  'PERMITS',
  'DRIVERS',
  'ACCOMMODATION',
  'MEALS_ALLOWANCES',
  'MAINTENANCE',
  'INSURANCE',
  'CLEANING_PREPARATION',
  'PARKING',
  'STOP_COST',
  'SUPPORT_VEHICLE',
  'CONTINGENCY',
  'OTHER',
] as const;

const amountMinor = z.string().regex(/^(0|[1-9][0-9]{0,15})$/);

/** Complete, ordered replacement of one trip's operational cost plan. */
export const tripCostReplaceSchema = z
  .object({
    status: z.enum(TRIP_COST_STATUSES),
    currencyCode: z.literal('EUR'),
    items: z
      .array(
        z
          .object({
            category: z.enum(TRIP_COST_CATEGORIES),
            label: z.string().trim().min(1).max(160),
            amountMinor,
            notes: z.string().trim().min(1).max(500).optional(),
            position: z.number().int().min(0).max(99),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const positions = new Map<number, number>();
    value.items.forEach((item, index) => {
      const previous = positions.get(item.position);
      if (previous !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'position'],
          message: `position already used by item ${previous}`,
        });
      }
      positions.set(item.position, index);
    });
    const sorted = [...positions.keys()].sort((a, b) => a - b);
    sorted.forEach((position, index) => {
      if (position !== index) {
        context.addIssue({
          code: 'custom',
          path: ['items', positions.get(position) ?? 0, 'position'],
          message: 'positions must be contiguous from zero',
        });
      }
    });
  });

export class TripCostItemBody {
  @ApiProperty({ enum: TRIP_COST_CATEGORIES })
  category!: (typeof TRIP_COST_CATEGORIES)[number];

  @ApiProperty({ minLength: 1, maxLength: 160 }) label!: string;
  @ApiProperty({ type: String, pattern: '^(0|[1-9][0-9]{0,15})$' }) amountMinor!: string;
  @ApiPropertyOptional({ minLength: 1, maxLength: 500 }) notes?: string;
  @ApiProperty({ minimum: 0, maximum: 99 }) position!: number;
}

export class TripCostReplaceBody {
  @ApiProperty({ enum: TRIP_COST_STATUSES })
  status!: (typeof TRIP_COST_STATUSES)[number];

  @ApiProperty({ enum: ['EUR'] }) currencyCode!: 'EUR';
  @ApiProperty({ type: [TripCostItemBody], maxItems: 100 }) items!: TripCostItemBody[];
}
