import { z } from 'zod';
import { fingerprint, type CanonicalValue } from './canonical-json.js';

/**
 * Closed, non-executable rule language (version 1).
 *
 * A definition is plain JSON validated against this grammar. Nothing in it is
 * ever evaluated as code: the engine walks a fixed set of node kinds over a
 * fixed set of facts. CODE_IS_NOT_LEGAL_AUTHORITY: the grammar describes how
 * a verified rule is expressed; it contains no regulatory requirement itself.
 */
export const RULE_LANGUAGE_VERSION = 1;

export const RULE_LIMITS = {
  /** Raw JSON nesting accepted before the grammar is even checked. */
  maxJsonDepth: 16,
  /** Raw JSON values (objects, arrays, scalars) in one definition. */
  maxJsonNodes: 600,
  maxStringLength: 64,
  /** Requirement tree: depth (a leaf is 1) and total nodes. */
  maxRequirementDepth: 4,
  maxRequirementNodes: 32,
  maxChildren: 8,
  maxCountries: 60,
  maxValidityDays: 3650,
  maxAge: 130,
  /** Canonical JSON size. */
  maxBytes: 8192,
} as const;

export const DOCUMENT_TYPES = [
  'PASSPORT',
  'NATIONAL_ID',
  'RESIDENCE_PERMIT',
  'VISA',
  'PARENTAL_AUTHORIZATION',
  'OTHER',
] as const;
export type RuleDocumentType = (typeof DOCUMENT_TYPES)[number];

/** Keys that could reach an object prototype if a consumer were careless. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const countryCode = z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 code expected');
const countryList = z
  .array(countryCode)
  .min(1)
  .max(RULE_LIMITS.maxCountries)
  .refine((values) => new Set(values).size === values.length, 'duplicate country');

const scopeSchema = z
  .object({
    /** Passenger nationality is one of these countries. */
    nationalities: countryList.optional(),
    /** Country of the booked origin stop. */
    originCountries: countryList.optional(),
    /** Country of the booked destination stop. */
    destinationCountries: countryList.optional(),
    /** At least one of these countries is crossed between origin and destination. */
    transitCountries: countryList.optional(),
    /** Inclusive age bounds on the planned travel date. */
    minAgeOnTravelDate: z.number().int().min(0).max(RULE_LIMITS.maxAge).optional(),
    maxAgeOnTravelDate: z.number().int().min(0).max(RULE_LIMITS.maxAge).optional(),
  })
  .strict()
  .refine(
    (scope) =>
      scope.minAgeOnTravelDate === undefined ||
      scope.maxAgeOnTravelDate === undefined ||
      scope.minAgeOnTravelDate <= scope.maxAgeOnTravelDate,
    {
      message: 'minAgeOnTravelDate must not exceed maxAgeOnTravelDate',
      path: ['maxAgeOnTravelDate'],
    },
  );

export type RuleScope = z.infer<typeof scopeSchema>;

export type Requirement =
  | {
      kind: 'DOCUMENT';
      documentType: RuleDocumentType;
      /** The document must still be valid this many days after the reference date. */
      minValidity?: { from: 'TRAVEL_DATE' | 'ARRIVAL_DATE'; days: number } | undefined;
      /** A present document still needs a human to confirm it. */
      humanCheck?: boolean | undefined;
    }
  | { kind: 'ALL_OF'; requirements: Requirement[] }
  | { kind: 'ANY_OF'; requirements: Requirement[] }
  /** The verified rule cannot be decided by a machine. */
  | { kind: 'HUMAN_REVIEW' }
  /** Verified coverage that asks for no document. */
  | { kind: 'NO_DOCUMENT_REQUIRED' };

const requirementSchema: z.ZodType<Requirement> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('DOCUMENT'),
        documentType: z.enum(DOCUMENT_TYPES),
        minValidity: z
          .object({
            from: z.enum(['TRAVEL_DATE', 'ARRIVAL_DATE']),
            days: z.number().int().min(0).max(RULE_LIMITS.maxValidityDays),
          })
          .strict()
          .optional(),
        humanCheck: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('ALL_OF'),
        requirements: z.array(requirementSchema).min(2).max(RULE_LIMITS.maxChildren),
      })
      .strict(),
    z
      .object({
        kind: z.literal('ANY_OF'),
        requirements: z.array(requirementSchema).min(2).max(RULE_LIMITS.maxChildren),
      })
      .strict(),
    z.object({ kind: z.literal('HUMAN_REVIEW') }).strict(),
    z.object({ kind: z.literal('NO_DOCUMENT_REQUIRED') }).strict(),
  ]),
);

