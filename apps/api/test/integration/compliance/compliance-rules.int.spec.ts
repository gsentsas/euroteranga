import type { ApiEnv } from '@euroteranga/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminApi,
  isolatedDatabase,
  staffActor,
  type StaffActor,
} from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import { country, ruleContent, SYNTHETIC_SOURCE } from '../../support/compliance-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const REFERENCE = /^ETCR-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;
const today = () => new Date().toISOString().slice(0, 10);

describe('regulatory rule catalogue (isolated database)', () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let t: TestApp;
  let env: ApiEnv;
  let manager: StaffActor;
  let agent: StaffActor;
  let auditor: StaffActor;
  let bookingAgent: StaffActor;
  let destination: string;

  beforeAll(async () => {
    database = await isolatedDatabase();
    env = integrationEnv({ DATABASE_URL: database.url });
    t = await startTestApp(env);
    [manager, agent, auditor, bookingAgent] = await Promise.all([
      staffActor(t.app, ['DIRECTOR']),
      staffActor(t.app, ['COMPLIANCE_AGENT']),
      staffActor(t.app, ['AUDITOR']),
      staffActor(t.app, ['BOOKING_AGENT']),
    ]);
    destination = (await country(t.app)).iso2;
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  const definition = (documentType = 'PASSPORT') => ({
    language: 1,
    scope: { destinationCountries: [destination] },
    requirement: { kind: 'DOCUMENT', documentType },
  });

  async function draft(overrides: Partial<ReturnType<typeof ruleContent>> = {}) {
    const created = await adminApi(manager).post('/compliance/rules', {
      title: 'Règle synthétique de cycle de vie',
      version: { ...ruleContent({ definition: definition() }), ...overrides },
    });
    expect(created.status, created.text).toBe(201);
    return {
      reference: created.body.reference as string,
      sha: created.body.versions[0].definitionSha256 as string,
    };
  }

  const audits = (action: string) => db(t.app).auditEvent.count({ where: { action } });

  it('creates an unverified draft and never publishes it without verification', async () => {
    const before = await audits('COMPLIANCE_RULE_CREATED');
    const { reference, sha } = await draft();
    expect(reference).toMatch(REFERENCE);
    const detail = await adminApi(agent).get(`/compliance/rules/${reference}`);
    expect(detail.status).toBe(200);
    expect(detail.body.versions).toEqual([
      expect.objectContaining({
        version: 1,
        status: 'DRAFT',
        verification: expect.objectContaining({ status: 'UNVERIFIED', verifiedBy: null }),
        definitionSha256: sha,
      }),
    ]);
    expect(await audits('COMPLIANCE_RULE_CREATED')).toBe(before + 1);

    const unverified = await adminApi(manager).post(
      `/compliance/rules/${reference}/versions/1/publish`,
      {
        definitionSha256: sha,
      },
    );
    expect(unverified.status).toBe(422);
    expect(unverified.body.code).toBe('COMPLIANCE_RULE_NOT_VERIFIED');
    // The server decides the status: a client-supplied one is not even accepted.
    for (const body of [
      {
        title: 'Statut imposé',
        status: 'PUBLISHED',
        version: ruleContent({ definition: definition() }),
      },
      {
        title: 'Statut imposé',
        version: { ...ruleContent({ definition: definition() }), status: 'PUBLISHED' },
      },
      {
        title: 'Vérifié imposé',
        version: { ...ruleContent({ definition: definition() }), verificationStatus: 'VERIFIED' },
      },
    ]) {
      expect((await adminApi(manager).post('/compliance/rules', body)).status).toBe(400);
    }
    const stored = await db(t.app).complianceRuleVersion.findFirstOrThrow({
      where: { rule: { reference } },
    });
    expect(stored).toMatchObject({ status: 'DRAFT', verificationStatus: 'UNVERIFIED' });
  });

  it('verifies only complete, past-dated provenance of the exact definition read', async () => {
    const noLink = await draft({ source: { ...SYNTHETIC_SOURCE, url: null, reference: null } });
    const incomplete = await adminApi(manager).post(
      `/compliance/rules/${noLink.reference}/versions/1/verify`,
      {
        definitionSha256: noLink.sha,
        sourceCheckedOn: today(),
      },
    );
    expect(incomplete.body.code).toBe('COMPLIANCE_RULE_SOURCE_INCOMPLETE');

    const { reference, sha } = await draft();
    const future = await adminApi(manager).post(
      `/compliance/rules/${reference}/versions/1/verify`,
      {
        definitionSha256: sha,
        sourceCheckedOn: '2999-01-01',
      },
    );
    expect(future.body.code).toBe('COMPLIANCE_RULE_SOURCE_DATE_INVALID');
    const otherContent = await adminApi(manager).post(
      `/compliance/rules/${reference}/versions/1/verify`,
      {
        definitionSha256: 'f'.repeat(64),
        sourceCheckedOn: today(),
      },
    );
    expect(otherContent.body.code).toBe('COMPLIANCE_RULE_CONTENT_CHANGED');

    const verified = await adminApi(manager).post(
      `/compliance/rules/${reference}/versions/1/verify`,
      {
        definitionSha256: sha,
        sourceCheckedOn: today(),
        note: 'Vérifié contre la source synthétique.',
      },
    );
    expect(verified.status).toBe(200);
    expect(verified.body.versions[0].verification).toMatchObject({
      status: 'VERIFIED',
      verifiedBy: manager.email,
    });

    // Any change drops the verification: what is published is what was verified.
    const edited = await adminApi(manager).post(
      `/compliance/rules/${reference}/versions/1`,
      ruleContent({ definition: definition('VISA') }),
    );
    expect(edited.status).toBe(200);
    expect(edited.body.versions[0]).toMatchObject({
      verification: expect.objectContaining({ status: 'UNVERIFIED', verifiedBy: null }),
      source: expect.objectContaining({ checkedOn: null }),
    });
    const editedSha = edited.body.versions[0].definitionSha256 as string;
    expect(editedSha).not.toBe(sha);
    const stale = await adminApi(manager).post(
      `/compliance/rules/${reference}/versions/1/publish`,
      {
        definitionSha256: editedSha,
      },
    );
    expect(stale.body.code).toBe('COMPLIANCE_RULE_NOT_VERIFIED');
  });

  it('publishes a verified draft once, then keeps it immutable and versions corrections', async () => {
    const { reference, sha } = await draft();
    await adminApi(manager).post(`/compliance/rules/${reference}/versions/1/verify`, {
      definitionSha256: sha,
      sourceCheckedOn: today(),
    });
    const publishedBefore = await audits('COMPLIANCE_RULE_PUBLISHED');
    const published = await adminApi(manager).post(
      `/compliance/rules/${reference}/versions/1/publish`,
      {
        definitionSha256: sha,
      },
    );
    expect(published.status).toBe(200);
    expect(published.body.versions[0]).toMatchObject({
      status: 'PUBLISHED',
      publishedBy: manager.email,
      publishedAt: expect.any(String),
    });
    expect(await audits('COMPLIANCE_RULE_PUBLISHED')).toBe(publishedBefore + 1);

    for (const [path, body] of [
      [
        `/compliance/rules/${reference}/versions/1`,
        ruleContent({ definition: definition('VISA') }),
      ],
      [
        `/compliance/rules/${reference}/versions/1/verify`,
        { definitionSha256: sha, sourceCheckedOn: today() },
      ],
      [`/compliance/rules/${reference}/versions/1/publish`, { definitionSha256: sha }],
    ] as const) {
      const refused = await adminApi(manager).post(path, body);
      expect(refused.status, path).toBe(409);
      expect(refused.body.code).toBe('COMPLIANCE_RULE_VERSION_NOT_DRAFT');
    }

    const next = await adminApi(manager).post(`/compliance/rules/${reference}/versions`, {});
    expect(next.status).toBe(201);
    expect(
      next.body.versions.map((v: { version: number; status: string }) => [v.version, v.status]),
    ).toEqual([
      [2, 'DRAFT'],
      [1, 'PUBLISHED'],
    ]);
    expect(next.body.versions[0].definitionSha256).toBe(sha);
    const second = await adminApi(manager).post(`/compliance/rules/${reference}/versions`, {});
    expect(second.body.code).toBe('COMPLIANCE_RULE_DRAFT_EXISTS');

    const retireDraft = await adminApi(manager).post(
      `/compliance/rules/${reference}/versions/2/retire`,
      {
        reason: 'Brouillon abandonné en test.',
      },
    );
    expect(retireDraft.body.code).toBe('COMPLIANCE_RULE_VERSION_NOT_PUBLISHED');
    const retired = await adminApi(manager).post(
      `/compliance/rules/${reference}/versions/1/retire`,
      {
        reason: 'Texte synthétique abrogé en test.',
      },
    );
    expect(retired.status).toBe(200);
    expect(retired.body.versions[1]).toMatchObject({
      status: 'RETIRED',
      retiredBy: manager.email,
      retirementReason: 'Texte synthétique abrogé en test.',
      definitionSha256: sha,
    });
    expect(
      (
        await adminApi(manager).post(`/compliance/rules/${reference}/versions/1/retire`, {
          reason: 'Encore une fois.',
        })
      ).body.code,
    ).toBe('COMPLIANCE_RULE_VERSION_NOT_PUBLISHED');
    expect(await audits('COMPLIANCE_RULE_RETIRED')).toBeGreaterThanOrEqual(1);
  });

  it('rejects invalid, hostile or unsafe rule content', async () => {
    for (const bad of [
      { ...definition(), requirement: { kind: 'SCRIPT', code: 'process.exit()' } },
      JSON.parse(
        '{"language":1,"scope":{"__proto__":{"admin":true}},"requirement":{"kind":"HUMAN_REVIEW"}}',
      ),
      { ...definition(), scope: { destinationCountries: ['ZZ9'] } },
    ]) {
      const response = await adminApi(manager).post('/compliance/rules', {
        title: 'Règle hostile',
        version: ruleContent({ definition: bad }),
      });
      expect(response.status, JSON.stringify(bad)).toBe(422);
      expect(response.body.code).toBe('COMPLIANCE_RULE_DEFINITION_INVALID');
    }
    const unknownCountry = await adminApi(manager).post('/compliance/rules', {
      title: 'Pays absent',
      version: ruleContent({
        definition: { ...definition(), scope: { destinationCountries: ['QQ'] } },
      }),
    });
    // QQ is a valid shape; it must also exist in the country catalogue.
    if (!(await db(t.app).country.findUnique({ where: { iso2: 'QQ' } }))) {
      expect(unknownCountry.body.code).toBe('COMPLIANCE_RULE_COUNTRY_UNKNOWN');
    }
    for (const version of [
      {
        ...ruleContent({ definition: definition() }),
        customerGuidance: '<script>alert(1)</script>',
      },
      {
        ...ruleContent({ definition: definition() }),
        source: { ...SYNTHETIC_SOURCE, url: 'javascript:alert(1)' },
      },
      {
        ...ruleContent({ definition: definition() }),
        source: { ...SYNTHETIC_SOURCE, url: 'http://insecure.example.test' },
      },
      {
        ...ruleContent({ definition: definition() }),
        source: { ...SYNTHETIC_SOURCE, url: 'https://user:pw@example.test/x' },
      },
      {
        ...ruleContent({ definition: definition() }),
        source: { ...SYNTHETIC_SOURCE, title: 'Titre <img src=x>' },
      },
      { ...ruleContent({ definition: definition() }), effectiveFrom: '2030-02-30' },
      {
        ...ruleContent({ definition: definition() }),
        effectiveFrom: '2030-02-01',
        effectiveTo: '2030-01-31',
      },
    ]) {
      const response = await adminApi(manager).post('/compliance/rules', {
        title: 'Contenu dangereux',
        version,
      });
      expect(response.status, JSON.stringify(version)).toBe(400);
    }
  });

  it('separates rule reading from rule management (least privilege)', async () => {
    const { reference, sha } = await draft();
    expect((await adminApi(agent).get('/compliance/rules')).status).toBe(200);
    expect((await adminApi(auditor).get(`/compliance/rules/${reference}`)).status).toBe(200);
    expect((await adminApi(bookingAgent).get('/compliance/rules')).status).toBe(403);
    for (const actor of [agent, auditor, bookingAgent]) {
      for (const [path, body] of [
        [
          '/compliance/rules',
          { title: 'Interdit', version: ruleContent({ definition: definition() }) },
        ],
        [
          `/compliance/rules/${reference}/versions/1/verify`,
          { definitionSha256: sha, sourceCheckedOn: today() },
        ],
        [`/compliance/rules/${reference}/versions/1/publish`, { definitionSha256: sha }],
      ] as const) {
        expect((await adminApi(actor).post(path, body)).status, `${actor.email} ${path}`).toBe(403);
      }
    }
    // Missing CSRF on a write is refused even for a manager.
    const noCsrf = await adminApi(manager).post(
      `/compliance/rules/${reference}/versions/1/verify`,
      { definitionSha256: sha, sourceCheckedOn: today() },
      { csrf: null },
    );
    expect(noCsrf.status).toBe(403);
  });
});
