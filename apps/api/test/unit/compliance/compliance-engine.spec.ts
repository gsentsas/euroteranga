import { describe, expect, it } from 'vitest';
import { canonicalJson, fingerprint } from '../../../src/compliance/canonical-json.js';
import {
  addDays,
  ENGINE_VERSION,
  evaluateCompliance,
  factsFingerprint,
  rulesFingerprint,
  type ComplianceFacts,
  type RuleVersionInput,
} from '../../../src/compliance/compliance-engine.js';
import { parseRuleDefinition, type RuleDefinition } from '../../../src/compliance/rule-language.js';

// Synthetic countries and rules only: no real regulatory requirement.
const facts = (overrides: Partial<ComplianceFacts> = {}): ComplianceFacts => ({
  factsVersion: 1,
  travelDate: '2030-06-16',
  arrivalDate: '2030-06-17',
  originCountry: 'QA',
  destinationCountry: 'QB',
  transitCountries: ['QT'],
  nationality: 'QN',
  ageOnTravelDate: 34,
  documents: [],
  ...overrides,
});

let counter = 0;
function rule(definition: Omit<RuleDefinition, 'language'>, reference?: string): RuleVersionInput {
  const parsed = parseRuleDefinition({ language: 1, ...definition });
  if (!parsed.ok) throw new Error(`invalid synthetic rule: ${JSON.stringify(parsed.issues)}`);
  counter += 1;
  return {
    versionId: `00000000-0000-7000-8000-${String(counter).padStart(12, '0')}`,
    ruleReference: reference ?? `ETCR-${String(counter).padStart(12, '0')}`,
    version: 1,
    definitionSha256: parsed.sha256,
    definition: parsed.definition,
  };
}

const passport = (expiresAt: string | null, reference = 'ETD-000000000001') => ({
  reference,
  type: 'PASSPORT' as const,
  expiresAt,
});

/** Synthetic coverage of the whole synthetic journey, with no document asked. */
const fullCoverage = () =>
  rule({
    scope: { destinationCountries: ['QB'], transitCountries: ['QT'] },
    requirement: { kind: 'NO_DOCUMENT_REQUIRED' },
  });

describe('compliance engine: absence of rules is never compliance', () => {
  it('returns REVIEW_REQUIRED with no rule at all (EMPTY_RULESET != COMPLIANT)', () => {
    const result = evaluateCompliance(facts(), []);
    expect(result.result).toBe('REVIEW_REQUIRED');
    expect(result.result).not.toBe('PASS');
    expect(result.result).not.toBe('FAIL');
    expect(result.findings).toEqual([
      { code: 'NO_APPLICABLE_RULE' },
      { code: 'NO_VERIFIED_COVERAGE', country: 'QT' },
      { code: 'NO_VERIFIED_COVERAGE', country: 'QB' },
    ]);
    expect(result.outcomes).toEqual([]);
  });

  it('never turns a technically ACCEPTED passport into PASS without verified coverage', () => {
    const result = evaluateCompliance(facts({ documents: [passport('2040-01-01')] }), []);
    expect(result.result).toBe('REVIEW_REQUIRED');
    const unrelated = rule({
      scope: { destinationCountries: ['QZ'] },
      requirement: { kind: 'DOCUMENT', documentType: 'PASSPORT' },
    });
    expect(
      evaluateCompliance(facts({ documents: [passport('2040-01-01')] }), [unrelated]).result,
    ).toBe('REVIEW_REQUIRED');
  });

  it('requires explicit coverage of each transit and destination country', () => {
    const destinationOnly = rule({
      scope: { destinationCountries: ['QB'] },
      requirement: { kind: 'NO_DOCUMENT_REQUIRED' },
    });
    const result = evaluateCompliance(facts(), [destinationOnly]);
    expect(result.result).toBe('REVIEW_REQUIRED');
    expect(result.findings).toEqual([{ code: 'NO_VERIFIED_COVERAGE', country: 'QT' }]);
    expect(evaluateCompliance(facts(), [fullCoverage()]).result).toBe('PASS');
  });

  it('does not let a rule without a destination list cover the destination', () => {
    // No transit: the destination alone decides, and only explicit naming covers it.
    const direct = facts({ transitCountries: [] });
    const global = rule({ scope: {}, requirement: { kind: 'NO_DOCUMENT_REQUIRED' } });
    const result = evaluateCompliance(direct, [global]);
    expect(result.result).toBe('REVIEW_REQUIRED');
    expect(result.findings).toEqual([{ code: 'NO_VERIFIED_COVERAGE', country: 'QB' }]);
    const named = rule({
      scope: { destinationCountries: ['QB'] },
      requirement: { kind: 'NO_DOCUMENT_REQUIRED' },
    });
    expect(evaluateCompliance(direct, [named]).result).toBe('PASS');
  });

  it('does not count a rule that names no country as coverage', () => {
    const global = rule({ scope: {}, requirement: { kind: 'NO_DOCUMENT_REQUIRED' } });
    const result = evaluateCompliance(facts(), [global]);
    expect(result.result).toBe('REVIEW_REQUIRED');
    expect(result.outcomes.map((outcome) => outcome.outcome)).toEqual(['PASS']);
  });
});

