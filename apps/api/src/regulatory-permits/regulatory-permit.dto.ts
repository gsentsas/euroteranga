import { z } from 'zod';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, 'invalid calendar date');

const plain = (min: number, max: number) =>
  z
    .string()
    .transform((value) => value.normalize('NFC').trim().replace(/\s+/gu, ' '))
    .pipe(
      z
        .string()
        .min(min)
        .max(max)
        .refine((value) => !/[<>\p{Cc}\p{Cf}]/u.test(value), 'markup or control characters'),
    );

const note = (min: number, max: number) =>
  z
    .string()
    .transform((value) => value.normalize('NFC').trim())
    .pipe(
      z
        .string()
        .min(min)
        .max(max)
        .refine(
          (value) =>
            !/[<>\p{Cf}]/u.test(value) &&
            ![...value].some((character) => {
              const code = character.codePointAt(0)!;
              return (code < 0x20 && code !== 0x0a) || code === 0x7f;
            }),
          'markup or control characters (line breaks allowed)',
        ),
    );

const normalizedCode = (max: number) =>
  z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(
      z
        .string()
        .min(1)
        .max(max)
        .regex(/^[A-Z0-9][A-Z0-9_.-]*$/),
    );

const iso2 = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}$/));

const sourceUrl = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    if (!/^https:\/\/[^\s<>"]+$/u.test(value)) return false;
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' && !url.username && !url.password && url.hostname.includes('.')
      );
    } catch {
      return false;
    }
  }, 'an https URL without credentials is required');

const operatorScope = z.object({ type: z.literal('OPERATOR') }).strict();
const countryScope = z.object({ type: z.literal('COUNTRY'), countryIso2: iso2 }).strict();
const vehicleScope = z
  .object({ type: z.literal('VEHICLE'), vehicleCode: normalizedCode(32) })
  .strict();
const routeVersionScope = z
  .object({
    type: z.literal('ROUTE_VERSION'),
    routeCode: normalizedCode(32),
    routeVersion: z.number().int().positive(),
  })
  .strict();
const tripScope = z
  .object({
    type: z.literal('TRIP'),
    tripReference: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(z.string().min(1).max(32)),
  })
  .strict();

export const permitScopeSchema = z.discriminatedUnion('type', [
  operatorScope,
  countryScope,
  vehicleScope,
  routeVersionScope,
  tripScope,
]);

const permitFields = {
  permitType: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z][A-Z0-9_.-]{1,63}$/)),
  title: plain(3, 160),
  issuingAuthority: plain(2, 200),
  authorityReference: plain(1, 200).nullable().optional(),
  jurisdictionCountryIso2: iso2.nullable().optional(),
  scope: permitScopeSchema,
  validFrom: isoDate,
  validUntil: isoDate,
  sourceUrl: sourceUrl.nullable().optional(),
  sourceCheckedOn: isoDate.nullable().optional(),
  notes: note(1, 1000).nullable().optional(),
};

export const permitCreateSchema = z
  .object(permitFields)
  .strict()
  .refine((value) => value.validUntil >= value.validFrom, {
    path: ['validUntil'],
    message: 'validUntil must not precede validFrom',
  });

export const permitUpdateSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    permitType: permitFields.permitType.optional(),
    title: permitFields.title.optional(),
    issuingAuthority: permitFields.issuingAuthority.optional(),
    authorityReference: permitFields.authorityReference,
    jurisdictionCountryIso2: permitFields.jurisdictionCountryIso2,
    scope: permitScopeSchema.optional(),
    validFrom: isoDate.optional(),
    validUntil: isoDate.optional(),
    sourceUrl: permitFields.sourceUrl,
    sourceCheckedOn: permitFields.sourceCheckedOn,
    notes: permitFields.notes,
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'expectedRevision'), {
    message: 'empty update',
  })
  .refine((value) => !value.validFrom || !value.validUntil || value.validUntil >= value.validFrom, {
    path: ['validUntil'],
    message: 'validUntil must not precede validFrom',
  });

export const permitRevisionSchema = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();

export const permitRevokeSchema = z
  .object({ expectedRevision: z.number().int().positive(), reason: note(10, 500) })
  .strict();

const statuses = ['DRAFT', 'ACTIVE', 'REVOKED'] as const;
const validityStates = ['DRAFT', 'NOT_YET_VALID', 'VALID', 'EXPIRED', 'REVOKED'] as const;
const scopeTypes = ['OPERATOR', 'COUNTRY', 'VEHICLE', 'ROUTE_VERSION', 'TRIP'] as const;

export const permitListQuerySchema = z
  .object({
    cursor: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(z.string().regex(/^ETRP-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/))
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    status: z.enum(statuses).optional(),
    validityState: z.enum(validityStates).optional(),
    scopeType: z.enum(scopeTypes).optional(),
    permitType: permitFields.permitType.optional(),
    country: iso2.optional(),
    vehicleCode: normalizedCode(32).optional(),
    routeCode: normalizedCode(32).optional(),
    routeVersion: z.coerce.number().int().positive().optional(),
    tripReference: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(z.string().min(1).max(32))
      .optional(),
    reference: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(z.string().regex(/^ETRP-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/))
      .optional(),
  })
  .strict()
  .refine((value) => value.routeVersion === undefined || value.routeCode !== undefined, {
    path: ['routeCode'],
    message: 'routeCode is required with routeVersion',
  });

export type PermitScopeInput = z.infer<typeof permitScopeSchema>;
export type PermitCreateInput = z.infer<typeof permitCreateSchema>;
export type PermitUpdateInput = z.infer<typeof permitUpdateSchema>;
export type PermitListQuery = z.infer<typeof permitListQuerySchema>;
