import { createHash, randomBytes } from 'node:crypto';
import { Prisma } from '@euroteranga/database';
import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { z } from 'zod';
import { PublicApiError } from '../auth/http/public-api-error.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import {
  MalwareScannerError,
  MALWARE_SCANNER,
  type MalwareScanner,
} from '../passenger-documents/malware/malware-scanner.js';
import {
  PASSENGER_DOCUMENT_CONFIG,
  type PassengerDocumentConfig,
} from '../passenger-documents/passenger-document.config.js';
import { UploadValidationError } from '../passenger-documents/passenger-document-upload.js';
import {
  ObjectStorageError,
  OBJECT_STORAGE_PROVIDER,
  type ObjectStorageProvider,
  type StoredObject,
} from '../passenger-documents/storage/object-storage.provider.js';
import type {
  incidentActionSchema,
  incidentCrewReportSchema,
  incidentListQuerySchema,
  incidentOpenStaffSchema,
  incidentOwnerSchema,
  incidentTransitionSchema,
} from './incident.dto.js';
import { parseIncidentAttachmentUpload } from './incident-attachment-upload.js';
import { IncidentErrors } from './incident.errors.js';
import { generateIncidentReference } from './incident-rules.js';

type StaffOpen = z.infer<typeof incidentOpenStaffSchema>;
type CrewOpen = z.infer<typeof incidentCrewReportSchema>;
type ListQuery = z.infer<typeof incidentListQuerySchema>;
type ActionInput = z.infer<typeof incidentActionSchema>;
type TransitionInput = z.infer<typeof incidentTransitionSchema>;
type OwnerInput = z.infer<typeof incidentOwnerSchema>;

const summarySelect = {
  id: true,
  reference: true,
  type: true,
  severity: true,
  status: true,
  source: true,
  description: true,
  locationLabel: true,
  openedAt: true,
  recordedAt: true,
  resolvedAt: true,
  closedAt: true,
  ownerIdentityId: true,
  trip: { select: { id: true, reference: true, status: true } },
  vehicle: { select: { id: true, code: true } },
  routeWaypoint: {
    select: {
      id: true,
      sequence: true,
      stop: { select: { code: true, name: true } },
      checkpoint: { select: { code: true, name: true, type: true } },
    },
  },
  baggage: { select: { id: true, reference: true, exceptionStatus: true } },
  _count: { select: { actions: true, attachments: true } },
} satisfies Prisma.IncidentSelect;

const actionSelect = {
  id: true,
  sequence: true,
  type: true,
  content: true,
  clientActionId: true,
  createdByIdentityId: true,
  createdAt: true,
} satisfies Prisma.IncidentActionSelect;

const attachmentSelect = {
  id: true,
  sha256: true,
  mimeType: true,
  sizeBytes: true,
  uploadedByIdentityId: true,
  createdAt: true,
} satisfies Prisma.IncidentAttachmentSelect;

type SummaryRow = Prisma.IncidentGetPayload<{ select: typeof summarySelect }>;

function stableFingerprint(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}

function incidentAttachmentObjectKey(): string {
  const body = randomBytes(32).toString('hex');
  return 'incident-attachments/' + body.slice(0, 2) + '/' + body;
}

function attachmentUploadError(error: UploadValidationError, maxBytes: number): never {
  if (error.code === 'TOO_LARGE') throw IncidentErrors.attachmentTooLarge(maxBytes);
  if (error.code === 'UNSUPPORTED_MEDIA' || error.code === 'UNSAFE_FILENAME') {
    throw IncidentErrors.attachmentUnsupported();
  }
  throw IncidentErrors.attachmentMalformed();
}

function uniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function summaryView(row: SummaryRow) {
  const waypoint = row.routeWaypoint;
  return {
    id: row.id,
    reference: row.reference,
    type: row.type,
    severity: row.severity,
    status: row.status,
    source: row.source,
    description: row.description,
    locationLabel: row.locationLabel,
    openedAt: row.openedAt,
    recordedAt: row.recordedAt,
    resolvedAt: row.resolvedAt,
    closedAt: row.closedAt,
    ownerIdentityId: row.ownerIdentityId,
    trip: row.trip,
    vehicle: row.vehicle,
    waypoint: waypoint
      ? {
          id: waypoint.id,
          sequence: waypoint.sequence,
          code: waypoint.stop?.code ?? waypoint.checkpoint?.code ?? null,
          name: waypoint.stop?.name ?? waypoint.checkpoint?.name ?? null,
          checkpointType: waypoint.checkpoint?.type ?? null,
        }
      : null,
    baggage: row.baggage,
    actionCount: row._count.actions,
    attachmentCount: row._count.attachments,
  };
}

