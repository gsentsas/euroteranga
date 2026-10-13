-- PR-06 Trips: planned occurrences of published route versions, their
-- timetable and an optional vehicle.
--
-- The Prisma-shaped DDL is followed by PostgreSQL constraints and triggers
-- for invariants that must also hold for direct database writes. No trip or
-- commercial reference is seeded here. All times are UTC (timestamptz); the
-- timezones of stops and checkpoints are for presentation only.
-- CreateEnum
CREATE TYPE "trip_status" AS ENUM ('DRAFT', 'SCHEDULED', 'CANCELLED');

-- CreateTable
CREATE TABLE "trip" (
    "id" UUID NOT NULL,
    "reference" VARCHAR(32) NOT NULL,
    "route_version_id" UUID NOT NULL,
    "vehicle_id" UUID,
    "status" "trip_status" NOT NULL DEFAULT 'DRAFT',
    "planned_departure_at" TIMESTAMPTZ(3),
    "planned_arrival_at" TIMESTAMPTZ(3),
    "scheduled_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "trip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_waypoint_timing" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "route_waypoint_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "planned_arrival_at" TIMESTAMPTZ(3),
    "planned_departure_at" TIMESTAMPTZ(3),

    CONSTRAINT "trip_waypoint_timing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trip_reference_key" ON "trip"("reference");

-- CreateIndex
CREATE INDEX "trip_status_id_idx" ON "trip"("status", "id");

-- CreateIndex
CREATE INDEX "trip_route_version_id_id_idx" ON "trip"("route_version_id", "id");

-- CreateIndex
CREATE INDEX "trip_planned_departure_at_id_idx" ON "trip"("planned_departure_at", "id");

-- CreateIndex
CREATE INDEX "trip_vehicle_id_idx" ON "trip"("vehicle_id");

-- CreateIndex
CREATE INDEX "trip_waypoint_timing_route_waypoint_id_idx" ON "trip_waypoint_timing"("route_waypoint_id");

-- CreateIndex
CREATE UNIQUE INDEX "trip_waypoint_timing_trip_id_sequence_key" ON "trip_waypoint_timing"("trip_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "trip_waypoint_timing_trip_id_route_waypoint_id_key" ON "trip_waypoint_timing"("trip_id", "route_waypoint_id");

-- AddForeignKey
ALTER TABLE "trip" ADD CONSTRAINT "trip_route_version_id_fkey" FOREIGN KEY ("route_version_id") REFERENCES "route_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip" ADD CONSTRAINT "trip_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_waypoint_timing" ADD CONSTRAINT "trip_waypoint_timing_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_waypoint_timing" ADD CONSTRAINT "trip_waypoint_timing_route_waypoint_id_fkey" FOREIGN KEY ("route_waypoint_id") REFERENCES "route_waypoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Row-local invariants
-- ---------------------------------------------------------------------------

ALTER TABLE "trip" ADD CONSTRAINT "trip_reference_normalized"
  CHECK ("reference" = upper(btrim("reference")) AND "reference" ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$');

-- scheduled_at: NULL while DRAFT, set when SCHEDULED, kept after a
-- cancellation of a scheduled trip (NULL if cancelled from DRAFT).
ALTER TABLE "trip" ADD CONSTRAINT "trip_scheduled_at_consistent"
  CHECK (
    ("status" = 'DRAFT' AND "scheduled_at" IS NULL)
    OR ("status" = 'SCHEDULED' AND "scheduled_at" IS NOT NULL)
    OR "status" = 'CANCELLED'
  );
ALTER TABLE "trip" ADD CONSTRAINT "trip_cancelled_at_consistent"
  CHECK (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL));
ALTER TABLE "trip" ADD CONSTRAINT "trip_planned_times_consistent"
  CHECK (
    ("planned_departure_at" IS NULL) = ("planned_arrival_at" IS NULL)
    AND ("planned_departure_at" IS NULL OR "planned_arrival_at" > "planned_departure_at")
  );
ALTER TABLE "trip" ADD CONSTRAINT "trip_scheduled_has_times"
  CHECK ("status" <> 'SCHEDULED' OR "planned_departure_at" IS NOT NULL);

ALTER TABLE "trip_waypoint_timing" ADD CONSTRAINT "trip_waypoint_timing_sequence_positive"
  CHECK ("sequence" > 0);
ALTER TABLE "trip_waypoint_timing" ADD CONSTRAINT "trip_waypoint_timing_has_time"
  CHECK (num_nonnulls("planned_arrival_at", "planned_departure_at") >= 1);
ALTER TABLE "trip_waypoint_timing" ADD CONSTRAINT "trip_waypoint_timing_dwell_order"
  CHECK (
    "planned_arrival_at" IS NULL
    OR "planned_departure_at" IS NULL
    OR "planned_arrival_at" <= "planned_departure_at"
  );

-- ---------------------------------------------------------------------------
-- Timetable validation (used when a trip becomes SCHEDULED)
-- ---------------------------------------------------------------------------

-- Returns NULL when the timetable of p_trip is complete and valid for
-- p_version, otherwise the reason. Rules:
-- - exactly one timing per waypoint of the route version, same sequence;
-- - first waypoint: departure only; last waypoint: arrival only;
--   intermediate waypoints: arrival <= departure;
-- - each arrival strictly after the previous waypoint's departure;
-- - the trip departure/arrival equal the first departure/last arrival.
CREATE FUNCTION "trip_timetable_error"(
  p_trip UUID,
  p_version UUID,
  p_departure TIMESTAMPTZ,
  p_arrival TIMESTAMPTZ
) RETURNS TEXT
LANGUAGE plpgsql STABLE AS $$
DECLARE
  expected INTEGER;
  first_sequence INTEGER;
  last_sequence INTEGER;
  total INTEGER;
  matched INTEGER;
  timing RECORD;
  previous_departure TIMESTAMPTZ;
BEGIN
  SELECT count(*), min("sequence"), max("sequence")
    INTO expected, first_sequence, last_sequence
  FROM "route_waypoint" WHERE "route_version_id" = p_version;

  SELECT count(*) INTO total FROM "trip_waypoint_timing" WHERE "trip_id" = p_trip;

  SELECT count(*) INTO matched
  FROM "trip_waypoint_timing" t
  JOIN "route_waypoint" w ON w."id" = t."route_waypoint_id"
  WHERE t."trip_id" = p_trip
    AND w."route_version_id" = p_version
    AND w."sequence" = t."sequence";

  IF expected < 2 OR total <> expected OR matched <> expected THEN
    RETURN 'the timetable must cover exactly the waypoints of the route version';
  END IF;

  FOR timing IN
    SELECT "sequence", "planned_arrival_at" AS arrival, "planned_departure_at" AS departure
    FROM "trip_waypoint_timing" WHERE "trip_id" = p_trip ORDER BY "sequence"
  LOOP
    IF timing."sequence" = first_sequence THEN
      IF timing.arrival IS NOT NULL OR timing.departure IS NULL THEN
        RETURN 'the first waypoint has a departure time only';
      END IF;
      IF p_departure IS DISTINCT FROM timing.departure THEN
        RETURN 'the trip departure must equal the first waypoint departure';
      END IF;
    ELSIF timing."sequence" = last_sequence THEN
      IF timing.arrival IS NULL OR timing.departure IS NOT NULL THEN
        RETURN 'the last waypoint has an arrival time only';
      END IF;
      IF p_arrival IS DISTINCT FROM timing.arrival THEN
        RETURN 'the trip arrival must equal the last waypoint arrival';
      END IF;
    ELSIF timing.arrival IS NULL OR timing.departure IS NULL OR timing.arrival > timing.departure THEN
      RETURN 'an intermediate waypoint needs an arrival at or before its departure';
    END IF;
    IF previous_departure IS NOT NULL AND timing.arrival <= previous_departure THEN
      RETURN 'waypoint times must be chronological';
    END IF;
    previous_departure := timing.departure;
  END LOOP;

  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Trip lifecycle protection
-- ---------------------------------------------------------------------------

-- - created as DRAFT, on a route version that has been published (it may be
--   retired later without affecting the trip);
-- - id, reference, route version and creation date are immutable;
-- - transitions: DRAFT -> SCHEDULED | CANCELLED, SCHEDULED -> CANCELLED;
--   CANCELLED is terminal and frozen;
-- - planned times and scheduled_at are frozen once the trip leaves DRAFT;
-- - DRAFT -> SCHEDULED requires a complete, valid timetable;
-- - an assigned vehicle must be ACTIVE when assigned and when scheduling
--   (it is locked FOR SHARE, serializing with fleet status changes). A later
--   fleet status change is not blocked: Dispatch will handle that conflict;
-- - trips are never deleted.
CREATE FUNCTION "trip_lifecycle_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  version_published TIMESTAMPTZ;
  vehicle_state "vehicle_status";
  timetable_error TEXT;
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

    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
      (OLD."status" = 'DRAFT' AND NEW."status" IN ('SCHEDULED', 'CANCELLED'))
      OR (OLD."status" = 'SCHEDULED' AND NEW."status" = 'CANCELLED')
    ) THEN
      RAISE EXCEPTION 'invalid trip status transition from % to %', OLD."status", NEW."status"
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

    IF OLD."status" = 'DRAFT' AND NEW."status" = 'SCHEDULED' THEN
      timetable_error := "trip_timetable_error"(
        NEW."id", NEW."route_version_id", NEW."planned_departure_at", NEW."planned_arrival_at"
      );
      IF timetable_error IS NOT NULL THEN
        RAISE EXCEPTION 'cannot schedule trip: %', timetable_error
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW."vehicle_id" IS NOT NULL AND (
    TG_OP = 'INSERT'
    OR NEW."vehicle_id" IS DISTINCT FROM OLD."vehicle_id"
    OR (OLD."status" = 'DRAFT' AND NEW."status" = 'SCHEDULED')
  ) THEN
    SELECT "status" INTO vehicle_state FROM "vehicle" WHERE "id" = NEW."vehicle_id" FOR SHARE;
    IF FOUND AND vehicle_state <> 'ACTIVE' THEN
      RAISE EXCEPTION 'an assigned vehicle must be ACTIVE'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "trip_lifecycle_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "trip"
  FOR EACH ROW EXECUTE FUNCTION "trip_lifecycle_guard"();

-- ---------------------------------------------------------------------------
-- Timetable protection
-- ---------------------------------------------------------------------------

-- A timing can be written only while its trip is DRAFT. The trip row is
-- locked FOR UPDATE, so timetable writes and scheduling are serialized. A
-- timing references a waypoint of the trip's route version, with the same
-- sequence.
CREATE FUNCTION "trip_waypoint_timing_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_id UUID;
  parent_status "trip_status";
  parent_version UUID;
  waypoint_version UUID;
  waypoint_sequence INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."id" IS DISTINCT FROM OLD."id" OR NEW."trip_id" IS DISTINCT FROM OLD."trip_id"
  ) THEN
    RAISE EXCEPTION 'timing identity and trip are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    parent_id := OLD."trip_id";
  ELSE
    parent_id := NEW."trip_id";
  END IF;

  SELECT "status", "route_version_id" INTO parent_status, parent_version
  FROM "trip" WHERE "id" = parent_id
  FOR UPDATE;

  IF FOUND AND parent_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'the timetable of a scheduled or cancelled trip is immutable'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  SELECT "route_version_id", "sequence" INTO waypoint_version, waypoint_sequence
  FROM "route_waypoint" WHERE "id" = NEW."route_waypoint_id";

  IF FOUND AND parent_version IS NOT NULL THEN
    IF waypoint_version <> parent_version THEN
      RAISE EXCEPTION 'a timing must reference a waypoint of the trip route version'
        USING ERRCODE = 'check_violation';
    END IF;
    IF waypoint_sequence <> NEW."sequence" THEN
      RAISE EXCEPTION 'a timing sequence must match its route waypoint'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "trip_waypoint_timing_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "trip_waypoint_timing"
  FOR EACH ROW EXECUTE FUNCTION "trip_waypoint_timing_guard"();

