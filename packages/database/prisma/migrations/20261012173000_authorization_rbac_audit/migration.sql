-- PR-03 Authorization (RBAC), privileged audit trail and controlled STAFF
-- provisioning. Prisma-generated DDL first, then explicit SQL invariants,
-- triggers and the system catalogue (single source of truth for roles and
-- permissions). See ADR-017 to ADR-020.

-- AlterEnum
ALTER TYPE "auth_session_revocation_reason" ADD VALUE 'ADMIN_ACTION';

-- CreateTable
CREATE TABLE "authorization_permission" (
    "key" VARCHAR(96) NOT NULL,
    "description" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "authorization_permission_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "authorization_role" (
    "key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(96) NOT NULL,
    "description" VARCHAR(255) NOT NULL,
    "realm" "auth_realm" NOT NULL,
    "privileged" BOOLEAN NOT NULL DEFAULT false,
    "system" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "authorization_role_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "authorization_role_permission" (
    "role_key" VARCHAR(64) NOT NULL,
    "permission_key" VARCHAR(96) NOT NULL,

    CONSTRAINT "authorization_role_permission_pkey" PRIMARY KEY ("role_key","permission_key")
);

-- CreateTable
CREATE TABLE "authorization_role_assignment" (
    "id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "role_key" VARCHAR(64) NOT NULL,
    "granted_by_identity_id" UUID,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grant_reason" VARCHAR(255),
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_identity_id" UUID,
    "revocation_reason" VARCHAR(255),

    CONSTRAINT "authorization_role_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_identity_id" UUID,
    "actor_realm" "auth_realm",
    "action" VARCHAR(96) NOT NULL,
    "resource_type" VARCHAR(64) NOT NULL,
    "resource_id" VARCHAR(128),
    "session_id" UUID,
    "request_id" VARCHAR(128),
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_invitation" (
    "id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "invalidated_at" TIMESTAMPTZ(3),
    "created_by_identity_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_enrollment_grant" (
    "identity_id" UUID NOT NULL,
    "issued_by_identity_id" UUID,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),

    CONSTRAINT "staff_enrollment_grant_pkey" PRIMARY KEY ("identity_id")
);

-- CreateIndex
CREATE INDEX "authorization_role_assignment_identity_id_revoked_at_idx" ON "authorization_role_assignment"("identity_id", "revoked_at");

-- CreateIndex
CREATE INDEX "authorization_role_assignment_role_key_revoked_at_idx" ON "authorization_role_assignment"("role_key", "revoked_at");

-- CreateIndex
CREATE INDEX "audit_event_occurred_at_idx" ON "audit_event"("occurred_at");

