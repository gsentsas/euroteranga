import { Prisma, type DatabaseTransaction } from '@euroteranga/database';
import { redact } from '@euroteranga/logger';
import { Injectable } from '@nestjs/common';
import { toDbRealm } from '../auth/auth.config.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { DatabaseService } from '../database/database.service.js';

function safeJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(redact(value))) as Prisma.InputJsonValue;
}

export interface AuditRecordInput {
  actor?: AuthPrincipal;
  action: string;
  resourceType: string;
  resourceId?: string;
  requestId?: string;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
}

type AuditClient = DatabaseTransaction | DatabaseService['client'];

/**
 * Append-only privileged audit writer. There are deliberately no update or
 * delete methods. Callers pass controlled before/after snapshots, which are
 * redacted again before persistence.
 */
@Injectable()
export class AuditService {
  constructor(private readonly database: DatabaseService) {}

  async record(input: AuditRecordInput, tx?: AuditClient): Promise<string> {
    const client = tx ?? this.database.client;
    const event = await client.auditEvent.create({
      data: {
        ...(input.actor
          ? {
              actorIdentityId: input.actor.identityId,
              actorRealm: toDbRealm(input.actor.realm),
              sessionId: input.actor.sessionId,
            }
          : {}),
        action: input.action,
        resourceType: input.resourceType,
        ...(input.resourceId ? { resourceId: input.resourceId } : {}),
        ...(input.requestId ? { requestId: input.requestId } : {}),
        ...(input.before !== undefined ? { before: safeJson(input.before) } : {}),
        ...(input.after !== undefined ? { after: safeJson(input.after) } : {}),
        ...(input.metadata !== undefined ? { metadata: safeJson(input.metadata) } : {}),
      },
      select: { id: true },
    });
    return event.id;
  }

  async list(limit = 50) {
    const take = Math.min(Math.max(limit, 1), 100);
    return this.database.client.auditEvent.findMany({
      take,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        occurredAt: true,
        actorIdentityId: true,
        actorRealm: true,
        action: true,
        resourceType: true,
        resourceId: true,
        sessionId: true,
        requestId: true,
        before: true,
        after: true,
        metadata: true,
      },
    });
  }
}
