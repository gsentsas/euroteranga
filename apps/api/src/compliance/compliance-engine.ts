import { fingerprint, type CanonicalValue } from './canonical-json.js';
import type { Requirement, RuleDefinition, RuleDocumentType, RuleScope } from './rule-language.js';

/**
 * Deterministic compliance engine. Same facts + same rule versions + same
 * engine version = same result. It reads facts and published, verified rule
 * versions only; it never trusts a client and never derives an obligation of
 * its own.
 *
 * NO_MATCHING_RULE != COMPLIANT: no applicable rule, or a destination or
 * transit country without explicit verified coverage, is REVIEW_REQUIRED.
 * TECHNICALLY_ACCEPTED != REGULATORY_VALID: an ACCEPTED file is only
 * available evidence; whether it satisfies a requirement is decided here,
 * from the verified rule, and can still require a human.
 */
export const ENGINE_VERSION = 'compliance-engine/1';

export type MachineResult = 'PASS' | 'FAIL' | 'REVIEW_REQUIRED';
export type RuleOutcome = MachineResult | 'NOT_APPLICABLE';

/** Minimized, server-derived facts of one booking passenger (no name, no birth date). */
export interface ComplianceFacts {
  factsVersion: 1;
  /** Local calendar dates (YYYY-MM-DD) at the booked origin and destination stops. */
  travelDate: string;
  arrivalDate: string;
  originCountry: string;
  destinationCountry: string;
  /** Countries crossed strictly between origin and destination, in route order. */
  transitCountries: string[];
  nationality: string;
  ageOnTravelDate: number;
  /** Technically ACCEPTED documents only, sorted by reference. */
  documents: Array<{ reference: string; type: RuleDocumentType; expiresAt: string | null }>;
}

export interface RuleVersionInput {
  versionId: string;
  ruleReference: string;
  version: number;
  definitionSha256: string;
  definition: RuleDefinition;
}

export interface Finding {
  code: string;
  documentType?: RuleDocumentType;
  country?: string;
}

export interface RuleOutcomeRecord {
  versionId: string;
  ruleReference: string;
  version: number;
  outcome: RuleOutcome;
  reasonCode: string;
  details: Finding[];
  /** References (ETD-…) of the documents examined for this outcome. */
  evidence: string[];
}

export interface EngineResult {
  result: MachineResult;
  findings: Finding[];
  outcomes: RuleOutcomeRecord[];
  factsFingerprint: string;
  rulesFingerprint: string;
}

interface Evaluated {
  outcome: MachineResult;
  details: Finding[];
  evidence: string[];
}

/** Adds whole days to a YYYY-MM-DD calendar date (UTC arithmetic, no timezone). */
export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function merge(children: Evaluated[], outcome: MachineResult): Evaluated {
  return {
    outcome,
    details: children.flatMap((child) => child.details),
    evidence: unique(children.flatMap((child) => child.evidence)).sort(),
  };
}

function evaluateRequirement(requirement: Requirement, facts: ComplianceFacts): Evaluated {
  switch (requirement.kind) {
    case 'NO_DOCUMENT_REQUIRED':
      return { outcome: 'PASS', details: [{ code: 'NO_DOCUMENT_REQUIRED' }], evidence: [] };
    case 'HUMAN_REVIEW':
      return {
        outcome: 'REVIEW_REQUIRED',
        details: [{ code: 'HUMAN_REVIEW_REQUIRED' }],
        evidence: [],
      };
    case 'ALL_OF': {
      const children = requirement.requirements.map((child) => evaluateRequirement(child, facts));
      if (children.some((child) => child.outcome === 'FAIL')) return merge(children, 'FAIL');
      if (children.some((child) => child.outcome === 'REVIEW_REQUIRED')) {
        return merge(children, 'REVIEW_REQUIRED');
      }
      return merge(children, 'PASS');
    }
    case 'ANY_OF': {
      const children = requirement.requirements.map((child) => evaluateRequirement(child, facts));
      const passing = children.filter((child) => child.outcome === 'PASS');
      if (passing.length > 0) return merge(passing, 'PASS');
      const review = children.filter((child) => child.outcome === 'REVIEW_REQUIRED');
      if (review.length > 0) return merge(review, 'REVIEW_REQUIRED');
      return merge(children, 'FAIL');
    }
    case 'DOCUMENT': {
      const { documentType } = requirement;
      const candidates = facts.documents.filter((document) => document.type === documentType);
      if (candidates.length === 0) {
        return {
          outcome: 'FAIL',
          details: [{ code: 'DOCUMENT_MISSING', documentType }],
          evidence: [],
        };
      }
      const validity = requirement.minValidity;
      const needed = validity
        ? addDays(
            validity.from === 'TRAVEL_DATE' ? facts.travelDate : facts.arrivalDate,
            validity.days,
          )
        : null;
      const valid = candidates.filter(
        (document) =>
          needed === null || (document.expiresAt !== null && document.expiresAt >= needed),
      );
      const unknown =
        needed === null ? [] : candidates.filter((document) => document.expiresAt === null);
      if (valid.length > 0) {
        const evidence = valid.map((document) => document.reference).sort();
        return requirement.humanCheck
          ? {
              outcome: 'REVIEW_REQUIRED',
              details: [{ code: 'DOCUMENT_REQUIRES_HUMAN_CHECK', documentType }],
              evidence,
            }
          : { outcome: 'PASS', details: [{ code: 'DOCUMENT_PRESENT', documentType }], evidence };
      }
      if (unknown.length > 0) {
        return {
          outcome: 'REVIEW_REQUIRED',
          details: [{ code: 'DOCUMENT_EXPIRY_UNKNOWN', documentType }],
          evidence: unknown.map((document) => document.reference).sort(),
        };
      }
      return {
        outcome: 'FAIL',
        details: [{ code: 'DOCUMENT_VALIDITY_TOO_SHORT', documentType }],
        evidence: candidates.map((document) => document.reference).sort(),
      };
    }
  }
}

