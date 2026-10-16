-- CreateEnum
CREATE TYPE "tracking_visibility" AS ENUM ('HIDDEN', 'CHECKPOINT_ONLY', 'APPROXIMATE', 'PRECISE');

-- CreateEnum
CREATE TYPE "tracking_observation_source" AS ENUM ('GPS', 'CHECKPOINT', 'CREW', 'OPS', 'SYSTEM');

-- CreateEnum
CREATE TYPE "tracking_provider_status" AS ENUM ('UP', 'DEGRADED', 'STALE', 'UNAVAILABLE');

-- CreateTable
CREATE TABLE "tracking_device" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "provider_key" VARCHAR(64) NOT NULL,
    "external_id" VARCHAR(128) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_identity_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tracking_device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_tracking_config" (
    "trip_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "visibility" "tracking_visibility" NOT NULL DEFAULT 'HIDDEN',
    "tracking_device_id" UUID,
    "created_by_identity_id" UUID NOT NULL,
    "updated_by_identity_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "trip_tracking_config_pkey" PRIMARY KEY ("trip_id")
);

-- CreateTable
CREATE TABLE "tracking_observation" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "source" "tracking_observation_source" NOT NULL,
    "provider_key" VARCHAR(64),
    "provider_device_id" VARCHAR(128),
    "provider_observation_id" VARCHAR(128),
    "client_event_id" VARCHAR(64),
    "payload_fingerprint" CHAR(64) NOT NULL,
    "observed_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "accuracy_meters" DECIMAL(8,2),
    "speed_kph" DECIMAL(8,2),
    "heading_degrees" DECIMAL(6,2),
    "route_waypoint_id" UUID,
    "label" VARCHAR(160),
    "created_by_identity_id" UUID,
    "crew_assignment_id" UUID,
    "crew_device_id" UUID,

    CONSTRAINT "tracking_observation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracking_public_token" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "created_by_identity_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_identity_id" UUID,
    "revocation_reason" VARCHAR(255),

    CONSTRAINT "tracking_public_token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tracking_device_vehicle_id_active_idx" ON "tracking_device"("vehicle_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "tracking_device_provider_key_external_id_key" ON "tracking_device"("provider_key", "external_id");

-- CreateIndex
CREATE INDEX "trip_tracking_config_enabled_visibility_idx" ON "trip_tracking_config"("enabled", "visibility");

-- CreateIndex
CREATE INDEX "trip_tracking_config_tracking_device_id_idx" ON "trip_tracking_config"("tracking_device_id");

-- CreateIndex
CREATE INDEX "tracking_observation_trip_id_observed_at_id_idx" ON "tracking_observation"("trip_id", "observed_at", "id");

-- CreateIndex
CREATE INDEX "tracking_observation_source_observed_at_idx" ON "tracking_observation"("source", "observed_at");

-- CreateIndex
CREATE INDEX "tracking_observation_route_waypoint_id_idx" ON "tracking_observation"("route_waypoint_id");

-- CreateIndex
CREATE INDEX "tracking_observation_crew_assignment_id_idx" ON "tracking_observation"("crew_assignment_id");

-- CreateIndex
CREATE INDEX "tracking_observation_crew_device_id_idx" ON "tracking_observation"("crew_device_id");

-- CreateIndex
CREATE UNIQUE INDEX "tracking_observation_trip_id_client_event_id_key" ON "tracking_observation"("trip_id", "client_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "tracking_observation_provider_key_provider_observation_id_key" ON "tracking_observation"("provider_key", "provider_observation_id");

-- CreateIndex
CREATE UNIQUE INDEX "tracking_public_token_token_hash_key" ON "tracking_public_token"("token_hash");

-- CreateIndex
CREATE INDEX "tracking_public_token_trip_id_revoked_at_expires_at_idx" ON "tracking_public_token"("trip_id", "revoked_at", "expires_at");

-- AddForeignKey
ALTER TABLE "tracking_device" ADD CONSTRAINT "tracking_device_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tracking_device" ADD CONSTRAINT "tracking_device_created_by_identity_id_fkey" FOREIGN KEY ("created_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trip_tracking_config" ADD CONSTRAINT "trip_tracking_config_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trip_tracking_config" ADD CONSTRAINT "trip_tracking_config_tracking_device_id_fkey" FOREIGN KEY ("tracking_device_id") REFERENCES "tracking_device"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trip_tracking_config" ADD CONSTRAINT "trip_tracking_config_created_by_identity_id_fkey" FOREIGN KEY ("created_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trip_tracking_config" ADD CONSTRAINT "trip_tracking_config_updated_by_identity_id_fkey" FOREIGN KEY ("updated_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tracking_observation" ADD CONSTRAINT "tracking_observation_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tracking_observation" ADD CONSTRAINT "tracking_observation_route_waypoint_id_fkey" FOREIGN KEY ("route_waypoint_id") REFERENCES "route_waypoint"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tracking_observation" ADD CONSTRAINT "tracking_observation_created_by_identity_id_fkey" FOREIGN KEY ("created_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tracking_observation" ADD CONSTRAINT "tracking_observation_crew_assignment_id_fkey" FOREIGN KEY ("crew_assignment_id") REFERENCES "crew_trip_assignment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tracking_observation" ADD CONSTRAINT "tracking_observation_crew_device_id_fkey" FOREIGN KEY ("crew_device_id") REFERENCES "crew_device"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tracking_public_token" ADD CONSTRAINT "tracking_public_token_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tracking_public_token" ADD CONSTRAINT "tracking_public_token_created_by_identity_id_fkey" FOREIGN KEY ("created_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tracking_public_token" ADD CONSTRAINT "tracking_public_token_revoked_by_identity_id_fkey" FOREIGN KEY ("revoked_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------
-- PR-19 database invariants. Tracking observations are evidence, not mutable
-- state. Public visibility remains an explicit policy separate from ingestion.
-- ---------------------------------------------------------------------------

ALTER TABLE "tracking_device"
  ADD CONSTRAINT "tracking_device_provider_key_format"
  CHECK ("provider_key" ~ '^[A-Z][A-Z0-9_.-]{1,63}$'),
  ADD CONSTRAINT "tracking_device_external_id_nonempty"
  CHECK (length(btrim("external_id")) BETWEEN 1 AND 128);

ALTER TABLE "tracking_observation"
  ADD CONSTRAINT "tracking_observation_coordinate_pair"
  CHECK (("latitude" IS NULL) = ("longitude" IS NULL)),
  ADD CONSTRAINT "tracking_observation_latitude_range"
  CHECK ("latitude" IS NULL OR ("latitude" >= -90 AND "latitude" <= 90)),
  ADD CONSTRAINT "tracking_observation_longitude_range"
  CHECK ("longitude" IS NULL OR ("longitude" >= -180 AND "longitude" <= 180)),
  ADD CONSTRAINT "tracking_observation_accuracy_nonnegative"
  CHECK ("accuracy_meters" IS NULL OR "accuracy_meters" >= 0),
  ADD CONSTRAINT "tracking_observation_speed_nonnegative"
  CHECK ("speed_kph" IS NULL OR "speed_kph" >= 0),
  ADD CONSTRAINT "tracking_observation_heading_range"
  CHECK ("heading_degrees" IS NULL OR ("heading_degrees" >= 0 AND "heading_degrees" < 360)),
  ADD CONSTRAINT "tracking_observation_provider_pair"
  CHECK (("provider_key" IS NULL) = ("provider_observation_id" IS NULL)),
  ADD CONSTRAINT "tracking_observation_gps_shape"
  CHECK (
    "source" <> 'GPS'
    OR (
      "latitude" IS NOT NULL
      AND "provider_key" IS NOT NULL
      AND "provider_device_id" IS NOT NULL
      AND "provider_observation_id" IS NOT NULL
      AND "crew_assignment_id" IS NULL
      AND "crew_device_id" IS NULL
    )
  ),
  ADD CONSTRAINT "tracking_observation_provider_device_shape"
  CHECK ("provider_device_id" IS NULL OR "provider_key" IS NOT NULL),
  ADD CONSTRAINT "tracking_observation_checkpoint_shape"
  CHECK ("source" <> 'CHECKPOINT' OR "route_waypoint_id" IS NOT NULL),
  ADD CONSTRAINT "tracking_observation_crew_shape"
  CHECK (
    ("source" = 'CREW' AND "crew_assignment_id" IS NOT NULL AND "crew_device_id" IS NOT NULL AND "created_by_identity_id" IS NOT NULL)
    OR
    ("source" <> 'CREW' AND "crew_assignment_id" IS NULL AND "crew_device_id" IS NULL)
  ),
  ADD CONSTRAINT "tracking_observation_fingerprint_format"
  CHECK ("payload_fingerprint" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "tracking_observation_client_event_format"
  CHECK (
    "client_event_id" IS NULL
    OR "client_event_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$'
  );

ALTER TABLE "tracking_public_token"
  ADD CONSTRAINT "tracking_public_token_hash_length"
  CHECK (octet_length("token_hash") = 32),
  ADD CONSTRAINT "tracking_public_token_expiry_after_creation"
  CHECK ("expires_at" IS NULL OR "expires_at" > "created_at"),
  ADD CONSTRAINT "tracking_public_token_revocation_consistent"
  CHECK (
    ("revoked_at" IS NULL AND "revoked_by_identity_id" IS NULL AND "revocation_reason" IS NULL)
    OR
    ("revoked_at" IS NOT NULL AND "revoked_by_identity_id" IS NOT NULL AND "revocation_reason" IS NOT NULL)
  );

CREATE FUNCTION "tracking_device_immutable_identity"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."vehicle_id" IS DISTINCT FROM OLD."vehicle_id"
     OR NEW."provider_key" IS DISTINCT FROM OLD."provider_key"
     OR NEW."external_id" IS DISTINCT FROM OLD."external_id"
     OR NEW."created_by_identity_id" IS DISTINCT FROM OLD."created_by_identity_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'tracking device identity is immutable'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "tracking_device_immutable_identity"
  BEFORE UPDATE ON "tracking_device"
  FOR EACH ROW EXECUTE FUNCTION "tracking_device_immutable_identity"();

CREATE FUNCTION "tracking_config_validate_device"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  trip_vehicle uuid;
  device_vehicle uuid;
  device_active boolean;
BEGIN
  IF NEW."tracking_device_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "vehicle_id" INTO trip_vehicle
  FROM "trip"
  WHERE "id" = NEW."trip_id";

  SELECT "vehicle_id", "active" INTO device_vehicle, device_active
  FROM "tracking_device"
  WHERE "id" = NEW."tracking_device_id";

  IF trip_vehicle IS NULL THEN
    RAISE EXCEPTION 'tracking device requires a vehicle assigned to the trip'
      USING ERRCODE = 'check_violation';
  END IF;

  IF device_vehicle IS NULL OR device_vehicle <> trip_vehicle OR device_active IS NOT TRUE THEN
    RAISE EXCEPTION 'tracking device does not match the active trip vehicle'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "trip_tracking_config_validate_device"
  BEFORE INSERT OR UPDATE OF "trip_id", "tracking_device_id"
  ON "trip_tracking_config"
  FOR EACH ROW EXECUTE FUNCTION "tracking_config_validate_device"();

CREATE FUNCTION "tracking_trip_vehicle_validate"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  configured_device uuid;
  configured_vehicle uuid;
BEGIN
  IF NEW."vehicle_id" IS NOT DISTINCT FROM OLD."vehicle_id" THEN
    RETURN NEW;
  END IF;

  SELECT "tracking_device_id" INTO configured_device
  FROM "trip_tracking_config"
  WHERE "trip_id" = OLD."id";

  IF configured_device IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "vehicle_id" INTO configured_vehicle
  FROM "tracking_device"
  WHERE "id" = configured_device;

  IF NEW."vehicle_id" IS NULL OR configured_vehicle IS DISTINCT FROM NEW."vehicle_id" THEN
    RAISE EXCEPTION 'trip vehicle change would invalidate tracking device'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "trip_tracking_vehicle_validate"
  BEFORE UPDATE OF "vehicle_id" ON "trip"
  FOR EACH ROW EXECUTE FUNCTION "tracking_trip_vehicle_validate"();

CREATE FUNCTION "tracking_observation_validate"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  trip_route_version uuid;
  waypoint_route_version uuid;
  assignment_trip uuid;
  assignment_crew uuid;
  assignment_revoked timestamptz;
  device_identity uuid;
  device_revoked timestamptz;
  device_expires timestamptz;
  actor_realm auth_realm;
BEGIN
  NEW."received_at" := clock_timestamp();

  IF NEW."observed_at" > NEW."received_at" + interval '5 minutes' THEN
    RAISE EXCEPTION 'tracking observed_at is too far in the future'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."route_waypoint_id" IS NOT NULL THEN
    SELECT "route_version_id" INTO trip_route_version
    FROM "trip" WHERE "id" = NEW."trip_id";

    SELECT "route_version_id" INTO waypoint_route_version
    FROM "route_waypoint" WHERE "id" = NEW."route_waypoint_id";

    IF waypoint_route_version IS NULL OR waypoint_route_version <> trip_route_version THEN
      RAISE EXCEPTION 'tracking waypoint does not belong to the trip route version'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."source" = 'CREW' THEN
    SELECT "trip_id", "crew_identity_id", "revoked_at"
      INTO assignment_trip, assignment_crew, assignment_revoked
    FROM "crew_trip_assignment"
    WHERE "id" = NEW."crew_assignment_id";

    IF assignment_trip IS NULL
       OR assignment_trip <> NEW."trip_id"
       OR assignment_crew <> NEW."created_by_identity_id"
       OR assignment_revoked IS NOT NULL THEN
      RAISE EXCEPTION 'invalid crew tracking provenance'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT "identity_id", "revoked_at", "expires_at"
      INTO device_identity, device_revoked, device_expires
    FROM "crew_device"
    WHERE "id" = NEW."crew_device_id";

    IF device_identity IS NULL
       OR device_identity <> NEW."created_by_identity_id"
       OR device_revoked IS NOT NULL
       OR device_expires <= NEW."received_at" THEN
      RAISE EXCEPTION 'invalid crew tracking device provenance'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT "realm" INTO actor_realm
    FROM "auth_identity"
    WHERE "id" = NEW."created_by_identity_id";

    IF actor_realm <> 'CREW' THEN
      RAISE EXCEPTION 'crew tracking actor must be in CREW realm'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "tracking_observation_validate"
  BEFORE INSERT ON "tracking_observation"
  FOR EACH ROW EXECUTE FUNCTION "tracking_observation_validate"();

CREATE FUNCTION "tracking_observation_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tracking observations are append-only'
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;

CREATE TRIGGER "tracking_observation_no_update"
  BEFORE UPDATE ON "tracking_observation"
  FOR EACH ROW EXECUTE FUNCTION "tracking_observation_append_only"();

CREATE TRIGGER "tracking_observation_no_delete"
  BEFORE DELETE ON "tracking_observation"
  FOR EACH ROW EXECUTE FUNCTION "tracking_observation_append_only"();

CREATE FUNCTION "tracking_token_immutable_identity"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."trip_id" IS DISTINCT FROM OLD."trip_id"
     OR NEW."token_hash" IS DISTINCT FROM OLD."token_hash"
     OR NEW."created_by_identity_id" IS DISTINCT FROM OLD."created_by_identity_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at" THEN
    RAISE EXCEPTION 'tracking public token identity is immutable'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF OLD."revoked_at" IS NOT NULL AND (
       NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at"
       OR NEW."revoked_by_identity_id" IS DISTINCT FROM OLD."revoked_by_identity_id"
       OR NEW."revocation_reason" IS DISTINCT FROM OLD."revocation_reason"
     ) THEN
    RAISE EXCEPTION 'tracking public token revocation is final'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "tracking_public_token_immutable_identity"
  BEFORE UPDATE ON "tracking_public_token"
  FOR EACH ROW EXECUTE FUNCTION "tracking_token_immutable_identity"();

CREATE FUNCTION "tracking_no_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tracking history cannot be deleted (%)', TG_TABLE_NAME
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;

CREATE TRIGGER "tracking_device_no_delete"
  BEFORE DELETE ON "tracking_device"
  FOR EACH ROW EXECUTE FUNCTION "tracking_no_delete"();
CREATE TRIGGER "trip_tracking_config_no_delete"
  BEFORE DELETE ON "trip_tracking_config"
  FOR EACH ROW EXECUTE FUNCTION "tracking_no_delete"();
CREATE TRIGGER "tracking_public_token_no_delete"
  BEFORE DELETE ON "tracking_public_token"
  FOR EACH ROW EXECUTE FUNCTION "tracking_no_delete"();

CREATE FUNCTION "tracking_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tracking history cannot be truncated (%)', TG_TABLE_NAME
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;

CREATE TRIGGER "tracking_device_no_truncate"
  BEFORE TRUNCATE ON "tracking_device"
  FOR EACH STATEMENT EXECUTE FUNCTION "tracking_no_truncate"();
CREATE TRIGGER "trip_tracking_config_no_truncate"
  BEFORE TRUNCATE ON "trip_tracking_config"
  FOR EACH STATEMENT EXECUTE FUNCTION "tracking_no_truncate"();
CREATE TRIGGER "tracking_observation_no_truncate"
  BEFORE TRUNCATE ON "tracking_observation"
  FOR EACH STATEMENT EXECUTE FUNCTION "tracking_no_truncate"();
CREATE TRIGGER "tracking_public_token_no_truncate"
  BEFORE TRUNCATE ON "tracking_public_token"
  FOR EACH STATEMENT EXECUTE FUNCTION "tracking_no_truncate"();

-- Tracking permissions are deliberately independent of generic trip.read.
INSERT INTO "authorization_permission" ("key", "description") VALUES
  ('tracking.read', 'Read operational trip tracking and provider health'),
  ('tracking.manage', 'Configure tracking, ingest operational observations and manage public tokens'),
  ('crew.tracking.report', 'Report a checkpoint for an assigned trip from the Crew realm');

INSERT INTO "authorization_role_permission" ("role_key", "permission_key") VALUES
  ('SUPER_ADMIN', 'tracking.read'),
  ('SUPER_ADMIN', 'tracking.manage'),
  ('SUPER_ADMIN', 'crew.tracking.report'),
  ('DIRECTOR', 'tracking.read'),
  ('DIRECTOR', 'tracking.manage'),
  ('OPS_MANAGER', 'tracking.read'),
  ('OPS_MANAGER', 'tracking.manage'),
  ('DISPATCHER', 'tracking.read'),
  ('DISPATCHER', 'tracking.manage'),
  ('CUSTOMER_SUPPORT', 'tracking.read'),
  ('AUDITOR', 'tracking.read'),
  ('DRIVER', 'crew.tracking.report'),
  ('CREW', 'crew.tracking.report')
ON CONFLICT DO NOTHING;
