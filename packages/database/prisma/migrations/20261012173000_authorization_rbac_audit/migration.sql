-- PR-03 Authorization, audit and controlled STAFF provisioning.

CREATE TABLE "authorization_permission" (
  "key" VARCHAR(96) NOT NULL,
  "description" VARCHAR(255) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "authorization_permission_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "authorization_role" (
  "key" VARCHAR(64) NOT NULL,
  "name" VARCHAR(96) NOT NULL,
  "description" VARCHAR(255) NOT NULL,
  "system" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "authorization_role_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "authorization_role_permission" (
  "role_key" VARCHAR(64) NOT NULL,
  "permission_key" VARCHAR(96) NOT NULL,
  CONSTRAINT "authorization_role_permission_pkey" PRIMARY KEY ("role_key","permission_key")
);

CREATE TABLE "authorization_role_assignment" (
  "id" UUID NOT NULL,
  "identity_id" UUID NOT NULL,
  "role_key" VARCHAR(64) NOT NULL,
  "granted_by_identity_id" UUID,
  "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMPTZ(3),
  "revoked_by_identity_id" UUID,
  "reason" VARCHAR(255),
  CONSTRAINT "authorization_role_assignment_pkey" PRIMARY KEY ("id")
);

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

CREATE TABLE "staff_enrollment_grant" (
  "identity_id" UUID NOT NULL,
  "issued_by_identity_id" UUID,
  "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "consumed_at" TIMESTAMPTZ(3),
  CONSTRAINT "staff_enrollment_grant_pkey" PRIMARY KEY ("identity_id")
);

CREATE INDEX "authorization_role_assignment_identity_id_revoked_at_idx"
  ON "authorization_role_assignment"("identity_id","revoked_at");
CREATE INDEX "authorization_role_assignment_role_key_revoked_at_idx"
  ON "authorization_role_assignment"("role_key","revoked_at");
CREATE UNIQUE INDEX "authorization_role_assignment_one_active"
  ON "authorization_role_assignment"("identity_id","role_key") WHERE "revoked_at" IS NULL;

CREATE INDEX "audit_event_occurred_at_idx" ON "audit_event"("occurred_at");
CREATE INDEX "audit_event_actor_identity_id_occurred_at_idx"
  ON "audit_event"("actor_identity_id","occurred_at");
CREATE INDEX "audit_event_resource_type_resource_id_occurred_at_idx"
  ON "audit_event"("resource_type","resource_id","occurred_at");

CREATE UNIQUE INDEX "staff_invitation_token_hash_key" ON "staff_invitation"("token_hash");
CREATE INDEX "staff_invitation_identity_id_idx" ON "staff_invitation"("identity_id");
CREATE INDEX "staff_invitation_expires_at_idx" ON "staff_invitation"("expires_at");
CREATE INDEX "staff_enrollment_grant_expires_at_idx" ON "staff_enrollment_grant"("expires_at");