-- CreateIndex
CREATE INDEX "audit_event_actor_identity_id_occurred_at_idx" ON "audit_event"("actor_identity_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_event_resource_type_resource_id_occurred_at_idx" ON "audit_event"("resource_type", "resource_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "staff_invitation_token_hash_key" ON "staff_invitation"("token_hash");

-- CreateIndex
CREATE INDEX "staff_invitation_identity_id_idx" ON "staff_invitation"("identity_id");

-- CreateIndex
CREATE INDEX "staff_invitation_expires_at_idx" ON "staff_invitation"("expires_at");

-- CreateIndex
CREATE INDEX "staff_enrollment_grant_expires_at_idx" ON "staff_enrollment_grant"("expires_at");

-- AddForeignKey
ALTER TABLE "authorization_role_permission" ADD CONSTRAINT "authorization_role_permission_role_key_fkey" FOREIGN KEY ("role_key") REFERENCES "authorization_role"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authorization_role_permission" ADD CONSTRAINT "authorization_role_permission_permission_key_fkey" FOREIGN KEY ("permission_key") REFERENCES "authorization_permission"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authorization_role_assignment" ADD CONSTRAINT "authorization_role_assignment_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authorization_role_assignment" ADD CONSTRAINT "authorization_role_assignment_role_key_fkey" FOREIGN KEY ("role_key") REFERENCES "authorization_role"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authorization_role_assignment" ADD CONSTRAINT "authorization_role_assignment_granted_by_identity_id_fkey" FOREIGN KEY ("granted_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authorization_role_assignment" ADD CONSTRAINT "authorization_role_assignment_revoked_by_identity_id_fkey" FOREIGN KEY ("revoked_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_identity_id_fkey" FOREIGN KEY ("actor_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_invitation" ADD CONSTRAINT "staff_invitation_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "auth_identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_invitation" ADD CONSTRAINT "staff_invitation_created_by_identity_id_fkey" FOREIGN KEY ("created_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_enrollment_grant" ADD CONSTRAINT "staff_enrollment_grant_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "auth_identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_enrollment_grant" ADD CONSTRAINT "staff_enrollment_grant_issued_by_identity_id_fkey" FOREIGN KEY ("issued_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Explicit invariants
-- ---------------------------------------------------------------------------

ALTER TABLE "authorization_permission" ADD CONSTRAINT "authorization_permission_key_format"
  CHECK ("key" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$');
ALTER TABLE "authorization_role" ADD CONSTRAINT "authorization_role_key_format"
  CHECK ("key" ~ '^[A-Z][A-Z0-9_]*$');
-- Privileged roles belong to the STAFF realm.
ALTER TABLE "authorization_role" ADD CONSTRAINT "authorization_role_privileged_staff"
  CHECK (NOT "privileged" OR "realm" = 'STAFF');

-- A revocation records when; "who" and "why" only exist on revoked rows.
ALTER TABLE "authorization_role_assignment" ADD CONSTRAINT "authorization_role_assignment_revocation_consistent"
  CHECK ("revoked_at" IS NOT NULL OR ("revoked_by_identity_id" IS NULL AND "revocation_reason" IS NULL));
ALTER TABLE "authorization_role_assignment" ADD CONSTRAINT "authorization_role_assignment_revoked_after_grant"
  CHECK ("revoked_at" IS NULL OR "revoked_at" >= "granted_at");
-- At most one active assignment of a role per identity (concurrent grants:
-- exactly one succeeds).
CREATE UNIQUE INDEX "authorization_role_assignment_one_active"
  ON "authorization_role_assignment" ("identity_id", "role_key") WHERE "revoked_at" IS NULL;

ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_action_format"
  CHECK ("action" ~ '^[A-Z][A-Z0-9_]*$');
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_consistent"
  CHECK (("actor_identity_id" IS NULL) = ("actor_realm" IS NULL));

ALTER TABLE "staff_invitation" ADD CONSTRAINT "staff_invitation_token_hash_len"
  CHECK (octet_length("token_hash") = 32);
ALTER TABLE "staff_invitation" ADD CONSTRAINT "staff_invitation_expiry_after_creation"
  CHECK ("expires_at" > "created_at");
-- At most one usable invitation per identity: re-inviting supersedes.
CREATE UNIQUE INDEX "staff_invitation_one_active_per_identity"
  ON "staff_invitation" ("identity_id") WHERE "consumed_at" IS NULL AND "invalidated_at" IS NULL;

ALTER TABLE "staff_enrollment_grant" ADD CONSTRAINT "staff_enrollment_grant_expiry_after_issue"
  CHECK ("expires_at" > "issued_at");

-- A role can only be held by identities of its realm (CUSTOMER + SUPER_ADMIN,
-- STAFF + DRIVER, CREW + DIRECTOR... are rejected by the database itself).
CREATE FUNCTION "authorization_role_assignment_realm_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "auth_identity" i
    JOIN "authorization_role" r ON r."key" = NEW."role_key"
    WHERE i."id" = NEW."identity_id" AND i."realm" = r."realm"
  ) THEN
    RAISE EXCEPTION 'role % cannot be assigned to an identity of another realm', NEW."role_key"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "authorization_role_assignment_realm_check"
  BEFORE INSERT OR UPDATE OF "identity_id", "role_key" ON "authorization_role_assignment"
  FOR EACH ROW EXECUTE FUNCTION "authorization_role_assignment_realm_check"();

-- Append-only audit trail: no UPDATE, DELETE or TRUNCATE, whatever the role.
-- A deliberate data migration must disable the trigger explicitly (owner
-- only) and document why; schema changes (ALTER TABLE) are not affected.
CREATE FUNCTION "audit_event_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only (% rejected)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER "audit_event_no_update_delete"
  BEFORE UPDATE OR DELETE ON "audit_event"
  FOR EACH ROW EXECUTE FUNCTION "audit_event_append_only"();
CREATE TRIGGER "audit_event_no_truncate"
  BEFORE TRUNCATE ON "audit_event"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_event_append_only"();

-- ---------------------------------------------------------------------------
-- System catalogue (documented in docs/security/authorization.md)
-- Later migrations that add permissions must grant them explicitly; nothing
-- is granted implicitly (no wildcard, not even for SUPER_ADMIN).
-- ---------------------------------------------------------------------------

INSERT INTO "authorization_permission" ("key", "description") VALUES
  ('ops.access', 'Open the operations back-office (OPS)'),
  ('identity.read', 'List STAFF and CREW identities with their status, roles and MFA state'),
  ('identity.staff.provision', 'Invite and provision STAFF identities'),
  ('identity.status.manage', 'Suspend, disable or reactivate identities'),
  ('role.read', 'Read roles and effective permissions'),
  ('role.assign', 'Grant or revoke roles (within the permissions held by the actor)'),
  ('privileged.manage', 'Grant/revoke privileged roles and act on identities holding them'),
  ('audit.read', 'Read the privileged audit trail'),
  ('session.revoke.any', 'Revoke every session of another identity'),
  ('mfa.enrollment.authorize', 'Authorize first-time STAFF MFA enrollment');

INSERT INTO "authorization_role" ("key", "name", "description", "realm", "privileged", "system", "updated_at") VALUES
  ('SUPER_ADMIN', 'Super administrateur', 'Full platform administration, including privileged roles', 'STAFF', true, true, CURRENT_TIMESTAMP),
  ('DIRECTOR', 'Direction', 'Administration of staff, roles and audit (no privileged roles)', 'STAFF', false, true, CURRENT_TIMESTAMP),
  ('OPS_MANAGER', 'Responsable opérations', 'Operations management', 'STAFF', false, true, CURRENT_TIMESTAMP),
  ('DISPATCHER', 'Dispatcher', 'Dispatch operations', 'STAFF', false, true, CURRENT_TIMESTAMP),
  ('BOOKING_AGENT', 'Agent réservation', 'Booking operations', 'STAFF', false, true, CURRENT_TIMESTAMP),
  ('COMPLIANCE_AGENT', 'Agent conformité', 'Compliance operations', 'STAFF', false, true, CURRENT_TIMESTAMP),
  ('FINANCE', 'Finance', 'Finance operations', 'STAFF', false, true, CURRENT_TIMESTAMP),
  ('CUSTOMER_SUPPORT', 'Support client', 'Customer support operations', 'STAFF', false, true, CURRENT_TIMESTAMP),
  ('AUDITOR', 'Auditeur', 'Read-only access to staff, roles and the audit trail', 'STAFF', false, true, CURRENT_TIMESTAMP),
  ('DRIVER', 'Conducteur', 'Driver (crew application)', 'CREW', false, true, CURRENT_TIMESTAMP),
  ('CREW', 'Équipage', 'On-board crew (crew application)', 'CREW', false, true, CURRENT_TIMESTAMP);

INSERT INTO "authorization_role_permission" ("role_key", "permission_key") VALUES
  ('SUPER_ADMIN', 'ops.access'),
  ('SUPER_ADMIN', 'identity.read'),
  ('SUPER_ADMIN', 'identity.staff.provision'),
  ('SUPER_ADMIN', 'identity.status.manage'),
  ('SUPER_ADMIN', 'role.read'),
  ('SUPER_ADMIN', 'role.assign'),
  ('SUPER_ADMIN', 'privileged.manage'),
  ('SUPER_ADMIN', 'audit.read'),
  ('SUPER_ADMIN', 'session.revoke.any'),
  ('SUPER_ADMIN', 'mfa.enrollment.authorize'),
  ('DIRECTOR', 'ops.access'),
  ('DIRECTOR', 'identity.read'),
  ('DIRECTOR', 'identity.staff.provision'),
  ('DIRECTOR', 'identity.status.manage'),
  ('DIRECTOR', 'role.read'),
  ('DIRECTOR', 'role.assign'),
  ('DIRECTOR', 'audit.read'),
  ('DIRECTOR', 'session.revoke.any'),
  ('DIRECTOR', 'mfa.enrollment.authorize'),
  ('OPS_MANAGER', 'ops.access'),
  ('OPS_MANAGER', 'identity.read'),
  ('OPS_MANAGER', 'role.read'),
  ('DISPATCHER', 'ops.access'),
  ('BOOKING_AGENT', 'ops.access'),
  ('COMPLIANCE_AGENT', 'ops.access'),
  ('FINANCE', 'ops.access'),
  ('CUSTOMER_SUPPORT', 'ops.access'),
  ('AUDITOR', 'ops.access'),
  ('AUDITOR', 'identity.read'),
  ('AUDITOR', 'role.read'),
  ('AUDITOR', 'audit.read');
