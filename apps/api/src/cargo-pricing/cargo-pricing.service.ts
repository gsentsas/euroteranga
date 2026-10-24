import { Prisma, type DatabaseTransaction } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import { RATE_LIMITS } from '../auth/rate-limit/rate-limit.rules.js';
import { RateLimitService } from '../auth/rate-limit/rate-limit.service.js';
import type { Actor } from '../auth/session/auth-principal.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import {
  decimalToThousandths,
  estimateCargo,
  estimateCargoWithRule,
  type CargoPricingEngineRule,
} from './cargo-pricing.engine.js';
import {
  type CargoEstimateInput,
  type CargoPricingRuleCreateInput,
  type CargoPricingRuleListQuery,
  type CargoPricingRuleUpdateInput,
  type CargoPricingVersionConfigInput,
  type CargoPricingVersionCreateInput,
} from './cargo-pricing.dto.js';
import { CargoPricingErrors } from './cargo-pricing.errors.js';

const versionRelations = {
  categories: { orderBy: { category: 'asc' as const } },
  tiers: { orderBy: { position: 'asc' as const } },
  options: { orderBy: { kind: 'asc' as const } },
} satisfies Prisma.CargoPricingRuleVersionInclude;

const engineVersionRelations = {
  rule: true,
  ...versionRelations,
} satisfies Prisma.CargoPricingRuleVersionInclude;

type EngineVersionRow = Prisma.CargoPricingRuleVersionGetPayload<{
  include: typeof engineVersionRelations;
}>;
type VersionRow = Prisma.CargoPricingRuleVersionGetPayload<{ include: typeof versionRelations }>;

function databaseError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') throw CargoPricingErrors.codeConflict();
    if (error.code === 'P2025') throw CargoPricingErrors.ruleNotFound();
  }
  throw error;
}

async function lockRule(tx: DatabaseTransaction, ruleId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "cargo_pricing_rule" WHERE "id" = ${ruleId}::uuid FOR UPDATE
  `;
  if (!rows[0]) throw CargoPricingErrors.ruleNotFound();
}

async function lockVersion(
  tx: DatabaseTransaction,
  ruleId: string,
  versionId: string,
): Promise<{ status: 'DRAFT' | 'ACTIVE' | 'DISABLED'; version: number }> {
  const rows = await tx.$queryRaw<
    Array<{ status: 'DRAFT' | 'ACTIVE' | 'DISABLED'; version: number }>
  >`
    SELECT "status", "version" FROM "cargo_pricing_rule_version"
    WHERE "id" = ${versionId}::uuid AND "rule_id" = ${ruleId}::uuid
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw CargoPricingErrors.versionNotFound();
  return row;
}

function decimal(value: string | null): Prisma.Decimal | null {
  return value === null ? null : new Prisma.Decimal(value);
}

function money(value: string | null): bigint | null {
  return value === null ? null : BigInt(value);
}

