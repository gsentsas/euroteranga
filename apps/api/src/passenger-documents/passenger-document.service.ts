import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { Prisma, type DatabaseTransaction } from '@euroteranga/database';
import type { Logger } from '@euroteranga/logger';
import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import {
  customerIdentityOf,
  type AuthPrincipal,
  type CustomerActor,
} from '../auth/session/auth-principal.js';
import { RATE_LIMITS } from '../auth/rate-limit/rate-limit.rules.js';
import { RateLimitService } from '../auth/rate-limit/rate-limit.service.js';
import { AuditService } from '../authorization/audit.service.js';
import { API_LOGGER } from '../config/config.module.js';
import { DatabaseService } from '../database/database.service.js';
import {
  MalwareScannerError,
  MALWARE_SCANNER,
  type MalwareScanner,
} from './malware/malware-scanner.js';
import {
  PASSENGER_DOCUMENT_CONFIG,
  type PassengerDocumentConfig,
} from './passenger-document.config.js';
import type { AdminDocumentListQuery, PassengerCreate } from './passenger-document.dto.js';
import { PassengerDocumentErrors } from './passenger-document.errors.js';
import {
  normalizeDocumentReference,
  normalizePassengerReference,
  withFreshDocumentIdentity,
  withFreshPassengerReference,
} from './passenger-document-rules.js';
import {
  documentInclude,
  documentView,
  passengerInclude,
  passengerView,
  type DocumentRow,
} from './passenger-document-views.js';
import {
  parsePassengerDocumentUpload,
  UploadValidationError,
} from './passenger-document-upload.js';
import {
  ObjectStorageError,
  OBJECT_STORAGE_PROVIDER,
  type ObjectStorageProvider,
  type StoredObject,
} from './storage/object-storage.provider.js';

type RejectionCode =
  | 'MALWARE_DETECTED'
  | 'SCANNER_TIMEOUT'
  | 'SCANNER_UNAVAILABLE'
  | 'SCANNER_ERROR'
  | 'STORAGE_INTEGRITY_ERROR';

interface LockedBooking {
  id: string;
  confirmed_at: Date | null;
  cancelled_at: Date | null;
}

function uniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function capacityViolation(error: unknown): boolean {
  return String(error).includes('cannot have more passengers than seats');
}

function asPublicUploadError(error: UploadValidationError, maxBytes: number): never {
  if (error.code === 'TOO_LARGE') throw PassengerDocumentErrors.tooLarge(maxBytes);
  if (error.code === 'EMPTY') throw PassengerDocumentErrors.emptyUpload();
  if (error.code === 'UNSAFE_FILENAME') throw PassengerDocumentErrors.filenameUnsafe();
  if (error.code === 'UNSUPPORTED_MEDIA') throw PassengerDocumentErrors.unsupportedMedia();
  throw PassengerDocumentErrors.malformedUpload();
}

/**
 * Passenger foundation and private-document lifecycle. Database transactions
 * are intentionally short: storage and malware calls always happen outside
 * PostgreSQL transactions; any uncertain outcome remains inaccessible.
 */