function mapDatabaseViolation(error: unknown): never {
  const message = String(error instanceof Error ? error.message : error);
  if (message.includes('scheduled or in-progress trip')) throw IncidentErrors.tripUnavailable();
  if (message.includes('waypoint must belong')) throw IncidentErrors.waypointInvalid();
  if (message.includes('missing or damaged bag')) throw IncidentErrors.baggageInvalid();
  if (message.includes('opened_at is too far')) throw IncidentErrors.timestampInvalid();
  if (message.includes('invalid incident status transition'))
    throw IncidentErrors.transitionInvalid();
  if (
    message.includes('requires an action plan') ||
    message.includes('requires passenger notification') ||
    message.includes('requires a postmortem')
  ) {
    throw IncidentErrors.criticalMilestoneMissing();
  }
  if (message.includes('owner must be active STAFF')) throw IncidentErrors.ownerInvalid();
  if (message.includes('closed incidents')) throw IncidentErrors.closed();
  throw error;
}

@Injectable()
export class IncidentService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    @Inject(PASSENGER_DOCUMENT_CONFIG) private readonly documentConfig: PassengerDocumentConfig,
    @Inject(OBJECT_STORAGE_PROVIDER) private readonly storage: ObjectStorageProvider,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
  ) {}

  private assertTimestamp(openedAt: Date): void {
    if (openedAt.getTime() > Date.now() + 5 * 60_000) throw IncidentErrors.timestampInvalid();
  }

  private async tripContext(tripReference: string) {
    const trip = await this.database.client.trip.findUnique({
      where: { reference: tripReference.trim().toUpperCase() },
      select: { id: true, reference: true, status: true, vehicleId: true, routeVersionId: true },
    });
    if (!trip) throw IncidentErrors.tripNotFound();
    if (trip.status !== 'SCHEDULED' && trip.status !== 'IN_PROGRESS') {
      throw IncidentErrors.tripUnavailable();
    }
    return trip;
  }

  private async baggageId(tripId: string, reference: string | undefined) {
    if (!reference) return null;
    const row = await this.database.client.baggage.findUnique({
      where: { reference },
      select: {
        id: true,
        exceptionStatus: true,
        bookingPassenger: { select: { booking: { select: { tripId: true } } } },
      },
    });
    if (
      !row ||
      row.bookingPassenger.booking.tripId !== tripId ||
      (row.exceptionStatus !== 'MISSING' && row.exceptionStatus !== 'DAMAGED')
    ) {
      throw IncidentErrors.baggageInvalid();
    }
    return row.id;
  }

  private async assertWaypoint(tripId: string, routeWaypointId: string | undefined): Promise<void> {
    if (!routeWaypointId) return;
    const row = await this.database.client.trip.findFirst({
      where: {
        id: tripId,
        routeVersion: { waypoints: { some: { id: routeWaypointId } } },
      },
      select: { id: true },
    });
    if (!row) throw IncidentErrors.waypointInvalid();
  }

  private replay(tripId: string, clientEventId: string) {
    return this.database.client.incident.findUnique({
      where: { tripId_clientEventId: { tripId, clientEventId } },
      select: { payloadFingerprint: true, ...summarySelect },
    });
  }

  private async persist(
    actor: AuthPrincipal,
    input: {
      tripId: string;
      vehicleId: string | null;
      routeWaypointId?: string;
      baggageId: string | null;
      type: StaffOpen['type'];
      severity: StaffOpen['severity'];
      description: string;
      locationLabel?: string;
      openedAt: Date;
      ownerIdentityId?: string;
      clientEventId: string;
      source: 'STAFF' | 'CREW';
      crewAssignmentId?: string;
      crewDeviceId?: string;
    },
  ) {
    this.assertTimestamp(input.openedAt);
    const payloadFingerprint = stableFingerprint([
      input.tripId,
      input.vehicleId,
      input.routeWaypointId ?? null,
      input.baggageId,
      input.type,
      input.severity,
      input.description,
      input.locationLabel ?? null,
      input.openedAt.toISOString(),
      input.ownerIdentityId ?? null,
      input.source,
    ]);
    const existing = await this.replay(input.tripId, input.clientEventId);
    if (existing) {
      if (existing.payloadFingerprint !== payloadFingerprint)
        throw IncidentErrors.idempotencyConflict();
      const { payloadFingerprint: _fingerprint, ...row } = existing;
      return { created: false, incident: summaryView(row) };
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.database.client.$transaction(async (tx) => {
          const row = await tx.incident.create({
            data: {
              reference: generateIncidentReference(),
              tripId: input.tripId,
              vehicleId: input.vehicleId,
              ...(input.routeWaypointId ? { routeWaypointId: input.routeWaypointId } : {}),
              ...(input.baggageId ? { baggageId: input.baggageId } : {}),
              type: input.type,
              severity: input.severity,
              source: input.source,
              description: input.description,
              ...(input.locationLabel ? { locationLabel: input.locationLabel } : {}),
              openedAt: input.openedAt,
              openedByIdentityId: actor.identityId,
              ...(input.ownerIdentityId ? { ownerIdentityId: input.ownerIdentityId } : {}),
              clientEventId: input.clientEventId,
              payloadFingerprint,
              ...(input.crewAssignmentId ? { crewAssignmentId: input.crewAssignmentId } : {}),
              ...(input.crewDeviceId ? { crewDeviceId: input.crewDeviceId } : {}),
            },
            select: summarySelect,
          });
          await this.audit.record(
            {
              actor,
              action: 'INCIDENT_OPENED',
              resourceType: 'incident',
              resourceId: row.id,
              after: {
                reference: row.reference,
                tripReference: row.trip.reference,
                type: row.type,
                severity: row.severity,
                source: row.source,
                status: row.status,
              },
            },
            tx,
          );
          return { created: true, incident: summaryView(row) };
        });
      } catch (error) {
        if (uniqueViolation(error)) {
          const replay = await this.replay(input.tripId, input.clientEventId);
          if (replay) {
            if (replay.payloadFingerprint !== payloadFingerprint)
              throw IncidentErrors.idempotencyConflict();
            const { payloadFingerprint: _fingerprint, ...row } = replay;
            return { created: false, incident: summaryView(row) };
          }
          if (attempt < 3) continue;
        }
        mapDatabaseViolation(error);
      }
    }
    throw IncidentErrors.idempotencyConflict();
  }

  async openStaff(actor: AuthPrincipal, input: StaffOpen) {
    const trip = await this.tripContext(input.tripReference);
    await this.assertWaypoint(trip.id, input.routeWaypointId);
    const baggageId = await this.baggageId(trip.id, input.baggageReference);
    return this.persist(actor, {
      tripId: trip.id,
      vehicleId: trip.vehicleId,
      ...(input.routeWaypointId ? { routeWaypointId: input.routeWaypointId } : {}),
      baggageId,
      type: input.type,
      severity: input.severity,
      description: input.description,
      ...(input.locationLabel ? { locationLabel: input.locationLabel } : {}),
      openedAt: input.openedAt,
      ...(input.ownerIdentityId ? { ownerIdentityId: input.ownerIdentityId } : {}),
      clientEventId: input.clientEventId,
      source: 'STAFF',
    });
  }

  async reportCrew(actor: AuthPrincipal, rawTripReference: string, input: CrewOpen) {
    const trip = await this.tripContext(rawTripReference);
    const now = new Date();
    const assignment = await this.database.client.crewTripAssignment.findFirst({
      where: {
        tripId: trip.id,
        crewIdentityId: actor.identityId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { id: true },
    });
    if (!assignment) throw IncidentErrors.crewUnavailable();
    const device = await this.database.client.crewDevice.findFirst({
      where: {
        deviceId: input.deviceId,
        identityId: actor.identityId,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: { id: true },
    });
    if (!device) throw IncidentErrors.crewDeviceUnavailable();
    await this.database.client.crewDevice.update({
      where: { id: device.id },
      data: { lastSeenAt: now },
      select: { id: true },
    });
    await this.assertWaypoint(trip.id, input.routeWaypointId);
    const baggageId = await this.baggageId(trip.id, input.baggageReference);
    return this.persist(actor, {
      tripId: trip.id,
      vehicleId: trip.vehicleId,
      ...(input.routeWaypointId ? { routeWaypointId: input.routeWaypointId } : {}),
      baggageId,
      type: input.type,
      severity: input.severity,
      description: input.description,
      ...(input.locationLabel ? { locationLabel: input.locationLabel } : {}),
      openedAt: input.openedAt,
      clientEventId: input.clientEventId,
      source: 'CREW',
      crewAssignmentId: assignment.id,
      crewDeviceId: device.id,
    });
  }

  async owners() {
    const rows = await this.database.client.authIdentity.findMany({
      where: { realm: 'STAFF', status: 'ACTIVE' },
      orderBy: [{ email: 'asc' }, { id: 'asc' }],
      select: { id: true, email: true },
      take: 500,
    });
    return { items: rows };
  }

  async list(input: ListQuery) {
    const rows = await this.database.client.incident.findMany({
      where: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.severity ? { severity: input.severity } : {}),
        ...(input.type ? { type: input.type } : {}),
        ...(input.tripReference ? { trip: { reference: input.tripReference } } : {}),
        ...(input.ownerIdentityId ? { ownerIdentityId: input.ownerIdentityId } : {}),
      },
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      select: summarySelect,
    });
    const hasMore = rows.length > input.limit;
    const items = rows.slice(0, input.limit);
    return {
      items: items.map(summaryView),
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
    };
  }

  async detail(reference: string) {
    const row = await this.database.client.incident.findUnique({
      where: { reference },
      select: {
        ...summarySelect,
        actions: { orderBy: { sequence: 'asc' }, select: actionSelect },
        attachments: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: attachmentSelect },
      },
    });
    if (!row) throw IncidentErrors.notFound();
    const { actions, attachments, ...summary } = row;
    return { ...summaryView(summary), actions, attachments };
  }

  async uploadAttachment(actor: AuthPrincipal, reference: string, request: Request) {
    const incident = await this.database.client.incident.findUnique({
      where: { reference },
      select: { id: true, status: true },
    });
    if (!incident) throw IncidentErrors.notFound();
    if (incident.status === 'CLOSED') throw IncidentErrors.closed();
    if (
      this.documentConfig.storage.provider === 'DISABLED' ||
      this.documentConfig.malware.scanner === 'DISABLED'
    ) {
      throw IncidentErrors.attachmentFeatureUnavailable();
    }

    let upload;
    try {
      upload = await parseIncidentAttachmentUpload(request, this.documentConfig.maxBytes);
    } catch (error) {
      if (error instanceof UploadValidationError) {
        await this.auditAttachment(actor, incident.id, 'INCIDENT_ATTACHMENT_REJECTED', {
          failureCode: error.code,
        });
        return attachmentUploadError(error, this.documentConfig.maxBytes);
      }
      throw error;
    }

    let objectKey: string | null = null;
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const candidate = incidentAttachmentObjectKey();
        try {
          await this.storage.put({
            key: candidate,
            body: upload.body(),
            sizeBytes: upload.sizeBytes,
            mimeType: upload.mimeType,
          });
          objectKey = candidate;
          break;
        } catch (error) {
          if (error instanceof ObjectStorageError && error.code === 'CONFLICT') continue;
          await this.auditAttachment(actor, incident.id, 'INCIDENT_ATTACHMENT_REJECTED', {
            failureCode: 'STORAGE_UNAVAILABLE',
          });
          throw IncidentErrors.attachmentFeatureUnavailable();
        }
      }
      if (!objectKey) throw IncidentErrors.attachmentFeatureUnavailable();
      const storedObjectKey = objectKey;

      let stored: StoredObject;
      try {
        stored = await this.storage.get(storedObjectKey);
      } catch {
        await this.deleteAttachmentBestEffort(storedObjectKey);
        throw IncidentErrors.attachmentFeatureUnavailable();
      }
      if (stored.sizeBytes !== upload.sizeBytes) {
        stored.body.destroy();
        await this.deleteAttachmentBestEffort(storedObjectKey);
        throw IncidentErrors.attachmentFeatureUnavailable();
      }

      try {
        const scan = await this.scanner.scan(stored.body);
        if (scan.status === 'MALWARE') {
          await this.deleteAttachmentBestEffort(storedObjectKey);
          await this.auditAttachment(actor, incident.id, 'INCIDENT_ATTACHMENT_REJECTED', {
            failureCode: 'MALWARE_DETECTED',
          });
          throw IncidentErrors.attachmentMalware();
        }
      } catch (error) {
        if (error instanceof PublicApiError) throw error;
        await this.deleteAttachmentBestEffort(storedObjectKey);
        const failureCode =
          error instanceof MalwareScannerError ? 'SCANNER_' + error.code : 'SCANNER_UNAVAILABLE';
        await this.auditAttachment(actor, incident.id, 'INCIDENT_ATTACHMENT_REJECTED', {
          failureCode,
        });
        throw IncidentErrors.attachmentFeatureUnavailable();
      }

      try {
        return await this.database.client.$transaction(async (tx) => {
          const attachment = await tx.incidentAttachment.create({
            data: {
              incidentId: incident.id,
              objectKey: storedObjectKey,
              sha256: upload.sha256,
              mimeType: upload.mimeType,
              sizeBytes: upload.sizeBytes,
              uploadedByIdentityId: actor.identityId,
            },
            select: attachmentSelect,
          });
          await this.audit.record(
            {
              actor,
              action: 'INCIDENT_ATTACHMENT_UPLOADED',
              resourceType: 'incident_attachment',
              resourceId: attachment.id,
              after: {
                incidentReference: reference,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
                sha256: attachment.sha256,
              },
            },
            tx,
          );
          return attachment;
        });
      } catch (error) {
        await this.deleteAttachmentBestEffort(storedObjectKey);
        mapDatabaseViolation(error);
      }
    } finally {
      await upload.cleanup();
    }
  }

  async downloadAttachment(
    actor: AuthPrincipal,
    reference: string,
    attachmentId: string,
  ): Promise<{
    attachment: {
      id: string;
      mimeType: string;
      sizeBytes: number;
    };
    stored: StoredObject;
  }> {
    const attachment = await this.database.client.incidentAttachment.findFirst({
      where: { id: attachmentId, incident: { reference } },
      select: {
        id: true,
        objectKey: true,
        mimeType: true,
        sizeBytes: true,
        incidentId: true,
      },
    });
    if (!attachment) throw IncidentErrors.attachmentNotFound();

    let stored: StoredObject;
    try {
      stored = await this.storage.get(attachment.objectKey);
    } catch {
      throw IncidentErrors.attachmentFeatureUnavailable();
    }
    if (stored.sizeBytes !== attachment.sizeBytes) {
      stored.body.destroy();
      throw IncidentErrors.attachmentFeatureUnavailable();
    }
    try {
      await this.auditAttachment(actor, attachment.incidentId, 'INCIDENT_ATTACHMENT_ACCESSED', {
        attachmentId: attachment.id,
        access: 'CONTENT',
      });
    } catch (error) {
      stored.body.destroy();
      throw error;
    }
    return {
      attachment: {
        id: attachment.id,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      },
      stored,
    };
  }

  async addAction(actor: AuthPrincipal, reference: string, input: ActionInput) {
    const incident = await this.database.client.incident.findUnique({
      where: { reference },
      select: { id: true },
    });
    if (!incident) throw IncidentErrors.notFound();
    const fingerprint = stableFingerprint([input.type, input.content]);

    try {
      return await this.database.client.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
          SELECT "id", "status"::text AS "status" FROM "incident"
          WHERE "id" = ${incident.id}::uuid FOR UPDATE
        `;
        if (!locked[0]) throw IncidentErrors.notFound();
        if (locked[0].status === 'CLOSED') throw IncidentErrors.closed();

        const existing = await tx.incidentAction.findUnique({
          where: {
            incidentId_clientActionId: {
              incidentId: incident.id,
              clientActionId: input.clientActionId,
            },
          },
          select: { payloadFingerprint: true, ...actionSelect },
        });
        if (existing) {
          if (existing.payloadFingerprint !== fingerprint)
            throw IncidentErrors.actionIdempotencyConflict();
          const { payloadFingerprint: _fingerprint, ...view } = existing;
          return { created: false, action: view };
        }

        const latest = await tx.incidentAction.findFirst({
          where: { incidentId: incident.id },
          orderBy: { sequence: 'desc' },
          select: { sequence: true },
        });
        const row = await tx.incidentAction.create({
          data: {
            incidentId: incident.id,
            sequence: (latest?.sequence ?? 0) + 1,
            type: input.type,
            content: input.content,
            clientActionId: input.clientActionId,
            payloadFingerprint: fingerprint,
            createdByIdentityId: actor.identityId,
          },
          select: actionSelect,
        });
        await this.audit.record(
          {
            actor,
            action: 'INCIDENT_ACTION_ADDED',
            resourceType: 'incident',
            resourceId: incident.id,
            after: { reference, sequence: row.sequence, type: row.type },
          },
          tx,
        );
        return { created: true, action: row };
      });
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      if (uniqueViolation(error)) {
        const replay = await this.database.client.incidentAction.findUnique({
          where: {
            incidentId_clientActionId: {
              incidentId: incident.id,
              clientActionId: input.clientActionId,
            },
          },
          select: { payloadFingerprint: true, ...actionSelect },
        });
        if (replay?.payloadFingerprint === fingerprint) {
          const { payloadFingerprint: _fingerprint, ...view } = replay;
          return { created: false, action: view };
        }
        throw IncidentErrors.actionIdempotencyConflict();
      }
      mapDatabaseViolation(error);
    }
  }

  async transition(actor: AuthPrincipal, reference: string, input: TransitionInput) {
    const current = await this.database.client.incident.findUnique({
      where: { reference },
      select: { id: true, status: true },
    });
    if (!current) throw IncidentErrors.notFound();
    if (input.expectedStatus && current.status !== input.expectedStatus) {
      throw IncidentErrors.expectedStatusMismatch();
    }
    if (current.status === input.status) return this.detail(reference);

    try {
      return await this.database.client.$transaction(async (tx) => {
        const row = await tx.incident.update({
          where: { id: current.id },
          data: { status: input.status },
          select: summarySelect,
        });
        await this.audit.record(
          {
            actor,
            action: 'INCIDENT_STATUS_CHANGED',
            resourceType: 'incident',
            resourceId: row.id,
            before: { status: current.status },
            after: { status: row.status, reference: row.reference },
          },
          tx,
        );
        return summaryView(row);
      });
    } catch (error) {
      mapDatabaseViolation(error);
    }
  }

  async assignOwner(actor: AuthPrincipal, reference: string, input: OwnerInput) {
    const current = await this.database.client.incident.findUnique({
      where: { reference },
      select: { id: true, ownerIdentityId: true, status: true },
    });
    if (!current) throw IncidentErrors.notFound();
    if (current.status === 'CLOSED') throw IncidentErrors.closed();
    try {
      return await this.database.client.$transaction(async (tx) => {
        const row = await tx.incident.update({
          where: { id: current.id },
          data: { ownerIdentityId: input.ownerIdentityId },
          select: summarySelect,
        });
        await this.audit.record(
          {
            actor,
            action: 'INCIDENT_OWNER_CHANGED',
            resourceType: 'incident',
            resourceId: row.id,
            before: { ownerIdentityId: current.ownerIdentityId },
            after: {
              ownerIdentityId: row.ownerIdentityId,
              reference: row.reference,
            },
          },
          tx,
        );
        return summaryView(row);
      });
    } catch (error) {
      mapDatabaseViolation(error);
    }
  }

  private async auditAttachment(
    actor: AuthPrincipal,
    incidentId: string,
    action: string,
    metadata: Record<string, unknown>,
  ) {
    await this.database.client.$transaction((tx) =>
      this.audit.record(
        {
          actor,
          action,
          resourceType: 'incident',
          resourceId: incidentId,
          metadata,
        },
        tx,
      ),
    );
  }

  private async deleteAttachmentBestEffort(objectKey: string) {
    await this.storage.delete(objectKey).catch(() => undefined);
  }
}