-- Row-level DELETE triggers do not fire for TRUNCATE.
CREATE FUNCTION "trip_history_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'trip history cannot be truncated'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "trip_no_truncate"
  BEFORE TRUNCATE ON "trip"
  FOR EACH STATEMENT EXECUTE FUNCTION "trip_history_no_truncate"();
CREATE TRIGGER "trip_waypoint_timing_no_truncate"
  BEFORE TRUNCATE ON "trip_waypoint_timing"
  FOR EACH STATEMENT EXECUTE FUNCTION "trip_history_no_truncate"();

-- ---------------------------------------------------------------------------
-- Authorization catalogue
-- ---------------------------------------------------------------------------

-- Every trip.manage holder already holds network.read and fleet.read, needed
-- to choose a route version and a vehicle.
INSERT INTO "authorization_permission" ("key", "description") VALUES
  ('trip.read', 'Read trips, their timetable and assigned vehicle'),
  ('trip.manage', 'Create trips, edit draft timetables, schedule, cancel and assign vehicles');

INSERT INTO "authorization_role_permission" ("role_key", "permission_key") VALUES
  ('SUPER_ADMIN', 'trip.read'),
  ('SUPER_ADMIN', 'trip.manage'),
  ('DIRECTOR', 'trip.read'),
  ('DIRECTOR', 'trip.manage'),
  ('OPS_MANAGER', 'trip.read'),
  ('OPS_MANAGER', 'trip.manage'),
  ('DISPATCHER', 'trip.read'),
  ('DISPATCHER', 'trip.manage'),
  ('BOOKING_AGENT', 'trip.read'),
  ('COMPLIANCE_AGENT', 'trip.read'),
  ('CUSTOMER_SUPPORT', 'trip.read'),
  ('AUDITOR', 'trip.read');
