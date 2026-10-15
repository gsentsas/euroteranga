-- PR-15 Manifests: immutable, versioned passenger snapshots for scheduled
-- trips. Additive only: existing PR-14 data is unchanged and no manifest is
-- backfilled. CSV exports are rendered on demand from the stored JSONB.

CREATE TABLE "passenger_manifest" (
  "id" UUID NOT NULL,
  "reference" VARCHAR(16) NOT NULL,
  "trip_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "schema_version" VARCHAR(32) NOT NULL,
  "content_hash" CHAR(64) NOT NULL,
  "passenger_count" INTEGER NOT NULL,
  "boarded_count" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "generated_by_identity_id" UUID NOT NULL,
  "generated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "passenger_manifest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "passenger_manifest_reference_key"
  ON "passenger_manifest"("reference");
CREATE UNIQUE INDEX "passenger_manifest_trip_id_version_key"
  ON "passenger_manifest"("trip_id", "version");
CREATE INDEX "passenger_manifest_generated_at_id_idx"
  ON "passenger_manifest"("generated_at", "id");
CREATE INDEX "passenger_manifest_generated_by_identity_id_idx"
  ON "passenger_manifest"("generated_by_identity_id");

ALTER TABLE "passenger_manifest" ADD CONSTRAINT "passenger_manifest_trip_id_fkey"
  FOREIGN KEY ("trip_id") REFERENCES "trip"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "passenger_manifest" ADD CONSTRAINT "passenger_manifest_generated_by_identity_id_fkey"
  FOREIGN KEY ("generated_by_identity_id") REFERENCES "auth_identity"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "passenger_manifest" ADD CONSTRAINT "passenger_manifest_reference_format"
  CHECK ("reference" ~ '^ETM-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$');
ALTER TABLE "passenger_manifest" ADD CONSTRAINT "passenger_manifest_schema_version_format"
  CHECK ("schema_version" ~ '^passenger-manifest/[1-9][0-9]*$');
ALTER TABLE "passenger_manifest" ADD CONSTRAINT "passenger_manifest_content_hash_format"
  CHECK ("content_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "passenger_manifest" ADD CONSTRAINT "passenger_manifest_version_positive"
  CHECK ("version" > 0);
ALTER TABLE "passenger_manifest" ADD CONSTRAINT "passenger_manifest_passenger_count_nonnegative"
  CHECK ("passenger_count" >= 0);
ALTER TABLE "passenger_manifest" ADD CONSTRAINT "passenger_manifest_boarded_count_valid"
  CHECK ("boarded_count" >= 0 AND "boarded_count" <= "passenger_count");
ALTER TABLE "passenger_manifest" ADD CONSTRAINT "passenger_manifest_snapshot_object"
  CHECK (jsonb_typeof("snapshot") = 'object');

-- The trip row is the serialization lock for every version of its manifest.
-- The trigger also protects direct SQL: only ACTIVE STAFF may generate, the
-- trip must remain SCHEDULED and the next version is exactly contiguous.
CREATE FUNCTION "passenger_manifest_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  trip_status "trip_status";
  generator_realm "auth_realm";
  generator_status "auth_identity_status";
  expected_version INTEGER;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'passenger manifests are append-only'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT "status" INTO trip_status
  FROM "trip" WHERE "id" = NEW."trip_id"
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports the unknown trip
  END IF;
  IF trip_status <> 'SCHEDULED' THEN
    RAISE EXCEPTION 'passenger manifest generation requires a scheduled trip'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT "realm", "status" INTO generator_realm, generator_status
  FROM "auth_identity" WHERE "id" = NEW."generated_by_identity_id"
  FOR SHARE;
  IF FOUND AND (generator_realm <> 'STAFF' OR generator_status <> 'ACTIVE') THEN
    RAISE EXCEPTION 'passenger manifest generator must be active STAFF'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(MAX("version"), 0) + 1 INTO expected_version
  FROM "passenger_manifest" WHERE "trip_id" = NEW."trip_id";
  IF NEW."version" <> expected_version THEN
    RAISE EXCEPTION 'passenger manifest version must be %', expected_version
      USING ERRCODE = 'check_violation';
  END IF;

  NEW."generated_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "passenger_manifest_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "passenger_manifest"
  FOR EACH ROW EXECUTE FUNCTION "passenger_manifest_guard"();

CREATE FUNCTION "passenger_manifest_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'passenger manifest history cannot be truncated'
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;

CREATE TRIGGER "passenger_manifest_no_truncate"
  BEFORE TRUNCATE ON "passenger_manifest"
  FOR EACH STATEMENT EXECUTE FUNCTION "passenger_manifest_no_truncate"();

-- Passenger manifests contain operational PII. Only operational leadership
-- and dispatch receive these explicit STAFF permissions; there is no grant
-- to booking, support, compliance, finance, audit, DRIVER or CREW roles.
INSERT INTO "authorization_permission" ("key", "description") VALUES
  ('manifest.read', 'Read immutable passenger manifest history and snapshots'),
  ('manifest.generate', 'Generate a new immutable passenger manifest version'),
  ('manifest.export', 'Export an immutable passenger manifest snapshot as CSV');

INSERT INTO "authorization_role_permission" ("role_key", "permission_key") VALUES
  ('SUPER_ADMIN', 'manifest.read'),
  ('SUPER_ADMIN', 'manifest.generate'),
  ('SUPER_ADMIN', 'manifest.export'),
  ('DIRECTOR', 'manifest.read'),
  ('DIRECTOR', 'manifest.generate'),
  ('DIRECTOR', 'manifest.export'),
  ('OPS_MANAGER', 'manifest.read'),
  ('OPS_MANAGER', 'manifest.generate'),
  ('OPS_MANAGER', 'manifest.export'),
  ('DISPATCHER', 'manifest.read'),
  ('DISPATCHER', 'manifest.generate'),
  ('DISPATCHER', 'manifest.export');