describe('compliance engine: scope matching', () => {
  const needsPassport = (scope: RuleDefinition['scope']) =>
    rule({ scope, requirement: { kind: 'DOCUMENT', documentType: 'PASSPORT' } });

  it.each([
    ['nationality', { nationalities: ['QN'] }, true],
    ['other nationality', { nationalities: ['QX'] }, false],
    ['origin', { originCountries: ['QA'] }, true],
    ['other origin', { originCountries: ['QX'] }, false],
    ['destination', { destinationCountries: ['QB'] }, true],
    ['transit', { transitCountries: ['QX', 'QT'] }, true],
    ['no such transit', { transitCountries: ['QX'] }, false],
    ['age within', { minAgeOnTravelDate: 18, maxAgeOnTravelDate: 64 }, true],
    ['age below', { minAgeOnTravelDate: 35 }, false],
    ['age above', { maxAgeOnTravelDate: 33 }, false],
  ] as Array<[string, RuleDefinition['scope'], boolean]>)(
    'applies a rule by %s',
    (_label, scope, applies) => {
      const result = evaluateCompliance(facts(), [needsPassport(scope)]);
      const outcome = result.outcomes[0]?.outcome;
      if (applies) expect(outcome).toBe('FAIL');
      else expect(outcome ?? 'NOT_RELEVANT').not.toBe('FAIL');
    },
  );

  it('records a geographically relevant rule that does not apply to the person as NOT_APPLICABLE', () => {
    const minors = rule({
      scope: { destinationCountries: ['QB'], maxAgeOnTravelDate: 17 },
      requirement: { kind: 'DOCUMENT', documentType: 'PARENTAL_AUTHORIZATION' },
    });
    const adult = evaluateCompliance(facts(), [minors, fullCoverage()]);
    expect(adult.outcomes.find((o) => o.versionId === minors.versionId)).toMatchObject({
      outcome: 'NOT_APPLICABLE',
      reasonCode: 'SCOPE_NOT_MATCHED',
    });
    expect(adult.result).toBe('PASS');
    const child = evaluateCompliance(facts({ ageOnTravelDate: 12 }), [minors, fullCoverage()]);
    expect(child.result).toBe('FAIL');
    expect(child.outcomes.find((o) => o.versionId === minors.versionId)?.details).toEqual([
      { code: 'DOCUMENT_MISSING', documentType: 'PARENTAL_AUTHORIZATION' },
    ]);
  });

  it('ignores rules for another journey entirely', () => {
    const elsewhere = needsPassport({ originCountries: ['QX'] });
    expect(evaluateCompliance(facts(), [elsewhere, fullCoverage()]).outcomes).toHaveLength(1);
  });
});

