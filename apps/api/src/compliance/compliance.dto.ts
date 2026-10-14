import { z } from 'zod';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, 'invalid calendar date');

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Plain, single-line text: normalized, trimmed, without markup characters or
 * control characters (stored XSS defense in depth; the UIs render text only).
 */
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

/** Multi-line internal note: newlines allowed, no markup or other controls. */
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
            ![...value].some((char) => {
              const code = char.codePointAt(0)!;
              return (code < 0x20 && code !== 0x0a) || code === 0x7f;
            }),
          'markup or control characters (line breaks allowed)',
        ),
    );

/** Official source link: https only, no credentials, no whitespace. */
const sourceUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    if (!/^https:\/\/[^\s<>"]+$/.test(value)) return false;
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        url.username === '' &&
        url.password === '' &&
        url.hostname.includes('.')
      );
    } catch {
      return false;
    }
  }, 'an https URL without credentials is required');

export const ruleVersionContentSchema = z
  .object({
    /** Untrusted JSON, validated by the closed rule grammar in the service. */
    definition: z.unknown(),
    customerGuidance: plain(1, 500),
    effectiveFrom: isoDate,
    effectiveTo: isoDate.nullable().default(null),
    source: z
      .object({
        authority: plain(1, 200).nullable().default(null),
        title: plain(1, 300).nullable().default(null),
        url: sourceUrl.nullable().default(null),
        reference: plain(1, 200).nullable().default(null),
      })
      .strict()
      .default({ authority: null, title: null, url: null, reference: null }),
  })
  .strict()
  .refine((value) => value.effectiveTo === null || value.effectiveTo >= value.effectiveFrom, {
    path: ['effectiveTo'],
    message: 'effectiveTo must not precede effectiveFrom',
  });

export type RuleVersionContent = z.infer<typeof ruleVersionContentSchema>;

export const ruleCreateSchema = z
  .object({ title: plain(3, 160), version: ruleVersionContentSchema })
  .strict();

export const ruleNextVersionSchema = z
  .object({ version: ruleVersionContentSchema.optional() })
  .strict();

export const ruleVerifySchema = z
  .object({
    /** Digest of the exact definition the verifier read. */
    definitionSha256: sha256,
    sourceCheckedOn: isoDate,
    note: note(1, 1000).optional(),
  })
  .strict();

export const rulePublishSchema = z.object({ definitionSha256: sha256 }).strict();

export const ruleRetireSchema = z.object({ reason: note(10, 500) }).strict();

export const ruleListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.uuid().optional(),
    status: z.enum(['DRAFT', 'PUBLISHED', 'RETIRED']).optional(),
  })
  .strict();

export const COMPLIANCE_STATUSES = [
  'NOT_EVALUATED',
  'STALE',
  'REVIEW_REQUIRED',
  'COMPLIANT_BY_RULES',
  'NON_COMPLIANT_BY_RULES',
  'COMPLIANT',
  'NON_COMPLIANT',
  'NEEDS_INFORMATION',
] as const;
export type ComplianceStatus = (typeof COMPLIANCE_STATUSES)[number];

const reference = (pattern: RegExp) =>
  z
    .string()
    .trim()
    .toUpperCase()
    .max(32)
    .refine((value) => pattern.test(value));

export const complianceQueueQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(25),
    cursor: z.string().max(256).optional(),
    status: z.enum(COMPLIANCE_STATUSES).optional(),
    tripReference: z.string().trim().toUpperCase().max(32).optional(),
    bookingReference: reference(/^ETB-[0-9A-Z]{12}$/).optional(),
    passengerReference: reference(/^ETV-[0-9A-Z]{12}$/).optional(),
    departureFrom: isoDate.optional(),
    departureTo: isoDate.optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.departureFrom || !value.departureTo || value.departureFrom <= value.departureTo,
    {
      path: ['departureTo'],
      message: 'departureTo must not precede departureFrom',
    },
  );

export type ComplianceQueueQuery = z.infer<typeof complianceQueueQuerySchema>;

export const staffEvaluateSchema = z
  .object({
    bookingReference: reference(/^ETB-[0-9A-Z]{12}$/),
    passengerReference: reference(/^ETV-[0-9A-Z]{12}$/),
  })
  .strict();

export const reviewCreateSchema = z
  .object({
    decision: z.enum(['COMPLIANT', 'NON_COMPLIANT', 'NEEDS_INFORMATION']),
    /** Mandatory internal justification; never shown to the customer. */
    reason: note(10, 1000),
    customerMessage: plain(1, 500).optional(),
    /** The latest review the reviewer saw (null when there was none). */
    previousReviewId: z.uuid().nullable(),
  })
  .strict();

export type ReviewCreate = z.infer<typeof reviewCreateSchema>;