function validateConfig(input: CargoPricingVersionConfigInput): void {
  const unit = input.unitPriceMinor !== null;
  const flat = input.flatPriceMinor !== null;
  const rounding = input.roundingMode !== null;
  const divisor = input.volumetricDivisorCm3PerKg !== null;
  const minimum = input.minimumChargeMinor !== null;

  const rootValid =
    (input.method === 'ACTUAL_WEIGHT' && unit && !flat && rounding && !divisor) ||
    (input.method === 'VOLUMETRIC_WEIGHT' && unit && !flat && rounding && divisor) ||
    (input.method === 'VOLUME' && unit && !flat && rounding && !divisor) ||
    (input.method === 'FLAT_RATE' && !unit && flat && !rounding && !divisor) ||
    (input.method === 'TIERED_WEIGHT' && !unit && !flat && rounding) ||
    (input.method === 'CUSTOM_QUOTE' && !unit && !flat && !rounding && !divisor && !minimum);
  if (!rootValid) {
    throw CargoPricingErrors.invalidConfiguration(
      'Les champs monétaires ne correspondent pas à la méthode de calcul.',
    );
  }

  if (input.method !== 'TIERED_WEIGHT' && input.tiers.length !== 0) {
    throw CargoPricingErrors.invalidConfiguration(
      'Les paliers sont réservés à la méthode TIERED_WEIGHT.',
    );
  }
  if (input.method === 'TIERED_WEIGHT') {
    if (input.tiers.length === 0) {
      throw CargoPricingErrors.invalidConfiguration('Ajoutez au moins un palier tarifaire.');
    }
    const tiers = [...input.tiers].sort((left, right) => left.position - right.position);
    if (new Set(tiers.map((tier) => tier.position)).size !== tiers.length) {
      throw CargoPricingErrors.invalidConfiguration('Les positions des paliers sont uniques.');
    }
    for (const [index, tier] of tiers.entries()) {
      if (tier.position !== index) {
        throw CargoPricingErrors.invalidConfiguration('Les positions des paliers sont contiguës.');
      }
      if (index === 0 && decimalToThousandths(tier.minWeightKg) !== 0n) {
        throw CargoPricingErrors.invalidConfiguration('Le premier palier commence à 0 kg.');
      }
      const next = tiers[index + 1];
      const minimum = decimalToThousandths(tier.minWeightKg);
      const maximum = tier.maxWeightKg === null ? null : decimalToThousandths(tier.maxWeightKg);
      if (maximum !== null && maximum <= minimum) {
        throw CargoPricingErrors.invalidConfiguration(
          `La borne haute du palier ${tier.position} doit dépasser sa borne basse.`,
        );
      }
      if (next) {
        if (decimalToThousandths(next.minWeightKg) <= minimum) {
          throw CargoPricingErrors.invalidConfiguration(
            'Les bornes basses des paliers doivent être strictement croissantes.',
          );
        }
        if (
          tier.maxWeightKg === null ||
          decimalToThousandths(tier.maxWeightKg) !== decimalToThousandths(next.minWeightKg)
        ) {
          throw CargoPricingErrors.invalidConfiguration(
            'Les paliers doivent se suivre sans trou ni chevauchement.',
          );
        }
      } else if (tier.maxWeightKg !== null) {
        throw CargoPricingErrors.invalidConfiguration('Le dernier palier doit être ouvert.');
      }

      const tierUnit = tier.unitPriceMinor !== null;
      const tierFlat = tier.flatPriceMinor !== null;
      const tierMinimum = tier.minimumChargeMinor !== null;
      const tierValid =
        ((tier.method === 'UNIT_WEIGHT' || tier.method === 'UNIT_VOLUME') &&
          tierUnit &&
          !tierFlat) ||
        (tier.method === 'FLAT_RATE' && !tierUnit && tierFlat) ||
        (tier.method === 'CUSTOM_QUOTE' && !tierUnit && !tierFlat && !tierMinimum);
      if (!tierValid) {
        throw CargoPricingErrors.invalidConfiguration(
          `Le palier ${tier.position} ne correspond pas à sa méthode.`,
        );
      }
    }
  }

  for (const option of input.options) {
    const valid =
      (option.mode === 'FLAT_RATE' && option.amountMinor !== null) ||
      (option.mode !== 'FLAT_RATE' && option.amountMinor === null);
    if (!valid) {
      throw CargoPricingErrors.invalidConfiguration(
        `L’option ${option.kind} ne correspond pas à son mode.`,
      );
    }
  }
}

function scalarData(input: CargoPricingVersionConfigInput) {
  return {
    method: input.method,
    currencyCode: input.currencyCode,
    currencyMinorUnit: input.currencyMinorUnit,
    roundingMode: input.roundingMode,
    unitPriceMinor: money(input.unitPriceMinor),
    flatPriceMinor: money(input.flatPriceMinor),
    minimumChargeMinor: money(input.minimumChargeMinor),
    volumetricDivisorCm3PerKg: input.volumetricDivisorCm3PerKg,
    quoteAboveWeightKg: decimal(input.quoteAboveWeightKg),
    quoteAboveVolumeLiters: input.quoteAboveVolumeLiters,
    effectiveFrom: new Date(input.effectiveFrom),
    effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
  };
}

function categoryData(input: CargoPricingVersionConfigInput) {
  return input.categories.map((category) => ({ category }));
}

function tierData(input: CargoPricingVersionConfigInput) {
  return input.tiers.map((tier) => ({
    position: tier.position,
    minWeightKg: new Prisma.Decimal(tier.minWeightKg),
    maxWeightKg: decimal(tier.maxWeightKg),
    method: tier.method,
    unitPriceMinor: money(tier.unitPriceMinor),
    flatPriceMinor: money(tier.flatPriceMinor),
    minimumChargeMinor: money(tier.minimumChargeMinor),
  }));
}

function optionData(input: CargoPricingVersionConfigInput) {
  return input.options.map((option) => ({
    kind: option.kind,
    mode: option.mode,
    amountMinor: money(option.amountMinor),
  }));
}

