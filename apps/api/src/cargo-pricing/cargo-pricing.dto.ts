import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';

export const CARGO_PRICING_CATEGORIES = [
  'STANDARD_PARCEL',
  'PERSONAL_ITEMS',
  'CLOTHING',
  'DOCUMENTS',
  'ALLOWED_FOOD',
  'EQUIPMENT',
  'PROFESSIONAL_GOODS',
  'UNACCOMPANIED_BAGGAGE',
  'ACCOMPANIED_PARCEL',
  'SPECIAL_HANDLING',
  'OTHER',
] as const;

export const CARGO_PRICING_METHODS = [
  'ACTUAL_WEIGHT',
  'VOLUMETRIC_WEIGHT',
  'VOLUME',
  'FLAT_RATE',
  'TIERED_WEIGHT',
  'CUSTOM_QUOTE',
] as const;

export const CARGO_PRICING_OPTION_KINDS = [
  'PICKUP',
  'DELIVERY',
  'FRAGILE_HANDLING',
  'PROFESSIONAL_HANDLING',
  'INSURANCE',
] as const;

const uuid = z.uuid();
const exactPositive = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9][0-9]{0,4})(?:\.[0-9]{1,3})?$/)
  .refine((value) => Number(value) > 0, 'must be positive');
const exactNonNegative = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9][0-9]{0,4})(?:\.[0-9]{1,3})?$/);
const exactPositiveVolume = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9][0-9]{0,6})(?:\.[0-9]{1,3})?$/)
  .refine((value) => Number(value) > 0 && Number(value) <= 1_000_000, 'invalid volume');
const amountMinor = z
  .string()
  .regex(/^[1-9][0-9]{0,17}$/)
  .refine((value) => BigInt(value) <= 999_999_999_999_999_999n, 'amount out of range');
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
const currencyCode = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{3}$/));

const dimensionsSchema = z
  .object({
    lengthCm: z.number().int().min(1).max(1000),
    widthCm: z.number().int().min(1).max(1000),
    heightCm: z.number().int().min(1).max(1000),
  })
  .strict();

export const cargoEstimateSchema = z
  .object({
    from: z.enum(['PAR', 'DKR']),
    to: z.enum(['PAR', 'DKR']),
    weightKg: exactPositive,
    dimensions: dimensionsSchema.optional(),
    volumeLiters: exactPositiveVolume.optional(),
    category: z.enum(CARGO_PRICING_CATEGORIES),
    pickup: z.boolean().default(false),
    delivery: z.boolean().default(false),
    fragile: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.from === value.to) {
      context.addIssue({ code: 'custom', path: ['to'], message: 'unsupported direction' });
    }
    if (value.dimensions && value.volumeLiters) {
      context.addIssue({
        code: 'custom',
        path: ['volumeLiters'],
        message: 'provide dimensions or volumeLiters, not both',
      });
    }
  });

const cargoPricingTierSchema = z
  .object({
    position: z.number().int().min(0).max(999),
    minWeightKg: exactNonNegative,
    maxWeightKg: exactPositive.nullable(),
    method: z.enum(['UNIT_WEIGHT', 'UNIT_VOLUME', 'FLAT_RATE', 'CUSTOM_QUOTE']),
    unitPriceMinor: amountMinor.nullable(),
    flatPriceMinor: amountMinor.nullable(),
    minimumChargeMinor: amountMinor.nullable(),
  })
  .strict();

const cargoPricingOptionSchema = z
  .object({
    kind: z.enum(CARGO_PRICING_OPTION_KINDS),
    mode: z.enum(['INCLUDED', 'FLAT_RATE', 'CUSTOM_QUOTE']),
    amountMinor: amountMinor.nullable(),
  })
  .strict();

