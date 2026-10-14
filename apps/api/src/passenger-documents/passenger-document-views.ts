import type { Prisma } from '@euroteranga/database';

export const passengerInclude = {
  nationalityCountry: { select: { iso2: true, iso3: true, name: true } },
  bookings: {
    orderBy: { bookingId: 'desc' },
    select: { booking: { select: { reference: true } } },
  },
} as const satisfies Prisma.PassengerInclude;

export type PassengerRow = Prisma.PassengerGetPayload<{ include: typeof passengerInclude }>;

export function passengerView(passenger: PassengerRow) {
  return {
    reference: passenger.reference,
    givenName: passenger.givenName,
    familyName: passenger.familyName,
    dateOfBirth: passenger.dateOfBirth.toISOString().slice(0, 10),
    nationality: passenger.nationalityCountry,
    bookingReferences: passenger.bookings.map(({ booking }) => booking.reference),
    createdAt: passenger.createdAt,
    updatedAt: passenger.updatedAt,
  };
}

export const documentInclude = {
  passenger: {
    select: {
      reference: true,
      givenName: true,
      familyName: true,
      bookings: {
        orderBy: { bookingId: 'desc' },
        select: { booking: { select: { reference: true } } },
      },
    },
  },
} as const satisfies Prisma.PassengerDocumentInclude;

export type DocumentRow = Prisma.PassengerDocumentGetPayload<{ include: typeof documentInclude }>;

/** Browser-safe metadata: never object key, bucket, scanner output or UUID. */
export function documentView(document: DocumentRow) {
  const sizeBytes = Number(document.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes)) throw new Error('document size exceeds safe integer range');
  return {
    reference: document.reference,
    passenger: {
      reference: document.passenger.reference,
      givenName: document.passenger.givenName,
      familyName: document.passenger.familyName,
    },
    bookingReferences: document.passenger.bookings.map(({ booking }) => booking.reference),
    type: document.type,
    mimeType: document.mimeType,
    sizeBytes,
    status: document.status,
    expiresAt: document.expiresAt?.toISOString().slice(0, 10) ?? null,
    createdAt: document.createdAt,
    acceptedAt: document.acceptedAt,
    rejectedAt: document.rejectedAt,
  };
}
