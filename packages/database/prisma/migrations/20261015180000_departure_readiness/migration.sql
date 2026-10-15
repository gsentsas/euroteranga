-- CreateEnum
CREATE TYPE "departure_permit_policy_status" AS ENUM ('DRAFT', 'PUBLISHED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "trip_status" ADD VALUE 'IN_PROGRESS';
ALTER TYPE "trip_status" ADD VALUE 'COMPLETED';

-- AlterTable
ALTER TABLE "trip" ADD COLUMN     "actual_arrival_at" TIMESTAMPTZ(3),
ADD COLUMN     "actual_departure_at" TIMESTAMPTZ(3),
ADD COLUMN     "departure_authorization_id" UUID;

-- CreateTable
CREATE TABLE "departure_permit_policy" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "departure_permit_policy_status" NOT NULL DEFAULT 'DRAFT',
    "schema_version" VARCHAR(40) NOT NULL,
    "content_hash" CHAR(64),
    "requirement_count" INTEGER,
    "published_by_identity_id" UUID,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "departure_permit_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departure_permit_requirement" (
    "policy_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "permit_type" VARCHAR(64) NOT NULL,
    "scope_type" "regulatory_permit_scope_type" NOT NULL,
    "scope_country_id" UUID,

    CONSTRAINT "departure_permit_requirement_pkey" PRIMARY KEY ("policy_id","sequence")
);

-- CreateTable
CREATE TABLE "departure_authorization" (
    "id" UUID NOT NULL,
    "reference" VARCHAR(17) NOT NULL,
    "trip_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "engine_version" VARCHAR(40) NOT NULL,
    "readiness_fingerprint" CHAR(64) NOT NULL,
    "readiness_snapshot" JSONB NOT NULL,
    "authorized_by_identity_id" UUID NOT NULL,
    "authorized_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "departure_authorization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "departure_permit_policy_published_at_id_idx" ON "departure_permit_policy"("published_at", "id");

-- CreateIndex
CREATE INDEX "departure_permit_policy_published_by_identity_id_idx" ON "departure_permit_policy"("published_by_identity_id");

-- CreateIndex
CREATE UNIQUE INDEX "departure_permit_policy_trip_id_version_key" ON "departure_permit_policy"("trip_id", "version");

-- CreateIndex
CREATE INDEX "departure_permit_requirement_permit_type_scope_type_idx" ON "departure_permit_requirement"("permit_type", "scope_type");

-- CreateIndex
CREATE INDEX "departure_permit_requirement_scope_country_id_idx" ON "departure_permit_requirement"("scope_country_id");

-- CreateIndex
CREATE UNIQUE INDEX "departure_authorization_reference_key" ON "departure_authorization"("reference");

-- CreateIndex
CREATE INDEX "departure_authorization_authorized_at_id_idx" ON "departure_authorization"("authorized_at", "id");

-- CreateIndex
CREATE INDEX "departure_authorization_authorized_by_identity_id_idx" ON "departure_authorization"("authorized_by_identity_id");

-- CreateIndex
CREATE UNIQUE INDEX "departure_authorization_trip_id_version_key" ON "departure_authorization"("trip_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "trip_departure_authorization_id_key" ON "trip"("departure_authorization_id");

-- CreateIndex
CREATE INDEX "trip_actual_departure_at_id_idx" ON "trip"("actual_departure_at", "id");

-- CreateIndex
CREATE INDEX "trip_actual_arrival_at_id_idx" ON "trip"("actual_arrival_at", "id");

-- AddForeignKey
ALTER TABLE "trip" ADD CONSTRAINT "trip_departure_authorization_id_fkey" FOREIGN KEY ("departure_authorization_id") REFERENCES "departure_authorization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "departure_permit_policy" ADD CONSTRAINT "departure_permit_policy_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "departure_permit_policy" ADD CONSTRAINT "departure_permit_policy_published_by_identity_id_fkey" FOREIGN KEY ("published_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "departure_permit_requirement" ADD CONSTRAINT "departure_permit_requirement_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "departure_permit_policy"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "departure_permit_requirement" ADD CONSTRAINT "departure_permit_requirement_scope_country_id_fkey" FOREIGN KEY ("scope_country_id") REFERENCES "country"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "departure_authorization" ADD CONSTRAINT "departure_authorization_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "departure_authorization" ADD CONSTRAINT "departure_authorization_authorized_by_identity_id_fkey" FOREIGN KEY ("authorized_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- PR-17 row-local lifecycle and readiness-policy invariants
-- ---------------------------------------------------------------------------

ALTER TABLE "trip" DROP CONSTRAINT "trip_scheduled_at_consistent";
ALTER TABLE "trip" DROP CONSTRAINT "trip_scheduled_has_times";
ALTER TABLE "trip" ADD CONSTRAINT "trip_scheduled_at_consistent"
  CHECK (
    ("status" = 'DRAFT' AND "scheduled_at" IS NULL)
    OR ("status" IN ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED') AND "scheduled_at" IS NOT NULL)
    OR "status" = 'CANCELLED'
  );
ALTER TABLE "trip" ADD CONSTRAINT "trip_scheduled_has_times"
  CHECK ("status" NOT IN ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED') OR "planned_departure_at" IS NOT NULL);
ALTER TABLE "trip" ADD CONSTRAINT "trip_actual_lifecycle_consistent"
  CHECK (
    ("status" IN ('DRAFT', 'SCHEDULED', 'CANCELLED')
      AND "actual_departure_at" IS NULL AND "actual_arrival_at" IS NULL
      AND "departure_authorization_id" IS NULL)
    OR ("status" = 'IN_PROGRESS'
      AND "actual_departure_at" IS NOT NULL AND "actual_arrival_at" IS NULL
      AND "departure_authorization_id" IS NOT NULL)
    OR ("status" = 'COMPLETED'
      AND "actual_departure_at" IS NOT NULL AND "actual_arrival_at" IS NOT NULL
      AND "departure_authorization_id" IS NOT NULL)
  );
ALTER TABLE "trip" ADD CONSTRAINT "trip_actual_times_ordered"
  CHECK ("actual_arrival_at" IS NULL OR "actual_arrival_at" >= "actual_departure_at");

ALTER TABLE "departure_permit_policy" ADD CONSTRAINT "departure_permit_policy_version_positive"
  CHECK ("version" > 0);
ALTER TABLE "departure_permit_policy" ADD CONSTRAINT "departure_permit_policy_schema_version"
  CHECK ("schema_version" = 'departure-permit-policy/1');
ALTER TABLE "departure_permit_policy" ADD CONSTRAINT "departure_permit_policy_lifecycle_coherent"
  CHECK (
    ("status" = 'DRAFT' AND "content_hash" IS NULL AND "requirement_count" IS NULL
      AND "published_by_identity_id" IS NULL AND "published_at" IS NULL)
    OR
    ("status" = 'PUBLISHED' AND "content_hash" ~ '^[0-9a-f]{64}$'
      AND "requirement_count" IS NOT NULL AND "requirement_count" >= 0
      AND "published_by_identity_id" IS NOT NULL AND "published_at" IS NOT NULL)
  );

ALTER TABLE "departure_permit_requirement" ADD CONSTRAINT "departure_permit_requirement_sequence_positive"
  CHECK ("sequence" > 0);
ALTER TABLE "departure_permit_requirement" ADD CONSTRAINT "departure_permit_requirement_type_format"
  CHECK ("permit_type" ~ '^[A-Z][A-Z0-9_.-]{1,63}$');
ALTER TABLE "departure_permit_requirement" ADD CONSTRAINT "departure_permit_requirement_scope_coherent"
  CHECK (
    ("scope_type" = 'COUNTRY' AND "scope_country_id" IS NOT NULL)
    OR ("scope_type" <> 'COUNTRY' AND "scope_country_id" IS NULL)
  );
ALTER TABLE "departure_authorization" ADD CONSTRAINT "departure_authorization_reference_format"
  CHECK ("reference" ~ '^ETDA-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$');
ALTER TABLE "departure_authorization" ADD CONSTRAINT "departure_authorization_version_positive"
  CHECK ("version" > 0);
ALTER TABLE "departure_authorization" ADD CONSTRAINT "departure_authorization_engine_version"
  CHECK ("engine_version" = 'departure-readiness/1');
ALTER TABLE "departure_authorization" ADD CONSTRAINT "departure_authorization_fingerprint_format"
  CHECK ("readiness_fingerprint" ~ '^[0-9a-f]{64}$');
ALTER TABLE "departure_authorization" ADD CONSTRAINT "departure_authorization_snapshot_object"
  CHECK (
    jsonb_typeof("readiness_snapshot") = 'object'
    AND "readiness_snapshot"->>'engineVersion' = "engine_version"
    AND "readiness_snapshot"->>'status' = 'READY'
  );

CREATE FUNCTION "departure_assert_active_staff"(identity UUID, field_name TEXT) RETURNS void
LANGUAGE plpgsql AS $$
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
    RAISE EXCEPTION 'departure % must be active STAFF', field_name
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE FUNCTION "departure_permit_policy_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  trip_state "trip_status";
  expected_version INTEGER;
  actual_count INTEGER;
  minimum_sequence INTEGER;
  maximum_sequence INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'departure permit policy history cannot be deleted'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT "status" INTO trip_state
  FROM "trip" WHERE "id" = NEW."trip_id" FOR UPDATE;
  IF FOUND AND trip_state <> 'SCHEDULED' THEN
    RAISE EXCEPTION 'departure permit policy publication requires a scheduled trip'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."content_hash" IS NOT NULL
       OR NEW."requirement_count" IS NOT NULL OR NEW."published_by_identity_id" IS NOT NULL
       OR NEW."published_at" IS NOT NULL THEN
      RAISE EXCEPTION 'departure permit policies must start as empty draft headers'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT COALESCE(MAX("version"), 0) + 1 INTO expected_version
    FROM "departure_permit_policy" WHERE "trip_id" = NEW."trip_id";
    IF NEW."version" <> expected_version THEN
      RAISE EXCEPTION 'departure permit policy version must be %', expected_version
        USING ERRCODE = 'check_violation';
    END IF;
    NEW."created_at" := clock_timestamp();
    RETURN NEW;
  END IF;

  IF OLD."status" = 'PUBLISHED' THEN
    RAISE EXCEPTION 'published departure permit policies are immutable'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."trip_id" IS DISTINCT FROM OLD."trip_id"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."schema_version" IS DISTINCT FROM OLD."schema_version"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR OLD."status" <> 'DRAFT' OR NEW."status" <> 'PUBLISHED' THEN
    RAISE EXCEPTION 'invalid departure permit policy publication'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT COUNT(*), MIN("sequence"), MAX("sequence")
    INTO actual_count, minimum_sequence, maximum_sequence
  FROM "departure_permit_requirement" WHERE "policy_id" = NEW."id";
  IF NEW."requirement_count" IS DISTINCT FROM actual_count
     OR (actual_count > 0 AND (minimum_sequence <> 1 OR maximum_sequence <> actual_count)) THEN
    RAISE EXCEPTION 'departure permit policy requirements must be contiguous and counted exactly'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."content_hash" IS NULL OR NEW."published_by_identity_id" IS NULL THEN
    RAISE EXCEPTION 'departure permit policy publication requires hash and publisher'
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM "departure_assert_active_staff"(NEW."published_by_identity_id", 'policy publisher');
  NEW."published_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "departure_permit_policy_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "departure_permit_policy"
  FOR EACH ROW EXECUTE FUNCTION "departure_permit_policy_guard"();

CREATE FUNCTION "departure_permit_requirement_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  policy_state "departure_permit_policy_status";
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'departure permit requirements are append-only'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT "status" INTO policy_state
  FROM "departure_permit_policy" WHERE "id" = NEW."policy_id" FOR UPDATE;
  IF FOUND AND policy_state <> 'DRAFT' THEN
    RAISE EXCEPTION 'requirements can only be added before policy publication'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "departure_permit_requirement_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "departure_permit_requirement"
  FOR EACH ROW EXECUTE FUNCTION "departure_permit_requirement_guard"();

CREATE FUNCTION "departure_authorization_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  trip_state "trip_status";
  expected_version INTEGER;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'departure authorizations are append-only'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT "status" INTO trip_state
  FROM "trip" WHERE "id" = NEW."trip_id" FOR UPDATE;
  IF FOUND AND trip_state <> 'SCHEDULED' THEN
    RAISE EXCEPTION 'departure authorization requires a scheduled trip'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  PERFORM "departure_assert_active_staff"(NEW."authorized_by_identity_id", 'authorizer');
  SELECT COALESCE(MAX("version"), 0) + 1 INTO expected_version
  FROM "departure_authorization" WHERE "trip_id" = NEW."trip_id";
  IF NEW."version" <> expected_version THEN
    RAISE EXCEPTION 'departure authorization version must be %', expected_version
      USING ERRCODE = 'check_violation';
  END IF;
  NEW."authorized_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "departure_authorization_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "departure_authorization"
  FOR EACH ROW EXECUTE FUNCTION "departure_authorization_guard"();

CREATE FUNCTION "departure_history_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'departure readiness history cannot be truncated'
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;

CREATE TRIGGER "departure_permit_policy_no_truncate"
  BEFORE TRUNCATE ON "departure_permit_policy"
  FOR EACH STATEMENT EXECUTE FUNCTION "departure_history_no_truncate"();
CREATE TRIGGER "departure_permit_requirement_no_truncate"
  BEFORE TRUNCATE ON "departure_permit_requirement"
  FOR EACH STATEMENT EXECUTE FUNCTION "departure_history_no_truncate"();
CREATE TRIGGER "departure_authorization_no_truncate"
  BEFORE TRUNCATE ON "departure_authorization"
  FOR EACH STATEMENT EXECUTE FUNCTION "departure_history_no_truncate"();

-- Replace the latest PR-10 trip guard, preserving all prior invariants and
-- adding only dispatch lifecycle, database-owned clocks, authorization
-- provenance, and current vehicle/seat-map revalidation at departure.

CREATE OR REPLACE FUNCTION "trip_lifecycle_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  version_published TIMESTAMPTZ;
  seat_map_published TIMESTAMPTZ;
  vehicle_state "vehicle_status";
  vehicle_seat_map UUID;
  timetable_error TEXT;
  scheduling BOOLEAN := false;
  vehicle_changed BOOLEAN := false;
  seat_map_changed BOOLEAN := false;
  fare_published TIMESTAMPTZ;
  fare_route_version UUID;
  fare_changed BOOLEAN := false;
  departing BOOLEAN := false;
  departure_auth_trip UUID;
  departure_auth_version INTEGER;
  latest_auth_version INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'trips cannot be deleted; cancel them instead'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'trips must be created as DRAFT'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT "published_at" INTO version_published
    FROM "route_version" WHERE "id" = NEW."route_version_id";
    IF FOUND AND version_published IS NULL THEN
      RAISE EXCEPTION 'a trip must use a route version that has been published'
        USING ERRCODE = 'check_violation';
    END IF;
    vehicle_changed := NEW."vehicle_id" IS NOT NULL;
    seat_map_changed := NEW."seat_map_version_id" IS NOT NULL;
    fare_changed := NEW."fare_table_version_id" IS NOT NULL;
  ELSE
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."reference" IS DISTINCT FROM OLD."reference"
       OR NEW."route_version_id" IS DISTINCT FROM OLD."route_version_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
      RAISE EXCEPTION 'trip reference, route version and identity are immutable'
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."status" = 'CANCELLED' THEN
      RAISE EXCEPTION 'cancelled trips are immutable'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF OLD."status" = 'COMPLETED' THEN
      RAISE EXCEPTION 'completed trips are immutable'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
      (OLD."status" = 'DRAFT' AND NEW."status" IN ('SCHEDULED', 'CANCELLED'))
      OR (OLD."status" = 'SCHEDULED' AND NEW."status" IN ('CANCELLED', 'IN_PROGRESS'))
      OR (OLD."status" = 'IN_PROGRESS' AND NEW."status" = 'COMPLETED')
    ) THEN
      RAISE EXCEPTION 'invalid trip status transition from % to %', OLD."status", NEW."status"
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    departing := OLD."status" = 'SCHEDULED' AND NEW."status" = 'IN_PROGRESS';
    IF departing THEN
      IF NEW."vehicle_id" IS NULL THEN
        RAISE EXCEPTION 'departure requires an assigned vehicle'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
      IF NEW."departure_authorization_id" IS NULL THEN
        RAISE EXCEPTION 'departure requires an authorization'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
      SELECT "trip_id", "version" INTO departure_auth_trip, departure_auth_version
      FROM "departure_authorization"
      WHERE "id" = NEW."departure_authorization_id" FOR SHARE;
      IF NOT FOUND OR departure_auth_trip IS DISTINCT FROM NEW."id" THEN
        RAISE EXCEPTION 'departure authorization must belong to the trip'
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT MAX("version") INTO latest_auth_version
      FROM "departure_authorization" WHERE "trip_id" = NEW."id";
      IF departure_auth_version IS DISTINCT FROM latest_auth_version THEN
        RAISE EXCEPTION 'departure requires the latest authorization'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
      NEW."actual_departure_at" := clock_timestamp();
      NEW."actual_arrival_at" := NULL;
    ELSIF OLD."status" = 'IN_PROGRESS' AND NEW."status" = 'COMPLETED' THEN
      IF NEW."departure_authorization_id" IS DISTINCT FROM OLD."departure_authorization_id" THEN
        RAISE EXCEPTION 'departure authorization is immutable after departure'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
      NEW."actual_departure_at" := OLD."actual_departure_at";
      NEW."actual_arrival_at" := clock_timestamp();
    ELSIF NEW."actual_departure_at" IS DISTINCT FROM OLD."actual_departure_at"
       OR NEW."actual_arrival_at" IS DISTINCT FROM OLD."actual_arrival_at"
       OR NEW."departure_authorization_id" IS DISTINCT FROM OLD."departure_authorization_id" THEN
      RAISE EXCEPTION 'actual trip clocks and departure authorization are server-owned'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    IF OLD."status" <> 'DRAFT' AND (
      NEW."planned_departure_at" IS DISTINCT FROM OLD."planned_departure_at"
      OR NEW."planned_arrival_at" IS DISTINCT FROM OLD."planned_arrival_at"
      OR NEW."scheduled_at" IS DISTINCT FROM OLD."scheduled_at"
    ) THEN
      RAISE EXCEPTION 'the timetable of a scheduled trip is frozen'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    IF NEW."status" = 'CANCELLED' AND NEW."vehicle_id" IS DISTINCT FROM OLD."vehicle_id" THEN
      RAISE EXCEPTION 'a trip cannot change vehicle while being cancelled'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    -- PR-10: refunds do not exist yet, so a trip with a confirmed (paid)
    -- booking cannot be cancelled (TRIP_HAS_CONFIRMED_BOOKINGS).
    IF NEW."status" = 'CANCELLED' AND EXISTS (
      SELECT 1 FROM "booking"
      WHERE "trip_id" = NEW."id" AND "confirmed_at" IS NOT NULL AND "cancelled_at" IS NULL
    ) THEN
      RAISE EXCEPTION 'a trip with confirmed bookings cannot be cancelled'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    -- PR-09: a cancellation releases every active booking hold first, in the
    -- same transaction (BOOKING_CANCELLED_BY_TRIP).
    IF NEW."status" = 'CANCELLED' AND EXISTS (
      SELECT 1 FROM "booking"
      WHERE "trip_id" = NEW."id" AND "cancelled_at" IS NULL AND "hold_expires_at" > now()
    ) THEN
      RAISE EXCEPTION 'a trip with active booking holds cannot be cancelled'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    seat_map_changed := NEW."seat_map_version_id" IS DISTINCT FROM OLD."seat_map_version_id";
    IF seat_map_changed AND NOT (OLD."status" = 'DRAFT' AND NEW."status" = 'DRAFT') THEN
      RAISE EXCEPTION 'the seat map of a scheduled or cancelled trip is frozen'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    fare_changed := NEW."fare_table_version_id" IS DISTINCT FROM OLD."fare_table_version_id";
    IF fare_changed AND NOT (OLD."status" = 'DRAFT' AND NEW."status" = 'DRAFT') THEN
      RAISE EXCEPTION 'the pricing of a scheduled or cancelled trip is frozen'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    vehicle_changed := NEW."vehicle_id" IS DISTINCT FROM OLD."vehicle_id";
    scheduling := OLD."status" = 'DRAFT' AND NEW."status" = 'SCHEDULED';
    IF OLD."status" = 'IN_PROGRESS' AND vehicle_changed THEN
      RAISE EXCEPTION 'the vehicle of an in-progress trip is frozen'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    IF scheduling THEN
      timetable_error := "trip_timetable_error"(
        NEW."id", NEW."route_version_id", NEW."planned_departure_at", NEW."planned_arrival_at"
      );
      IF timetable_error IS NOT NULL THEN
        RAISE EXCEPTION 'cannot schedule trip: %', timetable_error
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW."seat_map_version_id" IS NOT NULL AND seat_map_changed THEN
    SELECT "published_at" INTO seat_map_published
    FROM "seat_map_version" WHERE "id" = NEW."seat_map_version_id";
    IF FOUND AND seat_map_published IS NULL THEN
      RAISE EXCEPTION 'a trip seat map must be a version that has been published'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."fare_table_version_id" IS NOT NULL AND fare_changed THEN
    SELECT "published_at", "route_version_id" INTO fare_published, fare_route_version
    FROM "fare_table_version" WHERE "id" = NEW."fare_table_version_id";
    IF FOUND THEN
      IF fare_published IS NULL THEN
        RAISE EXCEPTION 'a trip fare table must be a version that has been published'
          USING ERRCODE = 'check_violation';
      END IF;
      IF fare_route_version IS DISTINCT FROM NEW."route_version_id" THEN
        RAISE EXCEPTION 'the trip fare table must price the trip route version'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW."vehicle_id" IS NOT NULL AND (vehicle_changed OR seat_map_changed OR scheduling OR departing) THEN
    SELECT "status", "seat_map_version_id" INTO vehicle_state, vehicle_seat_map
    FROM "vehicle" WHERE "id" = NEW."vehicle_id" FOR SHARE;
    IF FOUND THEN
      IF (vehicle_changed OR scheduling OR departing) AND vehicle_state <> 'ACTIVE' THEN
        RAISE EXCEPTION 'an assigned vehicle must be ACTIVE'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."seat_map_version_id" IS NOT NULL
         AND vehicle_seat_map IS DISTINCT FROM NEW."seat_map_version_id" THEN
        RAISE EXCEPTION 'the trip seat map and the vehicle seat map are incompatible'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


-- PR-17 departure/dispatch permissions. DRIVER/CREW remain intentionally out
-- until PR-18 offline/device work exists.
INSERT INTO "authorization_permission" ("key", "description") VALUES
  ('departure.read', 'Read whole-trip departure readiness, policies and dispatch history'),
  ('departure.authorize', 'Create an explicit immutable authorization for a currently-ready trip'),
  ('departure.manage', 'Publish trip permit requirements and record departure/completion');

INSERT INTO "authorization_role_permission" ("role_key", "permission_key") VALUES
  ('SUPER_ADMIN', 'departure.read'),
  ('SUPER_ADMIN', 'departure.authorize'),
  ('SUPER_ADMIN', 'departure.manage'),
  ('DIRECTOR', 'departure.read'),
  ('DIRECTOR', 'departure.authorize'),
  ('DIRECTOR', 'departure.manage'),
  ('OPS_MANAGER', 'departure.read'),
  ('OPS_MANAGER', 'departure.authorize'),
  ('OPS_MANAGER', 'departure.manage'),
  ('DISPATCHER', 'departure.read'),
  ('DISPATCHER', 'departure.authorize'),
  ('DISPATCHER', 'departure.manage'),
  ('AUDITOR', 'departure.read');
