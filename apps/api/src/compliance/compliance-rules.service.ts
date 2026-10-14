import { Prisma, type DatabaseTransaction } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import { PublicApiError } from '../auth/http/public-api-error.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import {
  generateRuleReference,
  normalizeRuleReference,
  withFreshReference,
} from './compliance-references.js';
import { ComplianceErrors } from './compliance.errors.js';
import type { RuleVersionContent } from './compliance.dto.js';
import { ruleVersionView, versionInclude } from './compliance-views.js';
import { parseRuleDefinition } from './rule-language.js';

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
const isoDay = (date: Date) => date.toISOString().slice(0, 10);

function translate(error: unknown): never {
  if (error instanceof PublicApiError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw ComplianceErrors.draftExists();
  }
  throw error;
}

async function mutation<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    return translate(error);
  }
}

interface LockedRule {
  id: string;
  reference: string;
}

/**
 * Lock order for every rule write: the compliance_rule row FOR UPDATE, then
 * its versions. Editing, verifying, publishing and retiring versions of one
 * rule are therefore serialized: a publication never interleaves with an
 * edit or a verification of the same draft.
 */
async function lockRule(tx: DatabaseTransaction, rawReference: string): Promise<LockedRule> {
  const reference = normalizeRuleReference(rawReference);
  if (!reference) throw ComplianceErrors.ruleNotFound();
  const [rule] = await tx.$queryRaw<LockedRule[]>`
    SELECT "id", "reference" FROM "compliance_rule" WHERE "reference" = ${reference} FOR UPDATE`;
  if (!rule) throw ComplianceErrors.ruleNotFound();
  return rule;
}

/**
 * STAFF administration of regulatory rules. CODE_IS_NOT_LEGAL_AUTHORITY:
 * the service stores, verifies, versions and publishes rules entered by
 * authorized people from official sources; it never creates one itself.
 */
