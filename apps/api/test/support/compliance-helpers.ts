import { randomBytes } from 'node:crypto';
import type { ApiEnv } from '@euroteranga/config';
import { Prisma } from '@euroteranga/database';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  generateDocumentObjectKey,
  generateDocumentReference,
} from '../../src/passenger-documents/passenger-document-rules.js';
import { adminApi, type StaffActor } from './admin-helpers.js';
import { db } from './auth-helpers.js';
import { bookableFixture, bookingApi, holdBody, type CustomerActor } from './booking-helpers.js';
import { createPassenger } from './passenger-document-helpers.js';
import { paymentApi, settle } from './payment-helpers.js';

const DAY = 86_400_000;

/** A synthetic country (random ISO-like letters, retried on collision). */
export async function country(app: NestExpressApplication, name = 'Pays conformité synthétique') {
  for (;;) {
    const letters = Array.from(randomBytes(3), (byte) =>
      String.fromCharCode(65 + (byte % 26)),
    ).join('');
    const iso2 = letters.slice(0, 2);
    const taken = await db(app).country.findFirst({
      where: { OR: [{ iso2 }, { iso3: letters }] },
      select: { id: true },
    });
    if (taken) continue;
    try {
      const created = await db(app).country.create({ data: { iso2, iso3: letters, name } });
      return { id: created.id, iso2 };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue;
      throw error;
    }
  }
}

export interface Journey {
  bookingReference: string;
  tripReference: string;
  origin: { id: string; iso2: string };
  transit: { id: string; iso2: string };
  destination: { id: string; iso2: string };
  /** Calendar date (UTC stops) of the planned departure. */
  travelDate: string;
}

/**
 * A CONFIRMED synthetic journey: W1, W2 in the origin country, a checkpoint
 * in the transit country, W3-W5 in the destination country. The booking runs
 * W1 -> W3, so its country path is origin, transit, destination.
 */
export async function confirmedJourney(
  app: NestExpressApplication,
  env: ApiEnv,
  actor: CustomerActor,
  options: { departureInDays?: number; seats?: string[] } = {},
): Promise<Journey> {
  const [origin, transit, destination] = [
    await country(app),
    await country(app),
    await country(app),
  ];
  const stopIds: string[] = [];
  for (let index = 1; index <= 5; index += 1) {
    const stop = await db(app).stop.create({
      data: {
        code: `CPL_${randomBytes(4).toString('hex').toUpperCase()}`,
        name: `Arrêt conformité ${index}`,
        countryId: index <= 2 ? origin.id : destination.id,
        locality: `Localité ${index}`,
        latitude: 1,
        longitude: 1,
        timezone: 'Etc/UTC',
      },
    });
    stopIds.push(stop.id);
  }
  const departureInMs = (options.departureInDays ?? 30) * DAY;
  const fixture = await bookableFixture(app, {
    stopIds,
    countryId: transit.id,
    withCheckpoint: true,
    departureInMs,
    amount: () => 1_000,
  });
  const hold = await bookingApi(actor).post(
    '/bookings',
    holdBody(fixture, 1, 3, options.seats ?? ['1A']),
  );
  if (hold.status !== 201) throw new Error(`hold fixture failed: ${hold.status} ${hold.text}`);
  const payment = await paymentApi(actor).create(hold.body.reference as string);
  if (payment.status !== 201) throw new Error(`payment fixture failed: ${payment.text}`);
  const webhook = await settle(app, env, payment.body.payment);
  if (webhook.status !== 200) throw new Error(`confirmation fixture failed: ${webhook.text}`);
  const trip = await db(app).trip.findUniqueOrThrow({
    where: { id: fixture.tripId },
    select: { plannedDepartureAt: true },
  });
  return {
    bookingReference: hold.body.reference as string,
    tripReference: fixture.tripReference,
    origin,
    transit,
    destination,
    travelDate: trip.plannedDepartureAt!.toISOString().slice(0, 10),
  };
}

/** Synthetic passenger of the given nationality, attached to the journey. */
export async function journeyPassenger(
  actor: CustomerActor,
  journey: Journey,
  nationalityCountryId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const created = await createPassenger(
    actor,
    journey.bookingReference,
    nationalityCountryId,
    overrides,
  );
  if (created.status !== 201) throw new Error(`passenger fixture failed: ${created.text}`);
  return created.body.reference as string;
}