export const cargoPricingVersionConfigSchema = z
  .object({
    method: z.enum(CARGO_PRICING_METHODS),
    currencyCode,
    currencyMinorUnit: z.number().int().min(0).max(3),
    roundingMode: z.enum(['UP', 'HALF_UP', 'DOWN']).nullable(),
    unitPriceMinor: amountMinor.nullable(),
    flatPriceMinor: amountMinor.nullable(),
    minimumChargeMinor: amountMinor.nullable(),
    volumetricDivisorCm3PerKg: z.number().int().min(1).max(1_000_000_000).nullable(),
    quoteAboveWeightKg: exactPositive.nullable(),
    quoteAboveVolumeLiters: z.number().int().min(1).max(2_147_483_647).nullable(),
    effectiveFrom: z.iso.datetime({ offset: true }),
    effectiveTo: z.iso.datetime({ offset: true }).nullable(),
    categories: z.array(z.enum(CARGO_PRICING_CATEGORIES)).min(1).max(20),
    tiers: z.array(cargoPricingTierSchema).max(100),
    options: z.array(cargoPricingOptionSchema).max(CARGO_PRICING_OPTION_KINDS.length),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.effectiveTo && new Date(value.effectiveTo) <= new Date(value.effectiveFrom)) {
      context.addIssue({
        code: 'custom',
        path: ['effectiveTo'],
        message: 'invalid effective window',
      });
    }
    if (new Set(value.categories).size !== value.categories.length) {
      context.addIssue({ code: 'custom', path: ['categories'], message: 'duplicate category' });
    }
    if (new Set(value.options.map((option) => option.kind)).size !== value.options.length) {
      context.addIssue({ code: 'custom', path: ['options'], message: 'duplicate option' });
    }
  });

export const cargoPricingRuleListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: uuid.optional(),
    direction: z.enum(['PAR_DKR', 'DKR_PAR']).optional(),
    audience: z.enum(['PUBLIC', 'PRO', 'NEGOTIATED']).optional(),
  })
  .strict();

export const cargoPricingRuleCreateSchema = z
  .object({
    code,
    name,
    direction: z.enum(['PAR_DKR', 'DKR_PAR']),
    audience: z.enum(['PUBLIC', 'PRO', 'NEGOTIATED']),
  })
  .strict();

export const cargoPricingRuleUpdateSchema = z.object({ name }).strict();
export const cargoPricingVersionCreateSchema = z.union([
  cargoPricingVersionConfigSchema,
  z.object({ sourceVersionId: uuid }).strict(),
]);
export const cargoPricingVersionUpdateSchema = cargoPricingVersionConfigSchema;
export const cargoPricingTransitionSchema = z.object({}).strict();

export class CargoDimensionsBody {
  @ApiProperty({ minimum: 1, maximum: 1000 }) lengthCm!: number;
  @ApiProperty({ minimum: 1, maximum: 1000 }) widthCm!: number;
  @ApiProperty({ minimum: 1, maximum: 1000 }) heightCm!: number;
}

export class CargoEstimateBody {
  @ApiProperty({ enum: ['PAR', 'DKR'] }) from!: 'PAR' | 'DKR';
  @ApiProperty({ enum: ['PAR', 'DKR'] }) to!: 'PAR' | 'DKR';
  @ApiProperty({ example: '25.000', description: 'Exact decimal string, at most 3 decimals.' })
  weightKg!: string;
  @ApiPropertyOptional({ type: CargoDimensionsBody }) dimensions?: CargoDimensionsBody;
  @ApiPropertyOptional({ example: '96.000', description: 'Alternative to dimensions.' })
  volumeLiters?: string;
  @ApiProperty({ enum: CARGO_PRICING_CATEGORIES })
  category!: (typeof CARGO_PRICING_CATEGORIES)[number];
  @ApiPropertyOptional({ default: false }) pickup?: boolean;
  @ApiPropertyOptional({ default: false }) delivery?: boolean;
  @ApiPropertyOptional({ default: false }) fragile?: boolean;
}

export class CargoPricingRuleCreateBody {
  @ApiProperty({ maxLength: 32, example: 'PUBLIC_PAR_DKR' }) code!: string;
  @ApiProperty({ maxLength: 160 }) name!: string;
  @ApiProperty({ enum: ['PAR_DKR', 'DKR_PAR'] }) direction!: 'PAR_DKR' | 'DKR_PAR';
  @ApiProperty({ enum: ['PUBLIC', 'PRO', 'NEGOTIATED'] }) audience!:
    'PUBLIC' | 'PRO' | 'NEGOTIATED';
}

export class CargoPricingRuleUpdateBody {
  @ApiProperty({ maxLength: 160 }) name!: string;
}