const definitionSchema = z
  .object({
    language: z.literal(RULE_LANGUAGE_VERSION),
    scope: scopeSchema,
    requirement: requirementSchema,
  })
  .strict();

export type RuleDefinition = z.infer<typeof definitionSchema>;

export interface RuleIssue {
  path: string;
  code: string;
}

export type RuleParseResult =
  | { ok: true; definition: RuleDefinition; sha256: string; countries: string[] }
  | { ok: false; issues: RuleIssue[] };

/**
 * Iterative pre-check of untrusted JSON before the (recursive) grammar runs:
 * bounded depth, node count and string length, plain objects only, and no
 * prototype-related key anywhere.
 */
function inspectRawJson(value: unknown): RuleIssue | null {
  const stack: Array<{ value: unknown; depth: number; path: string }> = [
    { value, depth: 1, path: '' },
  ];
  let nodes = 0;
  while (stack.length > 0) {
    const { value: current, depth, path } = stack.pop()!;
    nodes += 1;
    if (nodes > RULE_LIMITS.maxJsonNodes) return { path, code: 'TOO_MANY_NODES' };
    if (depth > RULE_LIMITS.maxJsonDepth) return { path, code: 'TOO_DEEP' };
    if (typeof current === 'string') {
      if (current.length > RULE_LIMITS.maxStringLength) return { path, code: 'VALUE_TOO_LONG' };
    } else if (Array.isArray(current)) {
      current.forEach((item, index) =>
        stack.push({ value: item, depth: depth + 1, path: `${path}/${index}` }),
      );
    } else if (current !== null && typeof current === 'object') {
      if (
        Object.getPrototypeOf(current) !== Object.prototype &&
        Object.getPrototypeOf(current) !== null
      ) {
        return { path, code: 'NOT_PLAIN_JSON' };
      }
      for (const key of Object.keys(current)) {
        if (FORBIDDEN_KEYS.has(key)) return { path: `${path}/${key}`, code: 'FORBIDDEN_KEY' };
        stack.push({
          value: (current as Record<string, unknown>)[key],
          depth: depth + 1,
          path: `${path}/${key}`,
        });
      }
    } else if (current !== null && typeof current !== 'number' && typeof current !== 'boolean') {
      return { path, code: 'NOT_PLAIN_JSON' };
    }
  }
  return null;
}

function requirementShape(requirement: Requirement): { depth: number; nodes: number } {
  if (requirement.kind === 'ALL_OF' || requirement.kind === 'ANY_OF') {
    const children = requirement.requirements.map(requirementShape);
    return {
      depth: 1 + Math.max(...children.map((child) => child.depth)),
      nodes: 1 + children.reduce((sum, child) => sum + child.nodes, 0),
    };
  }
  return { depth: 1, nodes: 1 };
}

/** Every country code a definition names (sorted, unique). */
export function definitionCountries(definition: RuleDefinition): string[] {
  const { scope } = definition;
  return [
    ...new Set([
      ...(scope.nationalities ?? []),
      ...(scope.originCountries ?? []),
      ...(scope.destinationCountries ?? []),
      ...(scope.transitCountries ?? []),
    ]),
  ].sort();
}

/**
 * Validates untrusted input against language v1. Unknown kinds, facts or
 * keys, excessive nesting/size and malformed values are rejected with stable
 * issue codes; nothing is coerced.
 */
export function parseRuleDefinition(input: unknown): RuleParseResult {
  const raw = inspectRawJson(input);
  if (raw) return { ok: false, issues: [raw] };
  const parsed = definitionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 20).map((issue) => ({
        path: `/${issue.path.map(String).join('/')}`,
        code: issue.code.toUpperCase(),
      })),
    };
  }
  const shape = requirementShape(parsed.data.requirement);
  if (shape.depth > RULE_LIMITS.maxRequirementDepth) {
    return { ok: false, issues: [{ path: '/requirement', code: 'REQUIREMENT_TOO_DEEP' }] };
  }
  if (shape.nodes > RULE_LIMITS.maxRequirementNodes) {
    return { ok: false, issues: [{ path: '/requirement', code: 'REQUIREMENT_TOO_LARGE' }] };
  }
  const definition = parsed.data;
  const canonical = definition as unknown as CanonicalValue;
  if (Buffer.byteLength(JSON.stringify(canonical), 'utf8') > RULE_LIMITS.maxBytes) {
    return { ok: false, issues: [{ path: '', code: 'DEFINITION_TOO_LARGE' }] };
  }
  return {
    ok: true,
    definition,
    sha256: fingerprint(canonical),
    countries: definitionCountries(definition),
  };
}
