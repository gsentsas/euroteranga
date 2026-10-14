import { describe, expect, it } from 'vitest';
import {
  parseRuleDefinition,
  RULE_LIMITS,
  type RuleIssue,
} from '../../../src/compliance/rule-language.js';

const valid = {
  language: 1,
  scope: { destinationCountries: ['QB'], nationalities: ['QN'], minAgeOnTravelDate: 18 },
  requirement: {
    kind: 'ANY_OF',
    requirements: [
      {
        kind: 'DOCUMENT',
        documentType: 'PASSPORT',
        minValidity: { from: 'TRAVEL_DATE', days: 90 },
      },
      { kind: 'DOCUMENT', documentType: 'NATIONAL_ID', humanCheck: true },
    ],
  },
};

/** The same JSON value with every object's keys in reverse insertion order. */
const reverseKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(reverseKeys)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .reverse()
            .map(([key, item]) => [key, reverseKeys(item)]),
        )
      : value;

function issues(input: unknown): RuleIssue[] {
  const result = parseRuleDefinition(input);
  if (result.ok) throw new Error('hostile definition unexpectedly accepted');
  return result.issues;
}

const nest = (depth: number): unknown =>
  depth === 1
    ? { kind: 'DOCUMENT', documentType: 'PASSPORT' }
    : { kind: 'ALL_OF', requirements: [nest(depth - 1), { kind: 'HUMAN_REVIEW' }] };

describe('rule language v1', () => {
  it('accepts a valid synthetic definition with a stable digest and its countries', () => {
    const first = parseRuleDefinition(valid);
    const reordered = parseRuleDefinition(reverseKeys(valid));
    expect(first).toMatchObject({ ok: true, countries: ['QB', 'QN'] });
    expect(reordered.ok && first.ok && reordered.sha256 === first.sha256).toBe(true);
  });

  it.each([
    [
      'unknown requirement kind (operator)',
      { ...valid, requirement: { kind: 'EVAL', code: '1+1' } },
    ],
    ['unknown fact in scope', { ...valid, scope: { passengerName: ['X'] } }],
    ['unknown key on a node', { ...valid, requirement: { kind: 'HUMAN_REVIEW', expression: 'x' } }],
    ['unknown language version', { ...valid, language: 2 }],
    ['missing requirement', { language: 1, scope: {} }],
    ['invalid country identifier', { ...valid, scope: { destinationCountries: ['qb'] } }],
    ['three-letter country', { ...valid, scope: { destinationCountries: ['QBB'] } }],
    ['duplicate country', { ...valid, scope: { destinationCountries: ['QB', 'QB'] } }],
    [
      'invalid document type',
      { ...valid, requirement: { kind: 'DOCUMENT', documentType: 'TICKET' } },
    ],
    [
      'invalid validity days',
      {
        ...valid,
        requirement: {
          kind: 'DOCUMENT',
          documentType: 'VISA',
          minValidity: { from: 'TRAVEL_DATE', days: -1 },
        },
      },
    ],
    [
      'fractional days',
      {
        ...valid,
        requirement: {
          kind: 'DOCUMENT',
          documentType: 'VISA',
          minValidity: { from: 'TRAVEL_DATE', days: 1.5 },
        },
      },
    ],
    [
      'unknown validity reference date',
      {
        ...valid,
        requirement: {
          kind: 'DOCUMENT',
          documentType: 'VISA',
          minValidity: { from: 'NOW', days: 1 },
        },
      },
    ],
    [
      'inverted age bounds',
      { ...valid, scope: { minAgeOnTravelDate: 30, maxAgeOnTravelDate: 20 } },
    ],
    ['excessive age', { ...valid, scope: { maxAgeOnTravelDate: 999 } }],
    ['string instead of number', { ...valid, scope: { minAgeOnTravelDate: '18' } }],
    [
      'date string where a number is expected',
      { ...valid, scope: { minAgeOnTravelDate: '2030-01-01' } },
    ],
    [
      'single-child combinator',
      { ...valid, requirement: { kind: 'ALL_OF', requirements: [{ kind: 'HUMAN_REVIEW' }] } },
    ],
    [
      'too many children',
      {
        ...valid,
        requirement: {
          kind: 'ANY_OF',
          requirements: Array.from({ length: RULE_LIMITS.maxChildren + 1 }, () => ({
            kind: 'HUMAN_REVIEW',
          })),
        },
      },
    ],
    [
      'oversized country list',
      {
        ...valid,
        scope: {
          destinationCountries: Array.from(
            { length: 61 },
            (_v, i) => `Q${String.fromCharCode(65 + (i % 26))}`,
          ),
        },
      },
    ],
    ['array instead of object', [valid]],
    ['scalar', 'ALL_OF'],
    ['null', null],
  ])('rejects %s', (_label, input) => {
    expect(issues(input).length).toBeGreaterThan(0);
  });

  it('rejects prototype-pollution keys anywhere, even as raw JSON text', () => {
    for (const text of [
      '{"language":1,"scope":{},"requirement":{"kind":"HUMAN_REVIEW"},"__proto__":{"polluted":true}}',
      '{"language":1,"scope":{"constructor":{"prototype":{"x":1}}},"requirement":{"kind":"HUMAN_REVIEW"}}',
      '{"language":1,"scope":{},"requirement":{"kind":"HUMAN_REVIEW","prototype":1}}',
    ]) {
      expect(issues(JSON.parse(text))).toContainEqual(
        expect.objectContaining({ code: 'FORBIDDEN_KEY' }),
      );
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('bounds nesting, node count and value size before the grammar runs', () => {
    expect(issues({ ...valid, requirement: nest(RULE_LIMITS.maxRequirementDepth + 1) })).toEqual([
      { path: '/requirement', code: 'REQUIREMENT_TOO_DEEP' },
    ]);
    let deep: unknown = { kind: 'HUMAN_REVIEW' };
    for (let index = 0; index < 5_000; index += 1)
      deep = { kind: 'ALL_OF', requirements: [deep, deep] };
    expect(issues({ ...valid, requirement: deep })[0]?.code).toMatch(/TOO_DEEP|TOO_MANY_NODES/);
    let rawDeep: unknown = 1;
    for (let index = 0; index < 100_000; index += 1) rawDeep = [rawDeep];
    expect(issues({ ...valid, scope: { nested: rawDeep } })[0]?.code).toBe('TOO_DEEP');
    expect(
      issues({ ...valid, scope: { destinationCountries: ['Q'.repeat(10_000)] } })[0]?.code,
    ).toBe('VALUE_TOO_LONG');
    expect(
      issues({ ...valid, scope: { nationalities: Array.from({ length: 1_000 }, () => 'QA') } })[0]
        ?.code,
    ).toBe('TOO_MANY_NODES');
  });

  it('accepts the documented maximum requirement depth', () => {
    expect(
      parseRuleDefinition({ ...valid, requirement: nest(RULE_LIMITS.maxRequirementDepth) }).ok,
    ).toBe(true);
  });
});