function configFromRow(row: VersionRow): CargoPricingVersionConfigInput {
  return {
    method: row.method,
    currencyCode: row.currencyCode,
    currencyMinorUnit: row.currencyMinorUnit,
    roundingMode: row.roundingMode,
    unitPriceMinor: row.unitPriceMinor?.toString() ?? null,
    flatPriceMinor: row.flatPriceMinor?.toString() ?? null,
    minimumChargeMinor: row.minimumChargeMinor?.toString() ?? null,
    volumetricDivisorCm3PerKg: row.volumetricDivisorCm3PerKg,
    quoteAboveWeightKg: row.quoteAboveWeightKg?.toFixed(3) ?? null,
    quoteAboveVolumeLiters: row.quoteAboveVolumeLiters,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo?.toISOString() ?? null,
    categories: row.categories.map((entry) => entry.category),
    tiers: row.tiers.map((tier) => ({
      position: tier.position,
      minWeightKg: tier.minWeightKg.toFixed(3),
      maxWeightKg: tier.maxWeightKg?.toFixed(3) ?? null,
      method: tier.method,
      unitPriceMinor: tier.unitPriceMinor?.toString() ?? null,
      flatPriceMinor: tier.flatPriceMinor?.toString() ?? null,
      minimumChargeMinor: tier.minimumChargeMinor?.toString() ?? null,
    })),
    options: row.options.map((option) => ({
      kind: option.kind,
      mode: option.mode,
      amountMinor: option.amountMinor?.toString() ?? null,
    })),
  };
}

