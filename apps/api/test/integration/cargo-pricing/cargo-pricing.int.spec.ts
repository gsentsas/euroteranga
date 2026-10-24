import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminApi,
  isolatedDatabase,
  staffActor,
  type StaffActor,
} from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const estimateBody = (overrides: Record<string, unknown> = {}) => ({
  from: 'PAR',
  to: 'DKR',
  weightKg: '25.000',
  dimensions: { lengthCm: 60, widthCm: 40, heightCm: 40 },
  category: 'STANDARD_PARCEL',
  pickup: false,
  delivery: false,
  fragile: false,
  ...overrides,
});

const versionBody = (overrides: Record<string, unknown> = {}) => ({
  method: 'ACTUAL_WEIGHT',
  currencyCode: 'EUR',
  currencyMinorUnit: 2,
  roundingMode: 'UP',
  // Every amount and divisor in this file is synthetic test data.
  unitPriceMinor: '300',
  flatPriceMinor: null,
  minimumChargeMinor: null,
  volumetricDivisorCm3PerKg: null,
  quoteAboveWeightKg: null,
  quoteAboveVolumeLiters: null,
  effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
  effectiveTo: null,
  categories: ['STANDARD_PARCEL'],
  tiers: [],
  options: [],
  ...overrides,
});

describe('CARGO-PRICING-1 versioned freight pricing', () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let t: TestApp;
  let manager: StaffActor;
  let reader: StaffActor;
  let denied: StaffActor;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
    [manager, reader, denied] = await Promise.all([
      staffActor(t.app, ['OPS_MANAGER']),
      staffActor(t.app, ['FINANCE']),
      staffActor(t.app, ['COMPLIANCE_AGENT']),
    ]);
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  async function publicEstimate(body: Record<string, unknown> = estimateBody()) {
    return request(t.app.getHttpServer())
      .post('/v1/cargo/estimate')
      .set('X-Forwarded-For', '198.51.100.40')
      .send(body);
  }

  async function createRule(code: string, direction: 'PAR_DKR' | 'DKR_PAR' = 'PAR_DKR') {
    const response = await adminApi(manager).post('/pricing/cargo-rules', {
      code,
      name: `Règle synthétique ${code}`,
      direction,
      audience: 'PUBLIC',
    });
    expect(response.status, response.text).toBe(201);
    return response.body as { id: string; versions: Array<{ id: string }> };
  }

  async function createVersion(ruleId: string, body: Record<string, unknown> = versionBody()) {
    const response = await adminApi(manager).post(`/pricing/cargo-rules/${ruleId}/versions`, body);
    expect(response.status, response.text).toBe(201);
    return response.body.versions[0] as { id: string; version: number; status: string };
  }

  async function activate(ruleId: string, versionId: string) {
    const response = await adminApi(manager).post(
      `/pricing/cargo-rules/${ruleId}/versions/${versionId}/activate`,
      {},
    );
    expect(response.status, response.text).toBe(200);
    return response;
  }

  it('installs the versioned tables, guards and one-draft/one-active indexes', async () => {
    const tables = await db(t.app).$queryRaw<Array<{ name: string }>>`
      SELECT tablename AS name FROM pg_tables
      WHERE schemaname = 'public' AND tablename LIKE 'cargo_pricing_%'
      ORDER BY tablename
    `;
    expect(tables.map((row) => row.name)).toEqual([
      'cargo_pricing_option',
      'cargo_pricing_rule',
      'cargo_pricing_rule_category',
      'cargo_pricing_rule_version',
      'cargo_pricing_tier',
    ]);
    const indexes = await db(t.app).$queryRaw<Array<{ name: string }>>`
      SELECT indexname AS name FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('cargo_pricing_rule_one_draft_version', 'cargo_pricing_rule_one_active_version')
      ORDER BY indexname
    `;
    expect(indexes.map((row) => row.name)).toEqual([
      'cargo_pricing_rule_one_active_version',
      'cargo_pricing_rule_one_draft_version',
    ]);
  });

  it('is fail-closed with no active commercial rule and strictly validates input', async () => {
    const missing = await publicEstimate();
    expect(missing.status, missing.text).toBe(200);
    expect(missing.body).toMatchObject({
      requiresQuote: true,
      quoteReason: 'NO_ACTIVE_RULE',
      totalMinor: null,
      pricingVersion: null,
    });
    for (const body of [
      estimateBody({ weightKg: '0' }),
      estimateBody({ weightKg: '-1' }),
      estimateBody({ from: 'PAR', to: 'PAR' }),
      estimateBody({ unitPriceMinor: '1' }),
      estimateBody({ dimensions: { lengthCm: 0, widthCm: 40, heightCm: 40 } }),
    ]) {
      const response = await publicEstimate(body);
      expect(response.status, response.text).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    }
  });

  it('enforces pricing RBAC and CSRF while allowing read-only previews', async () => {
    const created = await createRule('AUTH_SYNTHETIC');
    const draft = await createVersion(created.id);
    expect((await adminApi(reader).get('/pricing/cargo-rules')).status).toBe(200);
    expect((await adminApi(reader).get(`/pricing/cargo-rules/${created.id}`)).status).toBe(200);
    const preview = await adminApi(reader).post(
      `/pricing/cargo-rules/${created.id}/versions/${draft.id}/preview`,
      estimateBody(),
      { csrf: null },
    );
    expect(preview.status, preview.text).toBe(200);
    expect(preview.body.totalMinor).toBe('7500');

    expect((await adminApi(denied).get('/pricing/cargo-rules')).status).toBe(403);
    expect(
      (
        await adminApi(reader).post('/pricing/cargo-rules', {
          code: 'DENIED',
          name: 'Interdit',
          direction: 'PAR_DKR',
          audience: 'PUBLIC',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await adminApi(manager).post(
          `/pricing/cargo-rules/${created.id}/versions/${draft.id}/activate`,
          {},
          { csrf: null },
        )
      ).status,
    ).toBe(403);
  });

  it('activates exact rules in both directions and explains the public result', async () => {
    const outward = await createRule('PAR_DKR_SYNTHETIC');
    const outwardVersion = await createVersion(outward.id, versionBody());
    await activate(outward.id, outwardVersion.id);

    const outwardEstimate = await publicEstimate();
    expect(outwardEstimate.status, outwardEstimate.text).toBe(200);
    expect(outwardEstimate.body).toMatchObject({
      direction: 'PAR_DKR',
      actualWeightKg: '25.000',
      volumeM3: '0.096000',
      requiresQuote: false,
      currencyCode: 'EUR',
      currencyMinorUnit: 2,
      totalMinor: '7500',
      pricingVersion: 'PAR_DKR_SYNTHETIC:v1',
      calculation: {
        method: 'ACTUAL_WEIGHT',
        unitPriceMinor: '300',
        baseAmountMinor: '7500',
      },
      lines: [{ kind: 'BASE', code: 'BASE', amountMinor: '7500' }],
    });

    const reverse = await createRule('DKR_PAR_SYNTHETIC', 'DKR_PAR');
    const reverseVersion = await createVersion(reverse.id, versionBody({ unitPriceMinor: '400' }));
    await activate(reverse.id, reverseVersion.id);
    const reverseEstimate = await publicEstimate(
      estimateBody({ from: 'DKR', to: 'PAR', weightKg: '10.000' }),
    );
    expect(reverseEstimate.body).toMatchObject({
      direction: 'DKR_PAR',
      totalMinor: '4000',
      pricingVersion: 'DKR_PAR_SYNTHETIC:v1',
    });
  });

  it('refuses future activation and fails closed when two effective rules are ambiguous', async () => {
    const future = await createRule('FUTURE_SYNTHETIC');
    const futureVersion = await createVersion(
      future.id,
      versionBody({ effectiveFrom: new Date(Date.now() + 86_400_000).toISOString() }),
    );
    const futureActivation = await adminApi(manager).post(
      `/pricing/cargo-rules/${future.id}/versions/${futureVersion.id}/activate`,
      {},
    );
    expect(futureActivation.status, futureActivation.text).toBe(422);
    expect(futureActivation.body.code).toBe('CARGO_PRICING_VERSION_NOT_EFFECTIVE');

    const conflicting = await createRule('CONFLICT_SYNTHETIC');
    const conflictingVersion = await createVersion(conflicting.id);
    await activate(conflicting.id, conflictingVersion.id);
    const response = await publicEstimate();
    expect(response.body).toMatchObject({
      requiresQuote: true,
      quoteReason: 'AMBIGUOUS_RULE',
      totalMinor: null,
      pricingVersion: null,
    });

    const disabled = await adminApi(manager).post(
      `/pricing/cargo-rules/${conflicting.id}/versions/${conflictingVersion.id}/disable`,
      {},
    );
    expect(disabled.status, disabled.text).toBe(200);

    const afterDisable = await publicEstimate();
    expect(afterDisable.body).toMatchObject({
      requiresQuote: false,
      pricingVersion: 'PAR_DKR_SYNTHETIC:v1',
    });
  });

  it('refuses expired activation and returns an explicit custom quote without a zero price', async () => {
    const expired = await createRule('EXPIRED_SYNTHETIC');
    const expiredVersion = await createVersion(
      expired.id,
      versionBody({
        categories: ['OTHER'],
        effectiveFrom: new Date(Date.now() - 120_000).toISOString(),
        effectiveTo: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    const activation = await adminApi(manager).post(
      `/pricing/cargo-rules/${expired.id}/versions/${expiredVersion.id}/activate`,
      {},
    );
    expect(activation.status).toBe(422);
    expect(activation.body.code).toBe('CARGO_PRICING_VERSION_EXPIRED');

    const custom = await createRule('CUSTOM_QUOTE_SYNTHETIC');
    const customVersion = await createVersion(
      custom.id,
      versionBody({
        method: 'CUSTOM_QUOTE',
        roundingMode: null,
        unitPriceMinor: null,
        categories: ['SPECIAL_HANDLING'],
      }),
    );
    await activate(custom.id, customVersion.id);
    const response = await publicEstimate(estimateBody({ category: 'SPECIAL_HANDLING' }));
    expect(response.body).toMatchObject({
      requiresQuote: true,
      quoteReason: 'CUSTOM_QUOTE',
      totalMinor: null,
      currencyCode: 'EUR',
      pricingVersion: 'CUSTOM_QUOTE_SYNTHETIC:v1',
    });
  });

  it('replaces a version atomically, keeps history immutable and audits every transition', async () => {
    const target = await createRule('HISTORY_SYNTHETIC');
    const first = await createVersion(target.id, versionBody({ categories: ['DOCUMENTS'] }));
    await activate(target.id, first.id);
    const duplicated = await adminApi(manager).post(`/pricing/cargo-rules/${target.id}/versions`, {
      sourceVersionId: first.id,
    });
    expect(duplicated.status, duplicated.text).toBe(201);
    const second = duplicated.body.versions.find(
      (version: { status: string }) => version.status === 'DRAFT',
    ) as { id: string; version: number };
    expect(second.version).toBe(2);
    const updated = await adminApi(manager).post(
      `/pricing/cargo-rules/${target.id}/versions/${second.id}`,
      versionBody({ categories: ['DOCUMENTS'], unitPriceMinor: '350' }),
    );
    expect(updated.status, updated.text).toBe(200);
    await activate(target.id, second.id);

    const versions = await db(t.app).cargoPricingRuleVersion.findMany({
      where: { ruleId: target.id },
      orderBy: { version: 'asc' },
    });
    expect(versions.map((version) => [version.version, version.status])).toEqual([
      [1, 'DISABLED'],
      [2, 'ACTIVE'],
    ]);
    await expect(
      db(t.app).cargoPricingRuleVersion.update({
        where: { id: first.id },
        data: { unitPriceMinor: 1n },
      }),
    ).rejects.toThrow();
    await expect(
      db(t.app).cargoPricingRuleVersion.delete({ where: { id: first.id } }),
    ).rejects.toThrow();

    const actions = await db(t.app).auditEvent.findMany({
      where: { resourceId: target.id },
      orderBy: { occurredAt: 'asc' },
      select: { action: true },
    });
    expect(actions.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        'CARGO_PRICING_RULE_CREATED',
        'CARGO_PRICING_RULE_UPDATED',
        'CARGO_PRICING_RULE_ACTIVATED',
        'CARGO_PRICING_RULE_DISABLED',
      ]),
    );
  });

  it('serializes concurrent draft creation so only one succeeds', async () => {
    const target = await createRule('CONCURRENT_SYNTHETIC');
    const [left, right] = await Promise.all([
      adminApi(manager).post(`/pricing/cargo-rules/${target.id}/versions`, versionBody()),
      adminApi(manager).post(`/pricing/cargo-rules/${target.id}/versions`, versionBody()),
    ]);
    expect([left.status, right.status].sort()).toEqual([201, 409]);
    expect([left.body.code, right.body.code]).toContain('CARGO_PRICING_DRAFT_ALREADY_EXISTS');
    expect(await db(t.app).cargoPricingRuleVersion.count({ where: { ruleId: target.id } })).toBe(1);
  });
});