export class CargoPricingTierBody {
  @ApiProperty({ minimum: 0, maximum: 999 }) position!: number;
  @ApiProperty({ example: '0.000' }) minWeightKg!: string;
  @ApiPropertyOptional({ nullable: true, example: '20.000' }) maxWeightKg!: string | null;
  @ApiProperty({ enum: ['UNIT_WEIGHT', 'UNIT_VOLUME', 'FLAT_RATE', 'CUSTOM_QUOTE'] })
  method!: 'UNIT_WEIGHT' | 'UNIT_VOLUME' | 'FLAT_RATE' | 'CUSTOM_QUOTE';
  @ApiPropertyOptional({ nullable: true, example: '300' }) unitPriceMinor!: string | null;
  @ApiPropertyOptional({ nullable: true, example: '7500' }) flatPriceMinor!: string | null;
  @ApiPropertyOptional({ nullable: true, example: '2500' }) minimumChargeMinor!: string | null;
}

export class CargoPricingOptionBody {
  @ApiProperty({ enum: CARGO_PRICING_OPTION_KINDS })
  kind!: (typeof CARGO_PRICING_OPTION_KINDS)[number];
  @ApiProperty({ enum: ['INCLUDED', 'FLAT_RATE', 'CUSTOM_QUOTE'] }) mode!:
    'INCLUDED' | 'FLAT_RATE' | 'CUSTOM_QUOTE';
  @ApiPropertyOptional({ nullable: true, example: '1500' }) amountMinor!: string | null;
}

export class CargoPricingVersionBody {
  @ApiProperty({ enum: CARGO_PRICING_METHODS }) method!: (typeof CARGO_PRICING_METHODS)[number];
  @ApiProperty({ minLength: 3, maxLength: 3, example: 'EUR' }) currencyCode!: string;
  @ApiProperty({ minimum: 0, maximum: 3, example: 2 }) currencyMinorUnit!: number;
  @ApiPropertyOptional({ enum: ['UP', 'HALF_UP', 'DOWN'], nullable: true })
  roundingMode!: 'UP' | 'HALF_UP' | 'DOWN' | null;
  @ApiPropertyOptional({ nullable: true, example: '300' }) unitPriceMinor!: string | null;
  @ApiPropertyOptional({ nullable: true, example: '7500' }) flatPriceMinor!: string | null;
  @ApiPropertyOptional({ nullable: true, example: '2500' }) minimumChargeMinor!: string | null;
  @ApiPropertyOptional({ nullable: true, example: 5000 })
  volumetricDivisorCm3PerKg!: number | null;
  @ApiPropertyOptional({ nullable: true, example: '100.000' })
  quoteAboveWeightKg!: string | null;
  @ApiPropertyOptional({ nullable: true, example: 500 })
  quoteAboveVolumeLiters!: number | null;
  @ApiProperty({ format: 'date-time' }) effectiveFrom!: string;
  @ApiPropertyOptional({ format: 'date-time', nullable: true }) effectiveTo!: string | null;
  @ApiProperty({ enum: CARGO_PRICING_CATEGORIES, isArray: true })
  categories!: Array<(typeof CARGO_PRICING_CATEGORIES)[number]>;
  @ApiProperty({ type: [CargoPricingTierBody] }) tiers!: CargoPricingTierBody[];
  @ApiProperty({ type: [CargoPricingOptionBody] }) options!: CargoPricingOptionBody[];
}

export class CargoPricingVersionCloneBody {
  @ApiProperty({ format: 'uuid' }) sourceVersionId!: string;
}

export type CargoEstimateInput = z.infer<typeof cargoEstimateSchema>;
export type CargoPricingRuleCreateInput = z.infer<typeof cargoPricingRuleCreateSchema>;
export type CargoPricingRuleUpdateInput = z.infer<typeof cargoPricingRuleUpdateSchema>;
export type CargoPricingVersionConfigInput = z.infer<typeof cargoPricingVersionConfigSchema>;
export type CargoPricingVersionCreateInput = z.infer<typeof cargoPricingVersionCreateSchema>;
export type CargoPricingRuleListQuery = z.infer<typeof cargoPricingRuleListQuerySchema>;