/**
 * A technically ACCEPTED document row written under every PR-11 guard (no
 * bytes are needed for compliance: the engine reads metadata only).
 */
export async function acceptedDocument(
  app: NestExpressApplication,
  passengerReference: string,
  type:
    'PASSPORT' | 'NATIONAL_ID' | 'VISA' | 'PARENTAL_AUTHORIZATION' | 'RESIDENCE_PERMIT' | 'OTHER',
  expiresAt: string | null,
) {
  const passenger = await db(app).passenger.findUniqueOrThrow({
    where: { reference: passengerReference },
  });
  const document = await db(app).passengerDocument.create({
    data: {
      reference: generateDocumentReference(),
      passengerId: passenger.id,
      type,
      objectKey: generateDocumentObjectKey(),
      sha256: 'ab'.repeat(32),
      mimeType: 'application/pdf',
      sizeBytes: 10n,
      ...(expiresAt ? { expiresAt: new Date(`${expiresAt}T00:00:00.000Z`) } : {}),
    },
  });
  const [{ now }] = await db(app).$queryRaw<[{ now: Date }]>`SELECT clock_timestamp() AS "now"`;
  await db(app).passengerDocument.update({
    where: { id: document.id },
    data: { status: 'ACCEPTED', acceptedAt: now },
  });
  return document.reference;
}

export interface SyntheticRule {
  title?: string;
  definition: unknown;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  guidance?: string;
}

export const SYNTHETIC_SOURCE: {
  authority: string | null;
  title: string | null;
  url: string | null;
  reference: string | null;
} = {
  authority: 'Autorité synthétique de test',
  title: 'Texte réglementaire fictif utilisé uniquement en test',
  url: 'https://regulations.example.test/synthetic-rule',
  reference: null,
};

export function ruleContent(rule: SyntheticRule) {
  return {
    definition: rule.definition,
    customerGuidance: rule.guidance ?? 'Consigne synthétique de test.',
    effectiveFrom: rule.effectiveFrom ?? '2020-01-01',
    effectiveTo: rule.effectiveTo ?? null,
    source: SYNTHETIC_SOURCE,
  };
}

const today = () => new Date().toISOString().slice(0, 10);

/** Creates, verifies and publishes a synthetic rule through the real API. */
export async function publishRule(manager: StaffActor, rule: SyntheticRule) {
  const api = adminApi(manager);
  const created = await api.post('/compliance/rules', {
    title: rule.title ?? `Règle synthétique ${randomBytes(3).toString('hex')}`,
    version: ruleContent(rule),
  });
  if (created.status !== 201)
    throw new Error(`rule fixture failed: ${created.status} ${created.text}`);
  const reference = created.body.reference as string;
  const sha = created.body.versions[0].definitionSha256 as string;
  const verified = await api.post(`/compliance/rules/${reference}/versions/1/verify`, {
    definitionSha256: sha,
    sourceCheckedOn: today(),
  });
  if (verified.status !== 200) throw new Error(`verify fixture failed: ${verified.text}`);
  const published = await api.post(`/compliance/rules/${reference}/versions/1/publish`, {
    definitionSha256: sha,
  });
  if (published.status !== 200) throw new Error(`publish fixture failed: ${published.text}`);
  return { reference, sha };
}

/** Full coverage of a journey with no document asked (synthetic). */
export const coverage = (journey: Journey) => ({
  language: 1,
  scope: {
    destinationCountries: [journey.destination.iso2],
    transitCountries: [journey.transit.iso2],
  },
  requirement: { kind: 'NO_DOCUMENT_REQUIRED' },
});

/** Customer compliance calls (owner session, customer origin, CSRF on POST). */
export function complianceApi(actor: CustomerActor) {
  return {
    summary: (bookingReference: string) =>
      bookingApi(actor).get(`/bookings/${bookingReference}/compliance`),
    evaluate: (
      bookingReference: string,
      passengerReference: string,
      options: { csrf?: string | null } = {},
    ) =>
      bookingApi(actor).post(
        `/bookings/${bookingReference}/passengers/${passengerReference}/compliance-evaluations`,
        {},
        options,
      ),
  };
}
