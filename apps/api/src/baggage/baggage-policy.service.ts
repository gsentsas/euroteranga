import { Prisma, type DatabaseTransaction } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import { PublicApiError } from '../auth/http/public-api-error.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type {
  BaggagePolicyCreateInput,
  BaggagePolicyListQuery,
  BaggagePolicyTiersInput,
  BaggagePolicyUpdateInput,
  BaggagePolicyVersionCreateInput,
} from './baggage-policy.dto.js';
import { BaggagePolicyErrors } from './baggage-policy.errors.js';

const tierSelect = {
  id: true,
  code: true,
  label: true,
  maxExcessWeightKg: true,
  chargeMinor: true,
  position: true,
  createdAt: true,
  updatedAt: true,
} as const;

const versionSelect = {
  id: true,
  version: true,
  status: true,
  includedPieces: true,
  includedWeightKgPerPiece: true,
  publishedAt: true,
  retiredAt: true,
  createdAt: true,
  updatedAt: true,
  fareTableVersion: {
    select: {
      id: true,
      version: true,
      status: true,
      fareTable: {
        select: {
          id: true,
          code: true,
          name: true,
          currencyCode: true,
          currencyMinorUnit: true,
        },
      },
    },
  },
  tiers: { orderBy: { position: 'asc' as const }, select: tierSelect },
  _count: { select: { baggage: true } },
} as const satisfies Prisma.BaggagePolicyVersionSelect;

function versionView<
  T extends {
    includedWeightKgPerPiece: { toFixed(digits: number): string };
    tiers: Array<{
      maxExcessWeightKg: { toFixed(digits: number): string };
      chargeMinor: bigint;
    }>;
    _count: { baggage: number };
  },
>(version: T) {
  const { _count, ...rest } = version;
  return {
    ...rest,
    includedWeightKgPerPiece: version.includedWeightKgPerPiece.toFixed(3),
    tiers: version.tiers.map((tier) => ({
      ...tier,
      maxExcessWeightKg: tier.maxExcessWeightKg.toFixed(3),
      chargeMinor: tier.chargeMinor.toString(),
    })),
    baggageCount: _count.baggage,
  };
}

function databaseError(error: unknown): never {
  if (error instanceof PublicApiError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      const target = JSON.stringify(error.meta?.target ?? '');
      if (target.includes('fare_table_version')) throw BaggagePolicyErrors.fareVersionConflict();
      if (target.includes('baggage_policy_id')) throw BaggagePolicyErrors.draftAlreadyExists();
      throw BaggagePolicyErrors.codeConflict();
    }
    if (error.code === 'P2025') throw BaggagePolicyErrors.notFound();
  }
  const message = String(error);
  if (message.includes('currency must match')) throw BaggagePolicyErrors.currencyMismatch();
  if (
    message.includes('not publishable') ||
    message.includes('requires at least one excess tier')
  ) {
    throw BaggagePolicyErrors.notPublishable(
      'La politique doit être active, liée à une version tarifaire publiée et contenir au moins un palier.',
    );
  }
  throw error;
}

async function lockPolicy(tx: DatabaseTransaction, id: string) {
  const rows = await tx.$queryRaw<Array<{ id: string; active: boolean }>>`
    SELECT "id", "active" FROM "baggage_policy"
    WHERE "id" = ${id}::uuid
    FOR UPDATE
  `;
  if (!rows[0]) throw BaggagePolicyErrors.notFound();
  return rows[0];
}

async function lockVersion(tx: DatabaseTransaction, policyId: string, versionId: string) {
  const rows = await tx.$queryRaw<
    Array<{ id: string; status: string; version: number; fare_table_version_id: string }>
  >`
    SELECT "id", "status", "version", "fare_table_version_id"
    FROM "baggage_policy_version"
    WHERE "id" = ${versionId}::uuid
      AND "baggage_policy_id" = ${policyId}::uuid
    FOR UPDATE
  `;
  if (!rows[0]) throw BaggagePolicyErrors.versionNotFound();
  return rows[0];
}