/** The journey part of the scope (absent lists match everything). */
export function geographyMatches(scope: RuleScope, facts: ComplianceFacts): boolean {
  return (
    (!scope.originCountries || scope.originCountries.includes(facts.originCountry)) &&
    (!scope.destinationCountries ||
      scope.destinationCountries.includes(facts.destinationCountry)) &&
    (!scope.transitCountries ||
      scope.transitCountries.some((country) => facts.transitCountries.includes(country)))
  );
}

/** The person part of the scope (nationality, age on the travel date). */
export function personMatches(scope: RuleScope, facts: ComplianceFacts): boolean {
  return (
    (!scope.nationalities || scope.nationalities.includes(facts.nationality)) &&
    (scope.minAgeOnTravelDate === undefined || facts.ageOnTravelDate >= scope.minAgeOnTravelDate) &&
    (scope.maxAgeOnTravelDate === undefined || facts.ageOnTravelDate <= scope.maxAgeOnTravelDate)
  );
}

const REASON: Record<RuleOutcome, string> = {
  PASS: 'REQUIREMENT_MET',
  FAIL: 'REQUIREMENT_NOT_MET',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED_BY_RULE',
  NOT_APPLICABLE: 'SCOPE_NOT_MATCHED',
};

/**
 * Explicit, verified coverage of every country entered on the journey: the
 * destination must be named in an applicable rule's destinationCountries and
 * each transit country in an applicable rule's transitCountries. A rule that
 * names no country covers nothing.
 */
function coverageGaps(facts: ComplianceFacts, applicable: RuleVersionInput[]): Finding[] {
  const gaps: Finding[] = [];
  for (const country of unique([...facts.transitCountries, facts.destinationCountry])) {
    const covered = applicable.some(({ definition: { scope } }) => {
      const asDestination =
        country === facts.destinationCountry &&
        (scope.destinationCountries ?? []).includes(country);
      const asTransit =
        facts.transitCountries.includes(country) &&
        (scope.transitCountries ?? []).includes(country);
      return asDestination || asTransit;
    });
    if (!covered) gaps.push({ code: 'NO_VERIFIED_COVERAGE', country });
  }
  return gaps;
}

export function factsFingerprint(facts: ComplianceFacts): string {
  return fingerprint(facts as unknown as CanonicalValue);
}

/** Fingerprint of the exact rule versions an evaluation recorded (sorted). */
export function rulesFingerprint(
  versions: Array<Pick<RuleVersionInput, 'ruleReference' | 'version' | 'definitionSha256'>>,
): string {
  return fingerprint(
    versions
      .map(({ ruleReference, version, definitionSha256 }) => ({
        rule: ruleReference,
        version,
        sha256: definitionSha256,
      }))
      .sort((left, right) => (left.rule < right.rule ? -1 : left.rule > right.rule ? 1 : 0)),
  );
}

/**
 * Evaluates the facts against the rule versions in effect on the travel date
 * (one per rule, already selected by the caller). Versions whose journey
 * scope does not match are not relevant and are not recorded.
 */
export function evaluateCompliance(
  facts: ComplianceFacts,
  versions: RuleVersionInput[],
): EngineResult {
  const ordered = [...versions].sort((left, right) =>
    left.ruleReference < right.ruleReference
      ? -1
      : left.ruleReference > right.ruleReference
        ? 1
        : 0,
  );
  const relevant = ordered.filter((version) => geographyMatches(version.definition.scope, facts));
  const applicable = relevant.filter((version) => personMatches(version.definition.scope, facts));

  const outcomes: RuleOutcomeRecord[] = relevant.map((version) => {
    if (!personMatches(version.definition.scope, facts)) {
      return {
        versionId: version.versionId,
        ruleReference: version.ruleReference,
        version: version.version,
        outcome: 'NOT_APPLICABLE',
        reasonCode: REASON.NOT_APPLICABLE,
        details: [],
        evidence: [],
      };
    }
    const evaluated = evaluateRequirement(version.definition.requirement, facts);
    return {
      versionId: version.versionId,
      ruleReference: version.ruleReference,
      version: version.version,
      outcome: evaluated.outcome,
      reasonCode: REASON[evaluated.outcome],
      details: evaluated.details,
      evidence: evaluated.evidence,
    };
  });

  const findings: Finding[] = [
    ...(applicable.length === 0 ? [{ code: 'NO_APPLICABLE_RULE' }] : []),
    ...coverageGaps(facts, applicable),
  ];
  const active = outcomes.filter((outcome) => outcome.outcome !== 'NOT_APPLICABLE');
  const result: MachineResult = active.some((outcome) => outcome.outcome === 'FAIL')
    ? 'FAIL'
    : active.some((outcome) => outcome.outcome === 'REVIEW_REQUIRED') || findings.length > 0
      ? 'REVIEW_REQUIRED'
      : 'PASS';

  return {
    result,
    findings,
    outcomes,
    factsFingerprint: factsFingerprint(facts),
    rulesFingerprint: rulesFingerprint(relevant),
  };
}
