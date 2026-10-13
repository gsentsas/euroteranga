import { describe, expect, it } from 'vitest';
import {
  BOOKING_REFERENCE_ALPHABET,
  BOOKING_REFERENCE_PATTERN,
  bookingStatus,
  generateBookingReference,
  journeySegments,
  normalizeBookingReference,
  totalAmountMinor,
  withFreshReference,
} from '../../../src/bookings/booking-rules.js';
import {
  bookingCreateSchema,
  bookingSearchQuerySchema,
  encodeSearchCursor,
} from '../../../src/bookings/booking.dto.js';

const MAX_AMOUNT_MINOR = 2_147_483_647;

describe('booking reference', () => {
  it('is ETB- plus 12 unambiguous characters drawn from the CSPRNG', () => {
    const references = new Set(Array.from({ length: 2000 }, () => generateBookingReference()));
    expect(references.size).toBe(2000);
    for (const reference of references) expect(reference).toMatch(BOOKING_REFERENCE_PATTERN);
    expect(BOOKING_REFERENCE_ALPHABET).toHaveLength(32);
    expect(BOOKING_REFERENCE_ALPHABET).not.toMatch(/[ILOU]/);
    // Every symbol of the alphabet is reachable.
    expect(generateBookingReference(() => 31)).toBe('ETB-ZZZZZZZZZZZZ');
    expect(generateBookingReference(() => 0)).toBe('ETB-000000000000');
  });

  it('normalizes customer input and rejects anything else', () => {
    expect(normalizeBookingReference(' etb-0123456789ab ')).toBe('ETB-0123456789AB');
    for (const value of [
      'BOOKING-000001',
      'ETB-0123456789A',
      'ETB-0123456789IL',
      '',
      'ETB-0123456789AB?',
    ]) {
      expect(normalizeBookingReference(value), value).toBeNull();
    }
  });

  it('retries with a fresh reference on a collision, and only then', async () => {
    const generated = ['ETB-AAAAAAAAAAAA', 'ETB-BBBBBBBBBBBB', 'ETB-CCCCCCCCCCCC'];
    const collision = new Error('collision');
    const tried: string[] = [];
    const result = await withFreshReference(
      async (reference) => {
        tried.push(reference);
        if (reference === 'ETB-AAAAAAAAAAAA') throw collision;
        return reference;
      },
      (error) => error === collision,
      () => generated.shift()!,
    );
    expect(result).toBe('ETB-BBBBBBBBBBBB');
    expect(tried).toEqual(['ETB-AAAAAAAAAAAA', 'ETB-BBBBBBBBBBBB']);
    const other = new Error('other');
    await expect(
      withFreshReference(
        async () => Promise.reject(other),
        (error) => error === collision,
      ),
    ).rejects.toBe(other);
    let attempts = 0;
    await expect(
      withFreshReference(
        async () => {
          attempts += 1;
          throw collision;
        },
        (error) => error === collision,
      ),
    ).rejects.toBe(collision);
    expect(attempts).toBe(3);
  });
});

describe('journey segments', () => {
  it('cover [origin, destination): never the destination itself', () => {
    expect(journeySegments(1, 4)).toEqual([1, 2, 3]);
    expect(journeySegments(2, 5)).toEqual([2, 3, 4]);
    expect(journeySegments(3, 4)).toEqual([3]);
    // Adjacent journeys share no segment; overlapping ones do.
    const shared = (a: number[], b: number[]) => a.filter((segment) => b.includes(segment));
    expect(shared(journeySegments(1, 3), journeySegments(3, 5))).toEqual([]);
    expect(shared(journeySegments(1, 4), journeySegments(3, 5))).toEqual([3]);
    expect(journeySegments(3, 3)).toEqual([]);
    expect(() => journeySegments(1.5, 3)).toThrow();
  });
});

describe('derived status', () => {
  const now = new Date('2030-01-01T10:00:00Z');
  it('is CANCELLED, else EXPIRED at or after the expiry, else HELD', () => {
    const later = new Date('2030-01-01T10:00:01Z');
    expect(bookingStatus({ cancelledAt: now, holdExpiresAt: later }, now)).toBe('CANCELLED');
    expect(bookingStatus({ cancelledAt: null, holdExpiresAt: now }, now)).toBe('EXPIRED');
    expect(bookingStatus({ cancelledAt: null, holdExpiresAt: later }, now)).toBe('HELD');
  });
});

describe('exact totals', () => {
  it('multiplies in integers and stays a safe integer at the configured bounds', () => {
    expect(totalAmountMinor(12_550, 2)).toBe(25_100);
    expect(totalAmountMinor(15_000, 8)).toBe(120_000);
    expect(totalAmountMinor(MAX_AMOUNT_MINOR, 20)).toBe(42_949_672_940);
    expect(Number.isSafeInteger(totalAmountMinor(MAX_AMOUNT_MINOR, 20))).toBe(true);
    expect(() => totalAmountMinor(Number.MAX_SAFE_INTEGER, 2)).toThrow(/safe integer/);
    expect(() => totalAmountMinor(1.5, 2)).toThrow();
  });
});

describe('request validation', () => {
  const id = '01900000-0000-7000-8000-000000000001';
  it('accepts only trip, journey and seats in a hold request', () => {
    const body = {
      tripId: id,
      originRouteWaypointId: id,
      destinationRouteWaypointId: id,
      seatMapCellIds: [id],
    };
    expect(bookingCreateSchema.safeParse(body).success).toBe(true);
    for (const extra of [
      { unitAmountMinor: 1 },
      { currencyCode: 'EUR' },
      { customerIdentityId: id },
      { email: 'a@b.test' },
    ]) {
      expect(bookingCreateSchema.safeParse({ ...body, ...extra }).success).toBe(false);
    }
    expect(bookingCreateSchema.safeParse({ ...body, seatMapCellIds: [] }).success).toBe(false);
  });

  it('round-trips a search cursor and rejects forged ones', () => {
    const cursor = encodeSearchCursor({
      departureAt: new Date('2030-01-01T08:00:00Z'),
      tripId: id,
      originRouteWaypointId: id,
      destinationRouteWaypointId: id,
    });
    const parsed = bookingSearchQuerySchema.parse({
      originStopId: id,
      destinationStopId: '01900000-0000-7000-8000-000000000002',
      cursor,
    });
    expect(parsed.cursor).toMatchObject({
      tripId: id,
      departureAt: new Date('2030-01-01T08:00:00Z'),
    });
    for (const forged of [
      'not-base64',
      Buffer.from('["x"]').toString('base64url'),
      Buffer.from('{}').toString('base64url'),
    ]) {
      expect(
        bookingSearchQuerySchema.safeParse({
          originStopId: id,
          destinationStopId: '01900000-0000-7000-8000-000000000002',
          cursor: forged,
        }).success,
        forged,
      ).toBe(false);
    }
  });
});