ALTER TABLE "authorization_role_permission"
  ADD CONSTRAINT "authorization_role_permission_role_key_fkey"
  FOREIGN KEY ("role_key") REFERENCES "authorization_role"("key") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "authorization_role_permission"
  ADD CONSTRAINT "authorization_role_permission_permission_key_fkey"
  FOREIGN KEY ("permission_key") REFERENCES "authorization_permission"("key") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "authorization_role_assignment"
  ADD CONSTRAINT "authorization_role_assignment_identity_id_fkey"
  FOREIGN KEY ("identity_id") REFERENCES "auth_identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "authorization_role_assignment"
  ADD CONSTRAINT "authorization_role_assignment_role_key_fkey"
  FOREIGN KEY ("role_key") REFERENCES "authorization_role"("key") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "authorization_role_assignment"
  ADD CONSTRAINT "authorization_role_assignment_granted_by_identity_id_fkey"
  FOREIGN KEY ("granted_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "authorization_role_assignment"
  ADD CONSTRAINT "authorization_role_assignment_revoked_by_identity_id_fkey"
  FOREIGN KEY ("revoked_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "audit_event"
  ADD CONSTRAINT "audit_event_actor_identity_id_fkey"
  FOREIGN KEY ("actor_identity_id") REFERENCES "auth_identity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "staff_invitation"
  ADD CONSTRAINT "staff_invitation_identity_id_fkey"
  FOREIGN KEY ("identity_id") REFERENCES "auth_identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_invitation"
  ADD CONSTRAINT "staff_invitation_created_by_identity_id_fkey"
  FOREIGN KEY ("created_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "staff_enrollment_grant"
  ADD CONSTRAINT "staff_enrollment_grant_identity_id_fkey"
  FOREIGN KEY ("identity_id") REFERENCES "auth_identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_enrollment_grant"
  ADD CONSTRAINT "staff_enrollment_grant_issued_by_identity_id_fkey"
  FOREIGN KEY ("issued_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "staff_invitation" ADD CONSTRAINT "staff_invitation_token_hash_len"
  CHECK (octet_length("token_hash") = 32);
ALTER TABLE "staff_invitation" ADD CONSTRAINT "staff_invitation_expiry_after_creation"
  CHECK ("expires_at" > "created_at");
ALTER TABLE "staff_enrollment_grant" ADD CONSTRAINT "staff_enrollment_grant_expiry_after_issue"
  CHECK ("expires_at" > "issued_at");
ALTER TABLE "authorization_role_assignment" ADD CONSTRAINT "authorization_role_assignment_revocation_consistent"
  CHECK (("revoked_at" IS NULL AND "revoked_by_identity_id" IS NULL) OR "revoked_at" IS NOT NULL);

INSERT INTO "authorization_permission" ("key","description") VALUES
  ('identity.read','Read authentication identities and staff status'),
  ('identity.staff.provision','Invite and provision STAFF identities'),
  ('identity.status.manage','Suspend, disable or reactivate identities'),
  ('role.read','Read roles and effective permissions'),
  ('role.assign','Grant or revoke roles'),
  ('audit.read','Read privileged audit events'),
  ('session.revoke.any','Revoke sessions belonging to another identity'),
  ('mfa.enrollment.authorize','Authorize first-time STAFF MFA enrollment');

INSERT INTO "authorization_role" ("key","name","description","system","updated_at") VALUES
  ('SUPER_ADMIN','Super administrateur','Full platform administration',true,CURRENT_TIMESTAMP),
  ('DIRECTOR','Direction','Executive administration',true,CURRENT_TIMESTAMP),
  ('OPS_MANAGER','Responsable opérations','Operations management',true,CURRENT_TIMESTAMP),
  ('DISPATCHER','Dispatcher','Dispatch operations',true,CURRENT_TIMESTAMP),
  ('BOOKING_AGENT','Agent réservation','Booking operations',true,CURRENT_TIMESTAMP),
  ('COMPLIANCE_AGENT','Agent conformité','Compliance operations',true,CURRENT_TIMESTAMP),
  ('FINANCE','Finance','Finance operations',true,CURRENT_TIMESTAMP),
  ('CUSTOMER_SUPPORT','Support client','Customer support operations',true,CURRENT_TIMESTAMP),
  ('DRIVER','Conducteur','Driver operations',true,CURRENT_TIMESTAMP),
  ('CREW','Équipage','Crew operations',true,CURRENT_TIMESTAMP),
  ('AUDITOR','Auditeur','Read-only audit access',true,CURRENT_TIMESTAMP);

INSERT INTO "authorization_role_permission" ("role_key","permission_key")
SELECT 'SUPER_ADMIN',"key" FROM "authorization_permission";

INSERT INTO "authorization_role_permission" ("role_key","permission_key") VALUES
  ('DIRECTOR','identity.read'),
  ('DIRECTOR','identity.staff.provision'),
  ('DIRECTOR','identity.status.manage'),
  ('DIRECTOR','role.read'),
  ('DIRECTOR','role.assign'),
  ('DIRECTOR','audit.read'),
  ('DIRECTOR','session.revoke.any'),
  ('DIRECTOR','mfa.enrollment.authorize'),
  ('OPS_MANAGER','identity.read'),
  ('OPS_MANAGER','role.read'),
  ('AUDITOR','identity.read'),
  ('AUDITOR','role.read'),
  ('AUDITOR','audit.read');
