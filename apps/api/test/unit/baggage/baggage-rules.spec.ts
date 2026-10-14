import { renderSVG } from 'uqr';
import { describe, expect, it } from 'vitest';
import {
  BAGGAGE_QR_RENDER_OPTIONS,
  BAGGAGE_REFERENCE_PATTERN,
  baggageEventFingerprint,
  baggageQrPayload,
  BaggageTransitionError,
  generateBaggageReference,
  normalizeBaggageReference,
  normalizeWeightKg,
  parseBaggageQrPayload,
  projectBaggageEvent,
  renderBaggageQrSvg,
  withFreshBaggageReference,
  type BaggageProjection,
} from '../../../src/baggage/baggage-rules.js';

describe('baggage public identity and QR', () => {
  it('creates the fixed opaque ETG reference and round-trips only QR v1', () => {
    const reference = generateBaggageReference(() => 31);
    expect(reference).toBe('ETG-ZZZZZZZZZZZZ');
    expect(reference).toMatch(BAGGAGE_REFERENCE_PATTERN);
    expect(normalizeBaggageReference('  etg-0123456789ab  ')).toBe('ETG-0123456789AB');
    expect(normalizeBaggageReference('ETG-ILOU01234567')).toBeNull();

    const payload = baggageQrPayload(reference);
    expect(payload).toBe(`ETG1:${reference}`);
    expect(parseBaggageQrPayload(`  ${payload.toLowerCase()}  `)).toBe(reference);
    expect(parseBaggageQrPayload(`ETG2:${reference}`)).toBeNull();
    expect(parseBaggageQrPayload(`${payload}:passenger@example.test`)).toBeNull();
    expect(payload).not.toMatch(/@|awa|passenger|booking/iu);
  });

  it('renders locally the SVG of exactly the versioned payload, nothing more', () => {
    const reference = 'ETG-0123456789AB';
    const svg = renderBaggageQrSvg(reference);
    expect(svg).toBe(renderSVG(`ETG1:${reference}`, BAGGAGE_QR_RENDER_OPTIONS));
    expect(svg).not.toBe(renderSVG(`ETG1:${reference}:Awa Ndiaye`, BAGGAGE_QR_RENDER_OPTIONS));
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u);
    // Static shapes only: no script, event handler or external reference.
    expect(svg).not.toMatch(/<script|<foreignObject|\son[a-z]+=|href=/iu);
    expect(() => renderBaggageQrSvg('ETB-0123456789AB')).toThrow('invalid baggage reference');
  });

  it('retries reference collisions, but never masks a different failure', async () => {
    const generated = ['ETG-000000000000', 'ETG-111111111111'];
    let calls = 0;
    const result = await withFreshBaggageReference(
      async (reference) => {
        calls += 1;
        if (calls === 1) throw new Error('collision');
        return reference;
      },
      (error) => String(error).includes('collision'),
      () => generated.shift()!,
    );
    expect(result).toBe('ETG-111111111111');
    expect(calls).toBe(2);

    await expect(
      withFreshBaggageReference(
        async () => {
          throw new Error('storage unavailable');
        },
        () => false,
      ),
    ).rejects.toThrow('storage unavailable');
  });
});

describe('exact baggage weight', () => {
  it.each([
    ['0.001', '0.001'],
    ['12.345', '12.345'],
    ['99.999', '99.999'],
    ['7', '7.000'],
    ['7.2', '7.200'],
  ])('normalizes %s without Number conversion', (input, expected) => {
    expect(normalizeWeightKg(input)).toBe(expected);
  });

  it.each(['0', '0.000', '-1', '1.2345', '1000', '1e2', 'NaN', '+1'])(
    'rejects the invalid weight %s',
    (input) => expect(normalizeWeightKg(input)).toBeNull(),
  );
});

describe('baggage event projection', () => {
  const registered = (): BaggageProjection => ({
    lifecycleStatus: 'REGISTERED',
    exceptionStatus: null,
    measuredWeightKg: null,
  });

  it('proves the complete normal lifecycle and retains an exact weight', () => {
    let projection = projectBaggageEvent(registered(), 'WEIGHT_UPDATED', '12.345');
    for (const event of ['CHECKED_IN', 'LOADED', 'IN_TRANSIT', 'ARRIVED', 'DELIVERED'] as const) {
      projection = projectBaggageEvent(projection, event);
    }
    expect(projection).toEqual({
      lifecycleStatus: 'DELIVERED',
      exceptionStatus: null,
      measuredWeightKg: '12.345',
    });
  });

  it('models an exception independently and requires resolution before progress', () => {
    const missing = projectBaggageEvent(registered(), 'MISSING');
    expect(missing).toMatchObject({ lifecycleStatus: 'REGISTERED', exceptionStatus: 'MISSING' });
    expect(() => projectBaggageEvent(missing, 'CHECKED_IN')).toThrow(BaggageTransitionError);
    const resolved = projectBaggageEvent(missing, 'EXCEPTION_RESOLVED');
    expect(projectBaggageEvent(resolved, 'CHECKED_IN').lifecycleStatus).toBe('CHECKED_IN');
  });

  it.each([
    ['REGISTERED', 'DELIVERED'],
    ['CHECKED_IN', 'ARRIVED'],
    ['LOADED', 'CHECKED_IN'],
    ['DELIVERED', 'REMOVED'],
  ] as const)('refuses %s -> %s', (from, event) => {
    expect(() =>
      projectBaggageEvent(
        { lifecycleStatus: from, exceptionStatus: null, measuredWeightKg: null },
        event,
      ),
    ).toThrow(BaggageTransitionError);
  });

  it('makes REMOVED terminal for weight, exception and lifecycle events', () => {
    const removed = projectBaggageEvent(registered(), 'REMOVED');
    for (const event of [
      'WEIGHT_UPDATED',
      'MISSING',
      'EXCEPTION_RESOLVED',
      'CHECKED_IN',
    ] as const) {
      expect(() => projectBaggageEvent(removed, event, '1.000'), event).toThrow(
        BaggageTransitionError,
      );
    }
  });

  it('fingerprints every idempotency-relevant field deterministically', () => {
    const base = {
      type: 'LOADED' as const,
      occurredAt: new Date('2030-01-02T03:04:05.000Z'),
      routeWaypointId: null,
      measuredWeightKg: null,
    };
    const fingerprint = baggageEventFingerprint(base);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(baggageEventFingerprint({ ...base })).toBe(fingerprint);
    expect(baggageEventFingerprint({ ...base, routeWaypointId: 'different' })).not.toBe(
      fingerprint,
    );
    expect(baggageEventFingerprint({ ...base, type: 'ARRIVED' })).not.toBe(fingerprint);
  });
});
