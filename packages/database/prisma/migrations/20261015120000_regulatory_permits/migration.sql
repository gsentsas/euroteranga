-- PR-16 Regulatory Permits. Generic operational authorizations only: this
-- migration ships no real permit type, corridor rule or readiness decision.

CREATE TYPE "regulatory_permit_status" AS ENUM ('DRAFT', 'ACTIVE', 'REVOKED');
CREATE TYPE "regulatory_permit_scope_type" AS ENUM (
  'OPERATOR', 'COUNTRY', 'VEHICLE', 'ROUTE_VERSION', 'TRIP'
);

CREATE TABLE "regulatory_permit" (
  "id" UUID NOT NULL,
  "reference" VARCHAR(17) NOT NULL,
  "permit_type" VARCHAR(64) NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "issuing_authority" VARCHAR(200) NOT NULL,
  "authority_reference" VARCHAR(200),
  "jurisdiction_country_id" UUID,
  "valid_from" DATE NOT NULL,
  "valid_until" DATE NOT NULL,
  "status" "regulatory_permit_status" NOT NULL DEFAULT 'DRAFT',
  "scope_type" "regulatory_permit_scope_type" NOT NULL,
  "scope_country_id" UUID,
  "vehicle_id" UUID,
  "route_version_id" UUID,
  "trip_id" UUID,
  "source_url" VARCHAR(500),
  "source_checked_on" DATE,
  "notes" VARCHAR(1000),
  "revision" INTEGER NOT NULL DEFAULT 1,
  "created_by_identity_id" UUID NOT NULL,
  "updated_by_identity_id" UUID NOT NULL,
  "activated_at" TIMESTAMPTZ(3),
  "activated_by_identity_id" UUID,
  "revoked_at" TIMESTAMPTZ(3),
  "revoked_by_identity_id" UUID,
  "revocation_reason" VARCHAR(500),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "regulatory_permit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "regulatory_permit_reference_key"
  ON "regulatory_permit"("reference");

-- A legal identity can only be asserted when an official reference exists.
-- This rejects only a strictly identical permit identity/scope and avoids
-- inventing global uniqueness for authorities that issue no reference.
CREATE UNIQUE INDEX "regulatory_permit_logical_identity_key"
  ON "regulatory_permit"(
    "permit_type",
    lower("issuing_authority"),
    lower("authority_reference"),
    "jurisdiction_country_id",
    "scope_type",
    "scope_country_id",
    "vehicle_id",
    "route_version_id",
    "trip_id"
  ) NULLS NOT DISTINCT
  WHERE "authority_reference" IS NOT NULL;

CREATE INDEX "regulatory_permit_status_id_idx"
  ON "regulatory_permit"("status", "id");
CREATE INDEX "regulatory_permit_permit_type_id_idx"
  ON "regulatory_permit"("permit_type", "id");
CREATE INDEX "regulatory_permit_jurisdiction_country_id_id_idx"
  ON "regulatory_permit"("jurisdiction_country_id", "id");
CREATE INDEX "regulatory_permit_scope_country_id_status_id_idx"
  ON "regulatory_permit"("scope_country_id", "status", "id");
CREATE INDEX "regulatory_permit_vehicle_id_status_id_idx"
  ON "regulatory_permit"("vehicle_id", "status", "id");
CREATE INDEX "regulatory_permit_route_version_id_status_id_idx"
  ON "regulatory_permit"("route_version_id", "status", "id");
CREATE INDEX "regulatory_permit_trip_id_status_id_idx"
  ON "regulatory_permit"("trip_id", "status", "id");
CREATE INDEX "regulatory_permit_created_by_identity_id_idx"
  ON "regulatory_permit"("created_by_identity_id");
CREATE INDEX "regulatory_permit_updated_by_identity_id_idx"
  ON "regulatory_permit"("updated_by_identity_id");
CREATE INDEX "regulatory_permit_activated_by_identity_id_idx"
  ON "regulatory_permit"("activated_by_identity_id");
CREATE INDEX "regulatory_permit_revoked_by_identity_id_idx"
  ON "regulatory_permit"("revoked_by_identity_id");

ALTER TABLE "regulatory_permit" ADD CONSTRAINT "regulatory_permit_jurisdiction_country_id_fkey"
  FOREIGN KEY ("jurisdiction_country_id") REFERENCES "country"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "regulatory_permit" ADD CONSTRAINT "regulatory_permit_scope_country_id_fkey"
  FOREIGN KEY ("scope_country_id") REFERENCES "country"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "regulatory_permit" ADD CONSTRAINT "regulatory_permit_vehicle_id_fkey"
  FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "regulatory_permit" ADD CONSTRAINT "regulatory_permit_route_version_id_fkey"
  FOREIGN KEY ("route_version_id") REFERENCES "route_version"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "regulatory_permit" ADD CONSTRAINT "regulatory_permit_trip_id_fkey"
  FOREIGN KEY ("trip_id") REFERENCES "trip"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "regulatory_permit" ADD CONSTRAINT "regulatory_permit_created_by_identity_id_fkey"
  FOREIGN KEY ("created_by_identity_id") REFERENCES "auth_identity"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "regulatory_permit" ADD CONSTRAINT "regulatory_permit_updated_by_identity_id_fkey"
  FOREIGN KEY ("updated_by_identity_id") REFERENCES "auth_identity"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "regulatory_permit" ADD CONSTRAINT "regulatory_permit_activated_by_identity_id_fkey"
  FOREIGN KEY ("activated_by_identity_id") REFERENCES "auth_identity"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "regulatory_permit" ADD CONSTRAINT "regulatory_permit_revoked_by_identity_id_fkey"
  FOREIGN KEY ("revoked_by_identity_id") REFERENCES "auth_identity"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "regulatory_permit" ADD CONSTRAINT "regulatory_permit_reference_format"
  CHECK ("reference" ~ '^ETRP-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$');
ALTER TABLE "regulatory_permit" ADD CONSTRAINT "regulatory_permit_type_format"
  CHECK ("permit_type" ~ '^[A-Z][A-Z0-9_.-]{1,63}$');
ALTER TABLE "regulatory_permit" ADD CONSTRAINT "regulatory_permit_text_format"
  CHECK (
    "title" = btrim("title") AND "title" <> '' AND
    "issuing_authority" = btrim("issuing_authority") AND "issuing_authority" <> '' AND
    ("authority_reference" IS NULL OR (
      "authority_reference" = btrim("authority_reference") AND "authority_reference" <> ''
    )) AND
    ("notes" IS NULL OR ("notes" = btrim("notes") AND "notes" <> ''))
  );
ALTER TABLE "regulatory_permit" ADD CONSTRAINT "regulatory_permit_dates_ordered"
  CHECK ("valid_until" >= "valid_from");
ALTER TABLE "regulatory_permit" ADD CONSTRAINT "regulatory_permit_source_url_https"
  CHECK ("source_url" IS NULL OR (
    "source_url" = btrim("source_url") AND "source_url" ~ '^https://[^[:space:]]+$'
  ));
ALTER TABLE "regulatory_permit" ADD CONSTRAINT "regulatory_permit_revision_positive"
  CHECK ("revision" > 0);
ALTER TABLE "regulatory_permit" ADD CONSTRAINT "regulatory_permit_scope_coherent"
  CHECK (
    ("scope_type" = 'OPERATOR' AND "scope_country_id" IS NULL AND "vehicle_id" IS NULL AND "route_version_id" IS NULL AND "trip_id" IS NULL) OR
    ("scope_type" = 'COUNTRY' AND "scope_country_id" IS NOT NULL AND "vehicle_id" IS NULL AND "route_version_id" IS NULL AND "trip_id" IS NULL) OR
    ("scope_type" = 'VEHICLE' AND "scope_country_id" IS NULL AND "vehicle_id" IS NOT NULL AND "route_version_id" IS NULL AND "trip_id" IS NULL) OR
    ("scope_type" = 'ROUTE_VERSION' AND "scope_country_id" IS NULL AND "vehicle_id" IS NULL AND "route_version_id" IS NOT NULL AND "trip_id" IS NULL) OR
    ("scope_type" = 'TRIP' AND "scope_country_id" IS NULL AND "vehicle_id" IS NULL AND "route_version_id" IS NULL AND "trip_id" IS NOT NULL)
  );
ALTER TABLE "regulatory_permit" ADD CONSTRAINT "regulatory_permit_lifecycle_coherent"
  CHECK (
    ("status" = 'DRAFT' AND "activated_at" IS NULL AND "activated_by_identity_id" IS NULL AND "revoked_at" IS NULL AND "revoked_by_identity_id" IS NULL AND "revocation_reason" IS NULL) OR
    ("status" = 'ACTIVE' AND "activated_at" IS NOT NULL AND "activated_by_identity_id" IS NOT NULL AND "revoked_at" IS NULL AND "revoked_by_identity_id" IS NULL AND "revocation_reason" IS NULL) OR
    ("status" = 'REVOKED' AND "activated_at" IS NOT NULL AND "activated_by_identity_id" IS NOT NULL AND "revoked_at" IS NOT NULL AND "revoked_by_identity_id" IS NOT NULL AND "revocation_reason" IS NOT NULL AND "revocation_reason" = btrim("revocation_reason") AND length("revocation_reason") BETWEEN 10 AND 500)
  );
ALTER TABLE "regulatory_permit" ADD CONSTRAINT "regulatory_permit_lifecycle_chronology"
  CHECK (
    ("activated_at" IS NULL OR "activated_at" >= "created_at") AND
    ("revoked_at" IS NULL OR "revoked_at" >= "activated_at")
  );

CREATE FUNCTION "regulatory_permit_assert_active_staff"(identity UUID, field_name TEXT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  actor_realm "auth_realm";
  actor_status "auth_identity_status";
BEGIN
  SELECT "realm", "status" INTO actor_realm, actor_status
  FROM "auth_identity" WHERE "id" = identity FOR SHARE;
  IF NOT FOUND THEN
    RETURN; -- the foreign key reports the unknown actor
  END IF;
  IF actor_realm <> 'STAFF' OR actor_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'regulatory permit % must be active STAFF', field_name
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE FUNCTION "regulatory_permit_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  content_changed BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'regulatory permits cannot be deleted'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF NEW."source_checked_on" IS NOT NULL AND NEW."source_checked_on" > CURRENT_DATE THEN
    RAISE EXCEPTION 'regulatory permit source check cannot be in the future'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."revision" <> 1 THEN
      RAISE EXCEPTION 'regulatory permits must be created as revision 1 drafts'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."created_by_identity_id" IS DISTINCT FROM NEW."updated_by_identity_id" THEN
      RAISE EXCEPTION 'regulatory permit creator must be the initial updater'
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM "regulatory_permit_assert_active_staff"(NEW."created_by_identity_id", 'creator');
    NEW."created_at" := clock_timestamp();
    NEW."updated_at" := NEW."created_at";
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."reference" IS DISTINCT FROM OLD."reference"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR NEW."created_by_identity_id" IS DISTINCT FROM OLD."created_by_identity_id" THEN
    RAISE EXCEPTION 'regulatory permit identity is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'regulatory permit revision must increase by exactly one'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'REVOKED' THEN
    RAISE EXCEPTION 'revoked regulatory permits are immutable'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  PERFORM "regulatory_permit_assert_active_staff"(NEW."updated_by_identity_id", 'updater');
  NEW."updated_at" := clock_timestamp();

  content_changed := (
    NEW."permit_type", NEW."title", NEW."issuing_authority", NEW."authority_reference",
    NEW."jurisdiction_country_id", NEW."valid_from", NEW."valid_until", NEW."scope_type",
    NEW."scope_country_id", NEW."vehicle_id", NEW."route_version_id", NEW."trip_id",
    NEW."source_url", NEW."source_checked_on", NEW."notes"
  ) IS DISTINCT FROM (
    OLD."permit_type", OLD."title", OLD."issuing_authority", OLD."authority_reference",
    OLD."jurisdiction_country_id", OLD."valid_from", OLD."valid_until", OLD."scope_type",
    OLD."scope_country_id", OLD."vehicle_id", OLD."route_version_id", OLD."trip_id",
    OLD."source_url", OLD."source_checked_on", OLD."notes"
  );

  IF OLD."status" = 'DRAFT' AND NEW."status" = 'DRAFT' THEN
    RETURN NEW;
  END IF;

  IF OLD."status" = 'DRAFT' AND NEW."status" = 'ACTIVE' THEN
    IF content_changed
       OR NEW."activated_by_identity_id" IS NULL
       OR NEW."updated_by_identity_id" IS DISTINCT FROM NEW."activated_by_identity_id" THEN
      RAISE EXCEPTION 'activation cannot change regulatory permit content'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    PERFORM "regulatory_permit_assert_active_staff"(NEW."activated_by_identity_id", 'activator');
    NEW."activated_at" := clock_timestamp();
    RETURN NEW;
  END IF;

  IF OLD."status" = 'ACTIVE' AND NEW."status" = 'REVOKED' THEN
    IF content_changed
       OR NEW."activated_at" IS DISTINCT FROM OLD."activated_at"
       OR NEW."activated_by_identity_id" IS DISTINCT FROM OLD."activated_by_identity_id"
       OR NEW."revoked_by_identity_id" IS NULL
       OR NEW."updated_by_identity_id" IS DISTINCT FROM NEW."revoked_by_identity_id"
       OR NEW."revocation_reason" IS NULL
       OR length(btrim(NEW."revocation_reason")) NOT BETWEEN 10 AND 500 THEN
      RAISE EXCEPTION 'revocation requires an unchanged active permit and a reason'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    PERFORM "regulatory_permit_assert_active_staff"(NEW."revoked_by_identity_id", 'revoker');
    NEW."revoked_at" := clock_timestamp();
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid regulatory permit lifecycle transition'
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;

CREATE TRIGGER "regulatory_permit_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "regulatory_permit"
  FOR EACH ROW EXECUTE FUNCTION "regulatory_permit_guard"();

CREATE FUNCTION "regulatory_permit_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'regulatory permits cannot be truncated'
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;

CREATE TRIGGER "regulatory_permit_no_truncate"
  BEFORE TRUNCATE ON "regulatory_permit"
  FOR EACH STATEMENT EXECUTE FUNCTION "regulatory_permit_no_truncate"();

INSERT INTO "authorization_permission" ("key", "description") VALUES
  ('permit.read', 'Read operational regulatory permits and intrinsic validity'),
  ('permit.manage', 'Create, edit, activate and revoke operational regulatory permits');

INSERT INTO "authorization_role_permission" ("role_key", "permission_key") VALUES
  ('SUPER_ADMIN', 'permit.read'),
  ('SUPER_ADMIN', 'permit.manage'),
  ('DIRECTOR', 'permit.read'),
  ('DIRECTOR', 'permit.manage'),
  ('OPS_MANAGER', 'permit.read'),
  ('OPS_MANAGER', 'permit.manage'),
  ('DISPATCHER', 'permit.read'),
  ('COMPLIANCE_AGENT', 'permit.read'),
  ('AUDITOR', 'permit.read');