@Injectable()
export class BaggagePolicyService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list(query: BaggagePolicyListQuery) {
    const rows = await this.database.client.baggagePolicy.findMany({
      where: {
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        ...(query.active ? { active: query.active === 'true' } : {}),
      },
      take: query.limit + 1,
      orderBy: { id: 'desc' },
      include: {
        versions: {
          orderBy: { version: 'desc' },
          select: versionSelect,
        },
      },
    });
    const page = rows.slice(0, query.limit);
    return {
      items: page.map((policy) => ({
        ...policy,
        versions: policy.versions.map(versionView),
      })),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async detail(id: string) {
    const row = await this.database.client.baggagePolicy.findUnique({
      where: { id },
      include: {
        versions: {
          orderBy: { version: 'desc' },
          select: versionSelect,
        },
      },
    });
    if (!row) throw BaggagePolicyErrors.notFound();
    return { ...row, versions: row.versions.map(versionView) };
  }

  async create(input: BaggagePolicyCreateInput, actor: AuthPrincipal) {
    try {
      const id = await this.database.client.$transaction(async (tx) => {
        const policy = await tx.baggagePolicy.create({ data: input });
        await this.audit.record(
          {
            actor,
            action: 'BAGGAGE_POLICY_CREATED',
            resourceType: 'baggage_policy',
            resourceId: policy.id,
            after: policy,
          },
          tx,
        );
        return policy.id;
      });
      return this.detail(id);
    } catch (error) {
      return databaseError(error);
    }
  }

  async update(id: string, input: BaggagePolicyUpdateInput, actor: AuthPrincipal) {
    try {
      await this.database.client.$transaction(async (tx) => {
        await lockPolicy(tx, id);
        const before = await tx.baggagePolicy.findUniqueOrThrow({ where: { id } });
        const data: Prisma.BaggagePolicyUpdateInput = {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        };
        const after = await tx.baggagePolicy.update({ where: { id }, data });
        await this.audit.record(
          {
            actor,
            action: 'BAGGAGE_POLICY_UPDATED',
            resourceType: 'baggage_policy',
            resourceId: id,
            before,
            after,
          },
          tx,
        );
      });
      return this.detail(id);
    } catch (error) {
      return databaseError(error);
    }
  }

  async createVersion(
    policyId: string,
    input: BaggagePolicyVersionCreateInput,
    actor: AuthPrincipal,
  ) {
    try {
      await this.database.client.$transaction(async (tx) => {
        await lockPolicy(tx, policyId);
        if (
          await tx.baggagePolicyVersion.findFirst({
            where: { baggagePolicyId: policyId, status: 'DRAFT' },
            select: { id: true },
          })
        ) {
          throw BaggagePolicyErrors.draftAlreadyExists();
        }
        const fare = await tx.fareTableVersion.findUnique({
          where: { id: input.fareTableVersionId },
          select: {
            id: true,
            fareTable: { select: { currencyCode: true, currencyMinorUnit: true } },
          },
        });
        if (!fare) throw BaggagePolicyErrors.fareVersionNotFound();
        const policy = await tx.baggagePolicy.findUniqueOrThrow({
          where: { id: policyId },
          select: { currencyCode: true, currencyMinorUnit: true },
        });
        if (
          fare.fareTable.currencyCode !== policy.currencyCode ||
          fare.fareTable.currencyMinorUnit !== policy.currencyMinorUnit
        ) {
          throw BaggagePolicyErrors.currencyMismatch();
        }
        const latest = await tx.baggagePolicyVersion.findFirst({
          where: { baggagePolicyId: policyId },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const created = await tx.baggagePolicyVersion.create({
          data: {
            baggagePolicyId: policyId,
            fareTableVersionId: input.fareTableVersionId,
            version: (latest?.version ?? 0) + 1,
            includedPieces: input.includedPieces,
            includedWeightKgPerPiece: input.includedWeightKgPerPiece,
          },
        });
        await this.audit.record(
          {
            actor,
            action: 'BAGGAGE_POLICY_VERSION_CREATED',
            resourceType: 'baggage_policy_version',
            resourceId: created.id,
            after: {
              policyId,
              fareTableVersionId: input.fareTableVersionId,
              version: created.version,
              includedPieces: input.includedPieces,
              includedWeightKgPerPiece: input.includedWeightKgPerPiece,
            },
          },
          tx,
        );
      });
      return this.detail(policyId);
    } catch (error) {
      return databaseError(error);
    }
  }

  async replaceTiers(
    policyId: string,
    versionId: string,
    input: BaggagePolicyTiersInput,
    actor: AuthPrincipal,
  ) {
    try {
      await this.database.client.$transaction(async (tx) => {
        await lockPolicy(tx, policyId);
        const version = await lockVersion(tx, policyId, versionId);
        if (version.status !== 'DRAFT') throw BaggagePolicyErrors.versionNotDraft();

        const maxWeights = new Set(input.tiers.map((tier) => tier.maxExcessWeightKg));
        const codes = new Set(input.tiers.map((tier) => tier.code));
        const positions = new Set(input.tiers.map((tier) => tier.position));
        if (
          maxWeights.size !== input.tiers.length ||
          codes.size !== input.tiers.length ||
          positions.size !== input.tiers.length
        ) {
          throw BaggagePolicyErrors.notPublishable(
            'Les codes, poids maximaux et positions des paliers doivent être uniques.',
          );
        }

        const before = await tx.baggageExcessTier.findMany({
          where: { baggagePolicyVersionId: versionId },
          orderBy: { position: 'asc' },
          select: tierSelect,
        });
        await tx.baggageExcessTier.deleteMany({ where: { baggagePolicyVersionId: versionId } });
        await tx.baggageExcessTier.createMany({
          data: input.tiers.map((tier) => ({
            baggagePolicyVersionId: versionId,
            code: tier.code,
            label: tier.label,
            maxExcessWeightKg: tier.maxExcessWeightKg,
            chargeMinor: BigInt(tier.chargeMinor),
            position: tier.position,
          })),
        });
        await this.audit.record(
          {
            actor,
            action: 'BAGGAGE_POLICY_TIERS_REPLACED',
            resourceType: 'baggage_policy_version',
            resourceId: versionId,
            before: {
              count: before.length,
              tiers: before.map((tier) => ({
                code: tier.code,
                maxExcessWeightKg: tier.maxExcessWeightKg.toFixed(3),
                chargeMinor: tier.chargeMinor.toString(),
                position: tier.position,
              })),
            },
            after: {
              count: input.tiers.length,
              tiers: input.tiers.map((tier) => ({
                code: tier.code,
                maxExcessWeightKg: tier.maxExcessWeightKg,
                chargeMinor: tier.chargeMinor,
                position: tier.position,
              })),
            },
          },
          tx,
        );
      });
      return this.detail(policyId);
    } catch (error) {
      return databaseError(error);
    }
  }

  async publish(policyId: string, versionId: string, actor: AuthPrincipal) {
    try {
      await this.database.client.$transaction(async (tx) => {
        await lockPolicy(tx, policyId);
        const version = await lockVersion(tx, policyId, versionId);
        if (version.status !== 'DRAFT') throw BaggagePolicyErrors.versionNotDraft();
        const tierCount = await tx.baggageExcessTier.count({
          where: { baggagePolicyVersionId: versionId },
        });
        if (tierCount < 1) {
          throw BaggagePolicyErrors.notPublishable('Ajoutez au moins un palier d’excédent.');
        }

        const now = new Date();
        const previous = await tx.baggagePolicyVersion.findFirst({
          where: { baggagePolicyId: policyId, status: 'PUBLISHED' },
        });
        if (previous) {
          await tx.baggagePolicyVersion.update({
            where: { id: previous.id },
            data: { status: 'RETIRED', retiredAt: now },
          });
          await this.audit.record(
            {
              actor,
              action: 'BAGGAGE_POLICY_VERSION_RETIRED',
              resourceType: 'baggage_policy_version',
              resourceId: previous.id,
              before: { status: 'PUBLISHED', version: previous.version },
              after: { status: 'RETIRED', version: previous.version, retiredAt: now },
            },
            tx,
          );
        }

        const published = await tx.baggagePolicyVersion.update({
          where: { id: versionId },
          data: { status: 'PUBLISHED', publishedAt: now },
        });
        await this.audit.record(
          {
            actor,
            action: 'BAGGAGE_POLICY_VERSION_PUBLISHED',
            resourceType: 'baggage_policy_version',
            resourceId: versionId,
            before: { status: 'DRAFT', version: published.version },
            after: { status: 'PUBLISHED', version: published.version, publishedAt: now },
          },
          tx,
        );
      });
      return this.detail(policyId);
    } catch (error) {
      return databaseError(error);
    }
  }
}