function versionView(row: VersionRow) {
  return {
    id: row.id,
    ruleId: row.ruleId,
    version: row.version,
    status: row.status,
    ...configFromRow(row),
    activatedAt: row.activatedAt?.toISOString() ?? null,
    disabledAt: row.disabledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function engineRule(row: EngineVersionRow): CargoPricingEngineRule {
  return {
    code: row.rule.code,
    version: row.version,
    direction: row.rule.direction,
    method: row.method,
    currencyCode: row.currencyCode,
    currencyMinorUnit: row.currencyMinorUnit,
    roundingMode: row.roundingMode,
    unitPriceMinor: row.unitPriceMinor,
    flatPriceMinor: row.flatPriceMinor,
    minimumChargeMinor: row.minimumChargeMinor,
    volumetricDivisorCm3PerKg: row.volumetricDivisorCm3PerKg,
    quoteAboveWeightGrams: row.quoteAboveWeightKg
      ? decimalToThousandths(row.quoteAboveWeightKg.toFixed(3))
      : null,
    quoteAboveVolumeCm3:
      row.quoteAboveVolumeLiters === null ? null : BigInt(row.quoteAboveVolumeLiters) * 1000n,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    categories: row.categories.map((entry) => entry.category),
    tiers: row.tiers.map((tier) => ({
      position: tier.position,
      minWeightGrams: decimalToThousandths(tier.minWeightKg.toFixed(3)),
      maxWeightGrams: tier.maxWeightKg ? decimalToThousandths(tier.maxWeightKg.toFixed(3)) : null,
      method: tier.method,
      unitPriceMinor: tier.unitPriceMinor,
      flatPriceMinor: tier.flatPriceMinor,
      minimumChargeMinor: tier.minimumChargeMinor,
    })),
    options: row.options.map((option) => ({
      kind: option.kind,
      mode: option.mode,
      amountMinor: option.amountMinor,
    })),
  };
}

@Injectable()
export class CargoPricingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly rateLimits: RateLimitService,
  ) {}

  async estimate(input: CargoEstimateInput, clientIp: string) {
    await this.rateLimits.consume(RATE_LIMITS.cargoPricingEstimateIp, clientIp);
    const now = new Date();
    const direction = input.from === 'PAR' ? 'PAR_DKR' : 'DKR_PAR';
    const versions = await this.database.client.cargoPricingRuleVersion.findMany({
      take: 2,
      where: {
        status: 'ACTIVE',
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
        rule: { direction, audience: 'PUBLIC' },
        categories: { some: { category: input.category } },
      },
      orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
      include: engineVersionRelations,
    });
    return estimateCargo(input, versions.map(engineRule));
  }

  async list(query: CargoPricingRuleListQuery) {
    const rows = await this.database.client.cargoPricingRule.findMany({
      take: query.limit + 1,
      where: {
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        ...(query.direction ? { direction: query.direction } : {}),
        ...(query.audience ? { audience: query.audience } : {}),
      },
      orderBy: { id: 'desc' },
      include: {
        versions: { orderBy: { version: 'desc' }, include: versionRelations },
      },
    });
    const page = rows.slice(0, query.limit);
    return {
      items: page.map((rule) => ({
        id: rule.id,
        code: rule.code,
        name: rule.name,
        direction: rule.direction,
        audience: rule.audience,
        createdAt: rule.createdAt.toISOString(),
        updatedAt: rule.updatedAt.toISOString(),
        versions: rule.versions.map(versionView),
      })),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async detail(ruleId: string) {
    const rule = await this.database.client.cargoPricingRule.findUnique({
      where: { id: ruleId },
      include: { versions: { orderBy: { version: 'desc' }, include: versionRelations } },
    });
    if (!rule) throw CargoPricingErrors.ruleNotFound();
    return {
      id: rule.id,
      code: rule.code,
      name: rule.name,
      direction: rule.direction,
      audience: rule.audience,
      createdAt: rule.createdAt.toISOString(),
      updatedAt: rule.updatedAt.toISOString(),
      versions: rule.versions.map(versionView),
    };
  }

  async createRule(input: CargoPricingRuleCreateInput, actor: Actor) {
    try {
      const id = await this.database.client.$transaction(async (tx) => {
        const rule = await tx.cargoPricingRule.create({ data: input });
        await this.audit.record(
          {
            actor,
            action: 'CARGO_PRICING_RULE_CREATED',
            resourceType: 'cargo_pricing_rule',
            resourceId: rule.id,
            after: input,
          },
          tx,
        );
        return rule.id;
      });
      return this.detail(id);
    } catch (error) {
      return databaseError(error);
    }
  }

  async updateRule(ruleId: string, input: CargoPricingRuleUpdateInput, actor: Actor) {
    try {
      await this.database.client.$transaction(async (tx) => {
        await lockRule(tx, ruleId);
        const before = await tx.cargoPricingRule.findUniqueOrThrow({ where: { id: ruleId } });
        const after = await tx.cargoPricingRule.update({ where: { id: ruleId }, data: input });
        await this.audit.record(
          {
            actor,
            action: 'CARGO_PRICING_RULE_UPDATED',
            resourceType: 'cargo_pricing_rule',
            resourceId: ruleId,
            before: { name: before.name },
            after: { name: after.name },
            metadata: { operation: 'RULE_RENAMED' },
          },
          tx,
        );
      });
      return this.detail(ruleId);
    } catch (error) {
      return databaseError(error);
    }
  }

  async createVersion(ruleId: string, input: CargoPricingVersionCreateInput, actor: Actor) {
    try {
      await this.database.client.$transaction(async (tx) => {
        await lockRule(tx, ruleId);
        if (await tx.cargoPricingRuleVersion.findFirst({ where: { ruleId, status: 'DRAFT' } })) {
          throw CargoPricingErrors.draftExists();
        }
        let config: CargoPricingVersionConfigInput;
        if ('sourceVersionId' in input) {
          const source = await tx.cargoPricingRuleVersion.findFirst({
            where: { id: input.sourceVersionId, ruleId },
            include: versionRelations,
          });
          if (!source) throw CargoPricingErrors.versionNotFound();
          config = configFromRow(source);
        } else {
          config = input;
        }
        validateConfig(config);
        const latest = await tx.cargoPricingRuleVersion.findFirst({
          where: { ruleId },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const created = await tx.cargoPricingRuleVersion.create({
          data: {
            ruleId,
            version: (latest?.version ?? 0) + 1,
            ...scalarData(config),
            categories: { create: categoryData(config) },
            tiers: { create: tierData(config) },
            options: { create: optionData(config) },
          },
        });
        await this.audit.record(
          {
            actor,
            action: 'CARGO_PRICING_RULE_UPDATED',
            resourceType: 'cargo_pricing_rule',
            resourceId: ruleId,
            after: { version: created.version, config },
            metadata: {
              operation: 'VERSION_CREATED',
              versionId: created.id,
              ...(input && 'sourceVersionId' in input
                ? { sourceVersionId: input.sourceVersionId }
                : {}),
            },
          },
          tx,
        );
      });
      return this.detail(ruleId);
    } catch (error) {
      return databaseError(error);
    }
  }

  async updateVersion(
    ruleId: string,
    versionId: string,
    input: CargoPricingVersionConfigInput,
    actor: Actor,
  ) {
    validateConfig(input);
    try {
      await this.database.client.$transaction(async (tx) => {
        await lockRule(tx, ruleId);
        const locked = await lockVersion(tx, ruleId, versionId);
        if (locked.status !== 'DRAFT') throw CargoPricingErrors.versionNotDraft();
        const before = await tx.cargoPricingRuleVersion.findUniqueOrThrow({
          where: { id: versionId },
          include: versionRelations,
        });
        await tx.cargoPricingRuleCategory.deleteMany({ where: { ruleVersionId: versionId } });
        await tx.cargoPricingTier.deleteMany({ where: { ruleVersionId: versionId } });
        await tx.cargoPricingOption.deleteMany({ where: { ruleVersionId: versionId } });
        await tx.cargoPricingRuleVersion.update({
          where: { id: versionId },
          data: {
            ...scalarData(input),
            categories: { create: categoryData(input) },
            tiers: { create: tierData(input) },
            options: { create: optionData(input) },
          },
        });
        await this.audit.record(
          {
            actor,
            action: 'CARGO_PRICING_RULE_UPDATED',
            resourceType: 'cargo_pricing_rule',
            resourceId: ruleId,
            before: { version: before.version, config: configFromRow(before) },
            after: { version: before.version, config: input },
            metadata: { operation: 'VERSION_UPDATED', versionId },
          },
          tx,
        );
      });
      return this.detail(ruleId);
    } catch (error) {
      return databaseError(error);
    }
  }

  async activate(ruleId: string, versionId: string, actor: Actor) {
    try {
      await this.database.client.$transaction(async (tx) => {
        await lockRule(tx, ruleId);
        const locked = await lockVersion(tx, ruleId, versionId);
        if (locked.status !== 'DRAFT') throw CargoPricingErrors.versionNotDraft();
        const target = await tx.cargoPricingRuleVersion.findUniqueOrThrow({
          where: { id: versionId },
          include: versionRelations,
        });
        validateConfig(configFromRow(target));
        const now = new Date();
        if (target.effectiveTo && target.effectiveTo <= now) {
          throw CargoPricingErrors.expiredVersion();
        }
        const active = await tx.cargoPricingRuleVersion.findFirst({
          where: { ruleId, status: 'ACTIVE' },
        });
        if (active) {
          await tx.cargoPricingRuleVersion.update({
            where: { id: active.id },
            data: { status: 'DISABLED', disabledAt: now },
          });
          await this.audit.record(
            {
              actor,
              action: 'CARGO_PRICING_RULE_DISABLED',
              resourceType: 'cargo_pricing_rule',
              resourceId: ruleId,
              before: { version: active.version, status: 'ACTIVE' },
              after: { version: active.version, status: 'DISABLED', disabledAt: now },
              metadata: { versionId: active.id, replacementVersionId: versionId },
            },
            tx,
          );
        }
        await tx.cargoPricingRuleVersion.update({
          where: { id: versionId },
          data: { status: 'ACTIVE', activatedAt: now },
        });
        await this.audit.record(
          {
            actor,
            action: 'CARGO_PRICING_RULE_ACTIVATED',
            resourceType: 'cargo_pricing_rule',
            resourceId: ruleId,
            before: { version: locked.version, status: 'DRAFT' },
            after: { version: locked.version, status: 'ACTIVE', activatedAt: now },
            metadata: { versionId },
          },
          tx,
        );
      });
      return this.detail(ruleId);
    } catch (error) {
      return databaseError(error);
    }
  }

  async disable(ruleId: string, versionId: string, actor: Actor) {
    try {
      await this.database.client.$transaction(async (tx) => {
        await lockRule(tx, ruleId);
        const locked = await lockVersion(tx, ruleId, versionId);
        if (locked.status !== 'ACTIVE') throw CargoPricingErrors.versionNotActive();
        const now = new Date();
        await tx.cargoPricingRuleVersion.update({
          where: { id: versionId },
          data: { status: 'DISABLED', disabledAt: now },
        });
        await this.audit.record(
          {
            actor,
            action: 'CARGO_PRICING_RULE_DISABLED',
            resourceType: 'cargo_pricing_rule',
            resourceId: ruleId,
            before: { version: locked.version, status: 'ACTIVE' },
            after: { version: locked.version, status: 'DISABLED', disabledAt: now },
            metadata: { versionId },
          },
          tx,
        );
      });
      return this.detail(ruleId);
    } catch (error) {
      return databaseError(error);
    }
  }

  async preview(ruleId: string, versionId: string, input: CargoEstimateInput) {
    const row = await this.database.client.cargoPricingRuleVersion.findFirst({
      where: { id: versionId, ruleId },
      include: engineVersionRelations,
    });
    if (!row) throw CargoPricingErrors.versionNotFound();
    return estimateCargoWithRule(input, engineRule(row));
  }
}