@Injectable()
export class ComplianceRulesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** Validates a version's content and returns the normalized definition. */
  private async validated(tx: DatabaseTransaction, content: RuleVersionContent) {
    const parsed = parseRuleDefinition(content.definition);
    if (!parsed.ok) throw ComplianceErrors.definitionInvalid(parsed.issues);
    if (parsed.countries.length > 0) {
      const known = await tx.country.findMany({
        where: { iso2: { in: parsed.countries } },
        select: { iso2: true },
      });
      const missing = parsed.countries.filter((code) => !known.some((row) => row.iso2 === code));
      if (missing.length > 0) throw ComplianceErrors.countryUnknown(missing);
    }
    return {
      languageVersion: 1,
      definition: parsed.definition as unknown as Prisma.InputJsonValue,
      definitionSha256: parsed.sha256,
      customerGuidance: content.customerGuidance,
      effectiveFrom: day(content.effectiveFrom),
      effectiveTo: content.effectiveTo === null ? null : day(content.effectiveTo),
      sourceAuthority: content.source.authority,
      sourceTitle: content.source.title,
      sourceUrl: content.source.url,
      sourceReference: content.source.reference,
    };
  }

  async list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: 'DRAFT' | 'PUBLISHED' | 'RETIRED' | undefined;
  }) {
    const rules = await this.database.client.complianceRule.findMany({
      where: {
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        ...(query.status ? { versions: { some: { status: query.status } } } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      select: {
        id: true,
        reference: true,
        title: true,
        createdAt: true,
        versions: {
          orderBy: { version: 'desc' },
          select: {
            version: true,
            status: true,
            verificationStatus: true,
            effectiveFrom: true,
            effectiveTo: true,
          },
        },
      },
    });
    const page = rules.slice(0, query.limit);
    return {
      items: page.map((rule) => ({
        reference: rule.reference,
        title: rule.title,
        createdAt: rule.createdAt,
        versions: rule.versions.map((version) => ({
          version: version.version,
          status: version.status,
          verificationStatus: version.verificationStatus,
          effectiveFrom: isoDay(version.effectiveFrom),
          effectiveTo: version.effectiveTo ? isoDay(version.effectiveTo) : null,
        })),
      })),
      nextCursor: rules.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async detail(rawReference: string) {
    const reference = normalizeRuleReference(rawReference);
    if (!reference) throw ComplianceErrors.ruleNotFound();
    const rule = await this.database.client.complianceRule.findUnique({
      where: { reference },
      select: {
        reference: true,
        title: true,
        createdAt: true,
        versions: { orderBy: { version: 'desc' }, include: versionInclude },
      },
    });
    if (!rule) throw ComplianceErrors.ruleNotFound();
    return { ...rule, versions: rule.versions.map(ruleVersionView) };
  }

  async create(input: { title: string; version: RuleVersionContent }, actor: AuthPrincipal) {
    const reference = await mutation(() =>
      withFreshReference(
        (candidate) =>
          this.database.client.$transaction(async (tx) => {
            const content = await this.validated(tx, input.version);
            const rule = await tx.complianceRule.create({
              data: { reference: candidate, title: input.title },
            });
            const version = await tx.complianceRuleVersion.create({
              data: { ruleId: rule.id, version: 1, ...content },
            });
            await this.audit.record(
              {
                actor,
                action: 'COMPLIANCE_RULE_CREATED',
                resourceType: 'compliance_rule',
                resourceId: rule.id,
                after: { reference: candidate, title: input.title },
              },
              tx,
            );
            await this.audit.record(
              {
                actor,
                action: 'COMPLIANCE_RULE_VERSION_CREATED',
                resourceType: 'compliance_rule_version',
                resourceId: version.id,
                after: {
                  reference: candidate,
                  version: 1,
                  definitionSha256: content.definitionSha256,
                },
              },
              tx,
            );
            return candidate;
          }),
        (error) =>
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002' &&
          String(error.meta?.target ?? '').includes('reference'),
        generateRuleReference,
      ),
    );
    return this.detail(reference);
  }

  /** Next DRAFT: the given content, or a copy of the latest version's content. */
  async createVersion(
    rawReference: string,
    input: RuleVersionContent | undefined,
    actor: AuthPrincipal,
  ) {
    const reference = await mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const rule = await lockRule(tx, rawReference);
        const versions = await tx.complianceRuleVersion.findMany({
          where: { ruleId: rule.id },
          orderBy: { version: 'desc' },
        });
        if (versions.some((version) => version.status === 'DRAFT'))
          throw ComplianceErrors.draftExists();
        const latest = versions[0]!;
        const content = input
          ? await this.validated(tx, input)
          : await this.validated(tx, {
              definition: latest.definition,
              customerGuidance: latest.customerGuidance,
              effectiveFrom: isoDay(latest.effectiveFrom),
              effectiveTo: latest.effectiveTo ? isoDay(latest.effectiveTo) : null,
              source: {
                authority: latest.sourceAuthority,
                title: latest.sourceTitle,
                url: latest.sourceUrl,
                reference: latest.sourceReference,
              },
            });
        const created = await tx.complianceRuleVersion.create({
          data: { ruleId: rule.id, version: latest.version + 1, ...content },
        });
        await this.audit.record(
          {
            actor,
            action: 'COMPLIANCE_RULE_VERSION_CREATED',
            resourceType: 'compliance_rule_version',
            resourceId: created.id,
            after: {
              reference: rule.reference,
              version: created.version,
              definitionSha256: content.definitionSha256,
              copiedFromVersion: input ? null : latest.version,
            },
          },
          tx,
        );
        return rule.reference;
      }),
    );
    return this.detail(reference);
  }

  private async lockedVersion(tx: DatabaseTransaction, rule: LockedRule, version: number) {
    const row = await tx.complianceRuleVersion.findUnique({
      where: { ruleId_version: { ruleId: rule.id, version } },
    });
    if (!row) throw ComplianceErrors.versionNotFound();
    return row;
  }

  /** Replaces a DRAFT's content; any change drops its verification. */
  async updateDraft(
    rawReference: string,
    version: number,
    input: RuleVersionContent,
    actor: AuthPrincipal,
  ) {
    const reference = await mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const rule = await lockRule(tx, rawReference);
        const current = await this.lockedVersion(tx, rule, version);
        if (current.status !== 'DRAFT') throw ComplianceErrors.versionNotDraft();
        const content = await this.validated(tx, input);
        await tx.complianceRuleVersion.update({
          where: { id: current.id },
          data: {
            ...content,
            verificationStatus: 'UNVERIFIED',
            verifiedAt: null,
            verifiedByIdentityId: null,
            verifiedDefinitionSha256: null,
            verificationNote: null,
            sourceCheckedOn: null,
          },
        });
        await this.audit.record(
          {
            actor,
            action: 'COMPLIANCE_RULE_VERSION_UPDATED',
            resourceType: 'compliance_rule_version',
            resourceId: current.id,
            before: {
              definitionSha256: current.definitionSha256,
              verificationStatus: current.verificationStatus,
            },
            after: { definitionSha256: content.definitionSha256, verificationStatus: 'UNVERIFIED' },
            metadata: { reference: rule.reference, version },
          },
          tx,
        );
        return rule.reference;
      }),
    );
    return this.detail(reference);
  }

  /**
   * Records that an authorized person checked this exact definition against
   * the cited official source. The digest pins what they read.
   */
  async verify(
    rawReference: string,
    version: number,
    input: { definitionSha256: string; sourceCheckedOn: string; note?: string | undefined },
    actor: AuthPrincipal,
  ) {
    const reference = await mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const rule = await lockRule(tx, rawReference);
        const current = await this.lockedVersion(tx, rule, version);
        if (current.status !== 'DRAFT') throw ComplianceErrors.versionNotDraft();
        if (current.definitionSha256 !== input.definitionSha256)
          throw ComplianceErrors.contentChanged();
        if (
          !current.sourceAuthority ||
          !current.sourceTitle ||
          (!current.sourceUrl && !current.sourceReference)
        ) {
          throw ComplianceErrors.sourceIncomplete();
        }
        const [{ today }] = await tx.$queryRaw<[{ today: Date }]>`SELECT CURRENT_DATE AS "today"`;
        if (input.sourceCheckedOn > isoDay(today)) throw ComplianceErrors.sourceCheckedInFuture();
        const parsed = parseRuleDefinition(current.definition);
        if (!parsed.ok || parsed.sha256 !== current.definitionSha256) {
          throw ComplianceErrors.definitionInvalid(parsed.ok ? [] : parsed.issues);
        }
        const [{ now }] = await tx.$queryRaw<[{ now: Date }]>`SELECT now() AS "now"`;
        await tx.complianceRuleVersion.update({
          where: { id: current.id },
          data: {
            verificationStatus: 'VERIFIED',
            verifiedAt: now,
            verifiedByIdentityId: actor.identityId,
            verifiedDefinitionSha256: current.definitionSha256,
            verificationNote: input.note ?? null,
            sourceCheckedOn: day(input.sourceCheckedOn),
          },
        });
        await this.audit.record(
          {
            actor,
            action: 'COMPLIANCE_RULE_VERIFIED',
            resourceType: 'compliance_rule_version',
            resourceId: current.id,
            after: {
              reference: rule.reference,
              version,
              definitionSha256: current.definitionSha256,
              sourceCheckedOn: input.sourceCheckedOn,
            },
          },
          tx,
        );
        return rule.reference;
      }),
    );
    return this.detail(reference);
  }

  /**
   * Explicit business operation: the server decides, from the locked row,
   * that the draft is verified, unchanged since verification and valid.
   */
  async publish(
    rawReference: string,
    version: number,
    definitionSha256: string,
    actor: AuthPrincipal,
  ) {
    const reference = await mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const rule = await lockRule(tx, rawReference);
        const current = await this.lockedVersion(tx, rule, version);
        if (current.status !== 'DRAFT') throw ComplianceErrors.versionNotDraft();
        if (current.definitionSha256 !== definitionSha256) throw ComplianceErrors.contentChanged();
        if (
          current.verificationStatus !== 'VERIFIED' ||
          current.verifiedDefinitionSha256 !== current.definitionSha256
        ) {
          throw ComplianceErrors.notVerified();
        }
        const parsed = parseRuleDefinition(current.definition);
        if (!parsed.ok || parsed.sha256 !== current.definitionSha256) {
          throw ComplianceErrors.definitionInvalid(parsed.ok ? [] : parsed.issues);
        }
        const [{ now }] = await tx.$queryRaw<[{ now: Date }]>`SELECT now() AS "now"`;
        const published = await tx.complianceRuleVersion.updateMany({
          where: { id: current.id, status: 'DRAFT', verificationStatus: 'VERIFIED' },
          data: { status: 'PUBLISHED', publishedAt: now, publishedByIdentityId: actor.identityId },
        });
        if (published.count !== 1) throw ComplianceErrors.versionNotDraft();
        await this.audit.record(
          {
            actor,
            action: 'COMPLIANCE_RULE_PUBLISHED',
            resourceType: 'compliance_rule_version',
            resourceId: current.id,
            before: { status: 'DRAFT' },
            after: {
              reference: rule.reference,
              version,
              status: 'PUBLISHED',
              definitionSha256,
              effectiveFrom: isoDay(current.effectiveFrom),
              effectiveTo: current.effectiveTo ? isoDay(current.effectiveTo) : null,
            },
          },
          tx,
        );
        return rule.reference;
      }),
    );
    return this.detail(reference);
  }

  /** Withdraws a published version from every future evaluation (history kept). */
  async retire(rawReference: string, version: number, reason: string, actor: AuthPrincipal) {
    const reference = await mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const rule = await lockRule(tx, rawReference);
        const current = await this.lockedVersion(tx, rule, version);
        if (current.status !== 'PUBLISHED') throw ComplianceErrors.versionNotPublished();
        const [{ now }] = await tx.$queryRaw<[{ now: Date }]>`SELECT now() AS "now"`;
        await tx.complianceRuleVersion.update({
          where: { id: current.id },
          data: {
            status: 'RETIRED',
            retiredAt: now,
            retiredByIdentityId: actor.identityId,
            retirementReason: reason,
          },
        });
        await this.audit.record(
          {
            actor,
            action: 'COMPLIANCE_RULE_RETIRED',
            resourceType: 'compliance_rule_version',
            resourceId: current.id,
            before: { status: 'PUBLISHED' },
            after: { reference: rule.reference, version, status: 'RETIRED' },
          },
          tx,
        );
        return rule.reference;
      }),
    );
    return this.detail(reference);
  }
}