@Injectable()
export class PassengerDocumentService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly rateLimits: RateLimitService,
    @Inject(PASSENGER_DOCUMENT_CONFIG) private readonly config: PassengerDocumentConfig,
    @Inject(OBJECT_STORAGE_PROVIDER) private readonly storage: ObjectStorageProvider,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
    @Inject(API_LOGGER) private readonly logger: Logger,
  ) {}

  async passengerCountries() {
    return {
      items: await this.database.client.country.findMany({
        where: { active: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: { id: true, iso2: true, name: true },
      }),
    };
  }

  async createPassenger(actor: CustomerActor, rawBookingReference: string, input: PassengerCreate) {
    const bookingReference = rawBookingReference.trim().toUpperCase();
    if (!/^ETB-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/.test(bookingReference)) {
      throw PassengerDocumentErrors.bookingNotFound();
    }

    let passengerReference: string;
    try {
      passengerReference = await withFreshPassengerReference(
        (reference) =>
          this.database.client.$transaction(async (tx) => {
            const [booking] = await tx.$queryRaw<LockedBooking[]>`
              SELECT "id", "confirmed_at", "cancelled_at"
              FROM "booking"
              WHERE "reference" = ${bookingReference}
                AND "customer_identity_id" = ${customerIdentityOf(actor)}::uuid
              FOR UPDATE`;
            if (!booking) throw PassengerDocumentErrors.bookingNotFound();
            if (!booking.confirmed_at || booking.cancelled_at) {
              throw PassengerDocumentErrors.bookingNotEligible();
            }
            const [seatCount, passengerCount, nationality] = await Promise.all([
              tx.bookingSeat.count({ where: { bookingId: booking.id } }),
              tx.bookingPassenger.count({ where: { bookingId: booking.id } }),
              tx.country.findUnique({
                where: { id: input.nationalityCountryId },
                select: { id: true },
              }),
            ]);
            if (!nationality) throw PassengerDocumentErrors.nationalityNotFound();
            if (passengerCount >= seatCount) throw PassengerDocumentErrors.capacityReached();

            const passenger = await tx.passenger.create({
              data: {
                reference,
                ownerCustomerIdentityId: customerIdentityOf(actor),
                givenName: input.givenName,
                familyName: input.familyName,
                dateOfBirth: input.dateOfBirth,
                nationalityCountryId: input.nationalityCountryId,
              },
              select: { id: true },
            });
            await tx.bookingPassenger.create({
              data: { bookingId: booking.id, passengerId: passenger.id },
            });
            await this.audit.record(
              {
                actor,
                action: 'PASSENGER_CREATED',
                resourceType: 'passenger',
                resourceId: passenger.id,
                after: { reference },
              },
              tx,
            );
            await this.audit.record(
              {
                actor,
                action: 'BOOKING_PASSENGER_ATTACHED',
                resourceType: 'booking',
                resourceId: booking.id,
                metadata: { bookingReference, passengerReference: reference },
              },
              tx,
            );
            return reference;
          }),
        uniqueViolation,
      );
    } catch (error) {
      if (capacityViolation(error)) throw PassengerDocumentErrors.capacityReached();
      throw error;
    }
    return this.customerPassenger(actor, passengerReference);
  }

  async bookingPassengers(actor: CustomerActor, rawBookingReference: string) {
    const bookingReference = rawBookingReference.trim().toUpperCase();
    const booking = await this.database.client.booking.findFirst({
      where: { reference: bookingReference, customerIdentityId: customerIdentityOf(actor) },
      select: { id: true },
    });
    if (!booking) throw PassengerDocumentErrors.bookingNotFound();
    const links = await this.database.client.bookingPassenger.findMany({
      where: { bookingId: booking.id },
      orderBy: { passengerId: 'asc' },
      select: { passenger: { include: passengerInclude } },
    });
    return { items: links.map(({ passenger }) => passengerView(passenger)) };
  }

  async customerPassenger(actor: CustomerActor, rawReference: string) {
    const reference = normalizePassengerReference(rawReference);
    if (!reference) throw PassengerDocumentErrors.passengerNotFound();
    const passenger = await this.database.client.passenger.findFirst({
      where: { reference, ownerCustomerIdentityId: customerIdentityOf(actor) },
      include: passengerInclude,
    });
    if (!passenger) throw PassengerDocumentErrors.passengerNotFound();
    return passengerView(passenger);
  }

  async customerDocuments(actor: AuthPrincipal, rawPassengerReference: string) {
    const passenger = await this.ownedPassenger(actor, rawPassengerReference);
    const documents = await this.database.client.passengerDocument.findMany({
      where: { passengerId: passenger.id },
      orderBy: { id: 'desc' },
      include: documentInclude,
    });
    return { items: documents.map(documentView) };
  }

  async upload(actor: AuthPrincipal, rawPassengerReference: string, request: Request) {
    const passenger = await this.ownedPassenger(actor, rawPassengerReference, true);
    if (this.config.storage.provider === 'DISABLED' || this.config.malware.scanner === 'DISABLED') {
      throw PassengerDocumentErrors.featureUnavailable();
    }
    await this.rateLimits.consume(RATE_LIMITS.passengerDocumentUploadIdentity, actor.identityId);

    let upload;
    try {
      upload = await parsePassengerDocumentUpload(request, this.config.maxBytes);
    } catch (error) {
      if (error instanceof UploadValidationError) {
        await this.auditRejectedInput(actor, passenger.id, error.code);
        return asPublicUploadError(error, this.config.maxBytes);
      }
      throw error;
    }

    let document: DocumentRow;
    try {
      document = await withFreshDocumentIdentity(
        async (reference, objectKey) => {
          try {
            await this.storage.put({
              key: objectKey,
              body: upload.body(),
              sizeBytes: upload.sizeBytes,
              mimeType: upload.mimeType,
            });
          } catch (error) {
            if (error instanceof ObjectStorageError && error.code === 'CONFLICT') throw error;
            await this.auditRejectedInput(actor, passenger.id, 'STORAGE_UNAVAILABLE');
            throw PassengerDocumentErrors.featureUnavailable();
          }

          try {
            return await this.database.client.$transaction(async (tx) => {
              const created = await tx.passengerDocument.create({
                data: {
                  reference,
                  passengerId: passenger.id,
                  type: upload.fields.type,
                  objectKey,
                  sha256: upload.sha256,
                  mimeType: upload.mimeType,
                  sizeBytes: BigInt(upload.sizeBytes),
                  ...(upload.fields.expiresAt ? { expiresAt: upload.fields.expiresAt } : {}),
                },
                include: documentInclude,
              });
              await this.audit.record(
                {
                  actor,
                  action: 'PASSENGER_DOCUMENT_UPLOADED',
                  resourceType: 'passenger_document',
                  resourceId: created.id,
                  after: {
                    reference,
                    passengerReference: passenger.reference,
                    type: upload.fields.type,
                    mimeType: upload.mimeType,
                    sizeBytes: upload.sizeBytes,
                    status: 'QUARANTINED',
                  },
                },
                tx,
              );
              return created;
            });
          } catch (error) {
            await this.deleteBestEffort(objectKey, reference);
            throw error;
          }
        },
        (error) =>
          uniqueViolation(error) ||
          (error instanceof ObjectStorageError && error.code === 'CONFLICT'),
      );
    } finally {
      await upload.cleanup();
    }

    return documentView(await this.scanQuarantined(document, actor));
  }

  async adminDocuments(actor: AuthPrincipal, query: AdminDocumentListQuery) {
    const where: Prisma.PassengerDocumentWhereInput = {
      ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.createdFrom || query.createdTo
        ? {
            createdAt: {
              ...(query.createdFrom ? { gte: query.createdFrom } : {}),
              ...(query.createdTo ? { lt: query.createdTo } : {}),
            },
          }
        : {}),
      ...(query.passengerReference ? { passenger: { reference: query.passengerReference } } : {}),
      ...(query.bookingReference
        ? {
            passenger: {
              ...(query.passengerReference ? { reference: query.passengerReference } : {}),
              bookings: { some: { booking: { reference: query.bookingReference } } },
            },
          }
        : {}),
    };
    const rows = await this.database.client.passengerDocument.findMany({
      where,
      take: query.limit + 1,
      orderBy: { id: 'desc' },
      include: documentInclude,
    });
    const items = rows.slice(0, query.limit).map(documentView);
    // A page names passengers next to their document types: one trace per
    // page (not per row) records exactly which references were shown.
    await this.database.client.$transaction((tx) =>
      this.audit.record(
        {
          actor,
          action: 'PASSENGER_DOCUMENT_ACCESSED',
          resourceType: 'passenger_document',
          metadata: {
            access: 'LIST',
            references: items.map((item) => item.reference),
            filters: {
              type: query.type ?? null,
              status: query.status ?? null,
              bookingReference: query.bookingReference ?? null,
              passengerReference: query.passengerReference ?? null,
            },
          },
        },
        tx,
      ),
    );
    return {
      items,
      nextCursor: rows.length > query.limit ? (rows[query.limit - 1]?.id ?? null) : null,
    };
  }

  async adminDocument(actor: AuthPrincipal, rawReference: string) {
    const document = await this.documentByReference(rawReference);
    await this.auditAccess(actor, document, 'METADATA');
    return documentView(document);
  }

  customerDownload(actor: AuthPrincipal, rawReference: string) {
    return this.download(rawReference, actor, { customerIdentityId: actor.identityId });
  }

  adminDownload(actor: AuthPrincipal, rawReference: string) {
    return this.download(rawReference, actor);
  }

  private async download(
    rawReference: string,
    actor: AuthPrincipal,
    scope?: { customerIdentityId: string },
  ): Promise<{ document: DocumentRow; stored: StoredObject }> {
    const reference = normalizeDocumentReference(rawReference);
    if (!reference) throw PassengerDocumentErrors.documentNotFound();
    const document = await this.database.client.passengerDocument.findFirst({
      where: {
        reference,
        status: 'ACCEPTED',
        ...(scope ? { passenger: { ownerCustomerIdentityId: scope.customerIdentityId } } : {}),
      },
      include: documentInclude,
    });
    if (!document) throw PassengerDocumentErrors.documentNotFound();
    let stored: StoredObject;
    try {
      stored = await this.storage.get(document.objectKey);
    } catch {
      throw PassengerDocumentErrors.featureUnavailable();
    }
    if (stored.sizeBytes !== Number(document.sizeBytes)) {
      stored.body.destroy();
      throw PassengerDocumentErrors.featureUnavailable();
    }
    try {
      await this.auditAccess(actor, document, 'CONTENT');
    } catch (error) {
      stored.body.destroy();
      throw error;
    }
    return { document, stored };
  }

  private async ownedPassenger(
    actor: AuthPrincipal,
    rawReference: string,
    needsConfirmedBooking = false,
  ) {
    const reference = normalizePassengerReference(rawReference);
    if (!reference) throw PassengerDocumentErrors.passengerNotFound();
    const passenger = await this.database.client.passenger.findFirst({
      where: {
        reference,
        ownerCustomerIdentityId: actor.identityId,
        ...(needsConfirmedBooking
          ? { bookings: { some: { booking: { confirmedAt: { not: null }, cancelledAt: null } } } }
          : {}),
      },
      select: { id: true, reference: true },
    });
    if (!passenger) throw PassengerDocumentErrors.passengerNotFound();
    return passenger;
  }

  private async scanQuarantined(document: DocumentRow, actor: AuthPrincipal): Promise<DocumentRow> {
    let rejection: RejectionCode | null = null;
    try {
      const stored = await this.storage.get(document.objectKey);
      if (stored.sizeBytes !== Number(document.sizeBytes)) {
        stored.body.destroy();
        rejection = 'STORAGE_INTEGRITY_ERROR';
      } else {
        const hash = createHash('sha256');
        const verified = Readable.from(
          (async function* () {
            for await (const part of stored.body) {
              const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array);
              hash.update(chunk);
              yield chunk;
            }
          })(),
        );
        const result = await this.scanner.scan(verified);
        if (hash.digest('hex') !== document.sha256) rejection = 'STORAGE_INTEGRITY_ERROR';
        else if (result.status === 'MALWARE') rejection = 'MALWARE_DETECTED';
      }
    } catch (error) {
      rejection =
        error instanceof MalwareScannerError
          ? error.code === 'TIMEOUT'
            ? 'SCANNER_TIMEOUT'
            : error.code === 'UNAVAILABLE'
              ? 'SCANNER_UNAVAILABLE'
              : 'SCANNER_ERROR'
          : error instanceof ObjectStorageError
            ? 'SCANNER_UNAVAILABLE'
            : 'SCANNER_ERROR';
    }

    if (rejection) {
      await this.reject(document, actor, rejection);
      await this.deleteBestEffort(document.objectKey, document.reference);
      if (rejection === 'MALWARE_DETECTED') throw PassengerDocumentErrors.malwareRejected();
      throw PassengerDocumentErrors.scannerUnavailable();
    }

    return this.database.client.$transaction(async (tx) => {
      const now = await this.now(tx);
      const accepted = await tx.passengerDocument.update({
        where: { id: document.id },
        data: { status: 'ACCEPTED', acceptedAt: now },
        include: documentInclude,
      });
      await this.audit.record(
        {
          actor,
          action: 'PASSENGER_DOCUMENT_ACCEPTED',
          resourceType: 'passenger_document',
          resourceId: accepted.id,
          after: { reference: accepted.reference, status: 'ACCEPTED' },
        },
        tx,
      );
      return accepted;
    });
  }

  private async reject(document: DocumentRow, actor: AuthPrincipal, failureCode: RejectionCode) {
    return this.database.client.$transaction(async (tx) => {
      const now = await this.now(tx);
      const rejected = await tx.passengerDocument.update({
        where: { id: document.id },
        data: { status: 'REJECTED', rejectedAt: now, failureCode },
        include: documentInclude,
      });
      await this.audit.record(
        {
          actor,
          action: 'PASSENGER_DOCUMENT_REJECTED',
          resourceType: 'passenger_document',
          resourceId: rejected.id,
          after: { reference: rejected.reference, status: 'REJECTED', failureCode },
        },
        tx,
      );
      return rejected;
    });
  }

  private async auditRejectedInput(actor: AuthPrincipal, passengerId: string, failureCode: string) {
    await this.database.client.$transaction((tx) =>
      this.audit.record(
        {
          actor,
          action: 'PASSENGER_DOCUMENT_REJECTED',
          resourceType: 'passenger',
          resourceId: passengerId,
          metadata: { failureCode },
        },
        tx,
      ),
    );
  }

  private async auditAccess(
    actor: AuthPrincipal,
    document: DocumentRow,
    access: 'METADATA' | 'CONTENT',
  ) {
    await this.database.client.$transaction((tx) =>
      this.audit.record(
        {
          actor,
          action: 'PASSENGER_DOCUMENT_ACCESSED',
          resourceType: 'passenger_document',
          resourceId: document.id,
          metadata: { reference: document.reference, access },
        },
        tx,
      ),
    );
  }

  private async documentByReference(rawReference: string): Promise<DocumentRow> {
    const reference = normalizeDocumentReference(rawReference);
    if (!reference) throw PassengerDocumentErrors.documentNotFound();
    const document = await this.database.client.passengerDocument.findUnique({
      where: { reference },
      include: documentInclude,
    });
    if (!document) throw PassengerDocumentErrors.documentNotFound();
    return document;
  }

  private async now(tx: DatabaseTransaction): Promise<Date> {
    const [row] = await tx.$queryRaw<[{ now: Date }]>`SELECT now() AS "now"`;
    return row!.now;
  }

  private async deleteBestEffort(objectKey: string, documentReference: string): Promise<void> {
    try {
      await this.storage.delete(objectKey);
    } catch {
      this.logger.warn('passenger document object cleanup deferred', {
        documentReference,
        code: 'OBJECT_DELETE_FAILED',
      });
    }
  }
}
