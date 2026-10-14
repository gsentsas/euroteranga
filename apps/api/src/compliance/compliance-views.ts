import type { Prisma } from '@euroteranga/database';
import type { ComplianceStatus } from './compliance.dto.js';

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

export const versionInclude = {
  verifiedBy: { select: { email: true } },
  publishedBy: { select: { email: true } },
  retiredBy: { select: { email: true } },
} as const satisfies Prisma.ComplianceRuleVersionInclude;

type VersionRow = Prisma.ComplianceRuleVersionGetPayload<{ include: typeof versionInclude }>;

/** STAFF view of a rule version, provenance included. */
export function ruleVersionView(version: VersionRow) {
  return {
    version: version.version,
    status: version.status,
    languageVersion: version.languageVersion,
    definition: version.definition,
    definitionSha256: version.definitionSha256,
    customerGuidance: version.customerGuidance,
    effectiveFrom: isoDay(version.effectiveFrom),
    effectiveTo: version.effectiveTo ? isoDay(version.effectiveTo) : null,
    source: {
      authority: version.sourceAuthority,
      title: version.sourceTitle,
      url: version.sourceUrl,
      reference: version.sourceReference,
      checkedOn: version.sourceCheckedOn ? isoDay(version.sourceCheckedOn) : null,
    },
    verification: {
      status: version.verificationStatus,
      verifiedAt: version.verifiedAt,
      verifiedBy: version.verifiedBy?.email ?? null,
      note: version.verificationNote,
    },
    publishedAt: version.publishedAt,
    publishedBy: version.publishedBy?.email ?? null,
    retiredAt: version.retiredAt,
    retiredBy: version.retiredBy?.email ?? null,
    retirementReason: version.retirementReason,
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
  };
}

/**
 * One status for CUSTOMER and STAFF. A stale or superseded evaluation and its
 * reviews are history, never current compliance:
 * - no evaluation -> NOT_EVALUATED; stale latest evaluation -> STALE;
 * - a review of the current evaluation decides (COMPLIANT, NON_COMPLIANT,
 *   NEEDS_INFORMATION);
 * - otherwise the machine result, qualified "by published rules".
 */
export function complianceStatus(
  latest: { result: 'PASS' | 'FAIL' | 'REVIEW_REQUIRED' } | null,
  current: boolean,
  latestReview: { decision: 'COMPLIANT' | 'NON_COMPLIANT' | 'NEEDS_INFORMATION' } | null,
): ComplianceStatus {
  if (!latest) return 'NOT_EVALUATED';
  if (!current) return 'STALE';
  if (latestReview) return latestReview.decision;
  if (latest.result === 'PASS') return 'COMPLIANT_BY_RULES';
  if (latest.result === 'FAIL') return 'NON_COMPLIANT_BY_RULES';
  return 'REVIEW_REQUIRED';
}