describe('compliance engine: documents and validity relative to the travel date', () => {
  const validFor = (from: 'TRAVEL_DATE' | 'ARRIVAL_DATE', days: number, humanCheck?: boolean) =>
    rule({
      scope: { destinationCountries: ['QB'], transitCountries: ['QT'] },
      requirement: {
        kind: 'DOCUMENT',
        documentType: 'PASSPORT',
        minValidity: { from, days },
        ...(humanCheck === undefined ? {} : { humanCheck }),
      },
    });

  it('passes with a document valid long enough and cites it as evidence', () => {
    const result = evaluateCompliance(facts({ documents: [passport('2030-09-14')] }), [
      validFor('TRAVEL_DATE', 90),
    ]);
    expect(result.result).toBe('PASS');
    expect(result.outcomes[0]).toMatchObject({
      outcome: 'PASS',
      reasonCode: 'REQUIREMENT_MET',
      evidence: ['ETD-000000000001'],
      details: [{ code: 'DOCUMENT_PRESENT', documentType: 'PASSPORT' }],
    });
  });

  it('fails one day short and measures from the arrival date when asked', () => {
    expect(addDays('2030-06-16', 90)).toBe('2030-09-14');
    expect(
      evaluateCompliance(facts({ documents: [passport('2030-09-13')] }), [
        validFor('TRAVEL_DATE', 90),
      ]).outcomes[0],
    ).toMatchObject({ outcome: 'FAIL', details: [{ code: 'DOCUMENT_VALIDITY_TOO_SHORT' }] });
    expect(
      evaluateCompliance(facts({ documents: [passport('2030-09-14')] }), [
        validFor('ARRIVAL_DATE', 90),
      ]).result,
    ).toBe('FAIL');
  });

  it('asks for a human when the expiry is unknown or when the rule demands a human check', () => {
    expect(
      evaluateCompliance(facts({ documents: [passport(null)] }), [validFor('TRAVEL_DATE', 0)])
        .outcomes[0],
    ).toMatchObject({ outcome: 'REVIEW_REQUIRED', details: [{ code: 'DOCUMENT_EXPIRY_UNKNOWN' }] });
    expect(
      evaluateCompliance(facts({ documents: [passport('2040-01-01')] }), [
        validFor('TRAVEL_DATE', 0, true),
      ]).outcomes[0],
    ).toMatchObject({
      outcome: 'REVIEW_REQUIRED',
      details: [{ code: 'DOCUMENT_REQUIRES_HUMAN_CHECK' }],
      evidence: ['ETD-000000000001'],
    });
  });

  it('fails when the required document is missing', () => {
    expect(evaluateCompliance(facts(), [validFor('TRAVEL_DATE', 0)]).outcomes[0]).toMatchObject({
      outcome: 'FAIL',
      details: [{ code: 'DOCUMENT_MISSING', documentType: 'PASSPORT' }],
      evidence: [],
    });
  });

  it('combines requirements with ALL_OF and ANY_OF in three-valued logic', () => {
    const both = rule({
      scope: { destinationCountries: ['QB'], transitCountries: ['QT'] },
      requirement: {
        kind: 'ALL_OF',
        requirements: [
          { kind: 'DOCUMENT', documentType: 'PASSPORT' },
          { kind: 'DOCUMENT', documentType: 'VISA' },
        ],
      },
    });
    const either = rule({
      scope: { destinationCountries: ['QB'], transitCountries: ['QT'] },
      requirement: {
        kind: 'ANY_OF',
        requirements: [
          { kind: 'DOCUMENT', documentType: 'PASSPORT' },
          { kind: 'DOCUMENT', documentType: 'NATIONAL_ID' },
        ],
      },
    });
    const onlyPassport = facts({ documents: [passport(null)] });
    expect(evaluateCompliance(onlyPassport, [both]).result).toBe('FAIL');
    expect(evaluateCompliance(onlyPassport, [either]).result).toBe('PASS');
    const review = rule({
      scope: { destinationCountries: ['QB'], transitCountries: ['QT'] },
      requirement: {
        kind: 'ANY_OF',
        requirements: [{ kind: 'HUMAN_REVIEW' }, { kind: 'DOCUMENT', documentType: 'VISA' }],
      },
    });
    expect(evaluateCompliance(onlyPassport, [review]).result).toBe('REVIEW_REQUIRED');
  });

  it('lets FAIL dominate REVIEW_REQUIRED across rules', () => {
    const fails = rule({
      scope: { destinationCountries: ['QB'] },
      requirement: { kind: 'DOCUMENT', documentType: 'VISA' },
    });
    const review = rule({
      scope: { transitCountries: ['QT'] },
      requirement: { kind: 'HUMAN_REVIEW' },
    });
    expect(evaluateCompliance(facts(), [review, fails]).result).toBe('FAIL');
  });
});

describe('compliance engine: determinism and fingerprints', () => {
  it('gives the same result and fingerprints for the same facts and versions', () => {
    const versions = [fullCoverage(), rule({ scope: {}, requirement: { kind: 'HUMAN_REVIEW' } })];
    const first = evaluateCompliance(facts(), versions);
    const second = evaluateCompliance(facts(), [...versions].reverse());
    expect(second).toEqual(first);
    expect(ENGINE_VERSION).toBe('compliance-engine/1');
  });

  it('changes the facts fingerprint on any fact change, never on key order', () => {
    const base = facts({ documents: [passport('2031-01-01')] });
    const reordered = Object.fromEntries(
      Object.entries(base).reverse(),
    ) as unknown as ComplianceFacts;
    expect(factsFingerprint(reordered)).toBe(factsFingerprint(base));
    for (const changed of [
      facts({ documents: [passport('2031-01-02')] }),
      facts({ documents: [passport('2031-01-01'), passport(null, 'ETD-000000000002')] }),
      facts({ travelDate: '2030-06-17' }),
      facts({ nationality: 'QM' }),
      facts({ ageOnTravelDate: 35 }),
      facts({ transitCountries: [] }),
    ]) {
      expect(factsFingerprint(changed)).not.toBe(factsFingerprint(base));
    }
  });

  it('changes the rules fingerprint with the version or its definition, not with ordering', () => {
    const a = { ruleReference: 'ETCR-AAAAAAAAAAAA', version: 1, definitionSha256: 'a'.repeat(64) };
    const b = { ruleReference: 'ETCR-BBBBBBBBBBBB', version: 3, definitionSha256: 'b'.repeat(64) };
    expect(rulesFingerprint([a, b])).toBe(rulesFingerprint([b, a]));
    expect(rulesFingerprint([a, { ...b, version: 4 }])).not.toBe(rulesFingerprint([a, b]));
    expect(rulesFingerprint([a, { ...b, definitionSha256: 'c'.repeat(64) }])).not.toBe(
      rulesFingerprint([a, b]),
    );
    expect(rulesFingerprint([a])).not.toBe(rulesFingerprint([a, b]));
  });

  it('canonicalizes JSON independently of key order', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'] })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(fingerprint({ b: 1, a: 2 })).toBe(fingerprint({ a: 2, b: 1 }));
    expect(() => canonicalJson(Number.NaN)).toThrow(/finite/);
  });
});
