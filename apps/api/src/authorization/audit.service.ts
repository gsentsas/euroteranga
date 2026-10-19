import { Prisma, type DatabaseTransaction } from '@euroteranga/database';
import { redact } from '@euroteranga/logger';
import { Injectable } from '@nestjs/common';
import { toDbRealm } from '../auth/auth.config.js';
import { isSystemActor, type Actor } from '../auth/session/auth-principal.js';
import { currentRequestId } from '../common/request-context.js';
import { DatabaseService } from '../database/database.service.js';

/**
 * Snapshots are redacted (sensitive keys such as password, token, secret,
 * cookie, authorization, csrf, otp... and credentials embedded in strings)
 * before they reach the append-only table.
 */
function safeJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(redact(value))) as Prisma.InputJsonValue;
}

/** Metadata as an object, so that a system actor's source can be added to it. */
function metadataObject(metadata: unknown): Record<string, unknown> {
  if (metadata === undefined) return {};
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }
  return { value: metadata };
}

export interface AuditRecordInput {
  /**
   * Omitted for anonymous system flows (bootstrap CLI, invitation acceptance).
   * A SystemActor is also stored without identity, with its source in the
   * metadata.
   */
  actor?: Actor | undefined;
  action: string;
  resourceType: string;
  resourceId?: string;
  /** Defaults to the current HTTP request id, when there is one. */
  requestId?: string;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
}

export interface AuditEventView {
  id: string;
  occurredAt: Date;
  actor: { id: string; email: string; realm: string } | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  requestId: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
}

/**
 * Writer and reader of the privileged audit trail. There is deliberately no
 * update or delete method, and the database rejects both (trigger).
 * `record` requires the caller's transaction: a privileged mutation and its
 * audit event commit together, or not at all.
 */
@Injectable()
export class AuditService {
  constructor(private readonly database: DatabaseService) {}

  async record(input: AuditRecordInput, tx: DatabaseTransaction): Promise<string> {
    const requestId = input.requestId ?? currentRequestId();
    const principal = input.actor && !isSystemActor(input.actor) ? input.actor : undefined;
    const metadata =
      input.actor && isSystemActor(input.actor)
        ? { ...metadataObject(input.metadata), systemActor: input.actor.source }
        : input.metadata;
    const event = await tx.auditEvent.create({
      data: {
        ...(principal
          ? {
              actorIdentityId: principal.identityId,
              actorRealm: toDbRealm(principal.realm),
              sessionId: principal.sessionId,
            }
          : {}),
        action: input.action,
        resourceType: input.resourceType,
        ...(input.resourceId ? { resourceId: input.resourceId } : {}),
        ...(requestId ? { requestId } : {}),
        ...(input.before !== undefined ? { before: safeJson(input.before) } : {}),
        ...(input.after !== undefined ? { after: safeJson(input.after) } : {}),
        ...(metadata !== undefined ? { metadata: safeJson(metadata) } : {}),
      },
      select: { id: true },
    });
    return event.id;
  }

  /** Newest first, keyset pagination on the time-ordered UUIDv7 id. */
  async list(options: {
    limit: number;
    cursor?: string | undefined;
  }): Promise<{ items: AuditEventView[]; nextCursor: string | null }> {
    const take = Math.min(Math.max(options.limit, 1), 100);
    const rows = await this.database.client.auditEvent.findMany({
      take: take + 1,
      ...(options.cursor ? { where: { id: { lt: options.cursor } } } : {}),
      orderBy: { id: 'desc' },
      select: {
        id: true,
        occurredAt: true,
        action: true,
        resourceType: true,
        resourceId: true,
        requestId: true,
        before: true,
        after: true,
        metadata: true,
        actor: { select: { id: true, email: true, realm: true } },
      },
    });
    const page = rows.slice(0, take);
    return {
      items: page.map(({ actor, ...row }) => ({
        ...row,
        actor: actor ? { id: actor.id, email: actor.email, realm: actor.realm } : null,
      })),
      nextCursor: rows.length > take ? (page.at(-1)?.id ?? null) : null,
    };
  }
}
