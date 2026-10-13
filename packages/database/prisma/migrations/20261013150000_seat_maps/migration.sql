-- PR-07 Seat maps: versioned physical layouts, the seat map currently
-- configured on a vehicle and the historical seat map of a trip.
--
-- The Prisma-shaped DDL is followed by PostgreSQL constraints and triggers
-- for invariants that must also hold for direct database writes. No seat map
-- is seeded. Existing trips and vehicles get no seat map (NULL) and stay
-- valid. Capacity is never stored: it is the number of SEAT cells.
-- CreateEnum
CREATE TYPE "seat_map_version_status" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "seat_map_cell_kind" AS ENUM ('SEAT', 'AISLE', 'DRIVER', 'DOOR', 'TOILET', 'STAIRS', 'OTHER');

-- AlterTable
ALTER TABLE "trip" ADD COLUMN     "seat_map_version_id" UUID;

-- AlterTable
ALTER TABLE "vehicle" ADD COLUMN     "seat_map_version_id" UUID;

-- CreateTable
CREATE TABLE "seat_map" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "seat_map_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seat_map_version" (
    "id" UUID NOT NULL,
    "seat_map_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "seat_map_version_status" NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMPTZ(3),
    "retired_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "seat_map_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seat_map_cell" (
    "id" UUID NOT NULL,
    "seat_map_version_id" UUID NOT NULL,
    "deck" INTEGER NOT NULL,
    "row_number" INTEGER NOT NULL,
    "column_number" INTEGER NOT NULL,
    "kind" "seat_map_cell_kind" NOT NULL,
    "seat_label" VARCHAR(8),

    CONSTRAINT "seat_map_cell_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "seat_map_code_key" ON "seat_map"("code");

-- CreateIndex
CREATE INDEX "seat_map_active_id_idx" ON "seat_map"("active", "id");

-- CreateIndex
CREATE INDEX "seat_map_version_status_idx" ON "seat_map_version"("status");

-- CreateIndex
CREATE UNIQUE INDEX "seat_map_version_seat_map_id_version_key" ON "seat_map_version"("seat_map_id", "version");

-- CreateIndex
CREATE INDEX "seat_map_cell_seat_map_version_id_kind_idx" ON "seat_map_cell"("seat_map_version_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "seat_map_cell_seat_map_version_id_deck_row_number_column_nu_key" ON "seat_map_cell"("seat_map_version_id", "deck", "row_number", "column_number");

-- CreateIndex
CREATE UNIQUE INDEX "seat_map_cell_seat_map_version_id_seat_label_key" ON "seat_map_cell"("seat_map_version_id", "seat_label");

-- CreateIndex
CREATE INDEX "trip_seat_map_version_id_idx" ON "trip"("seat_map_version_id");

-- CreateIndex
CREATE INDEX "vehicle_seat_map_version_id_idx" ON "vehicle"("seat_map_version_id");

-- AddForeignKey
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_seat_map_version_id_fkey" FOREIGN KEY ("seat_map_version_id") REFERENCES "seat_map_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip" ADD CONSTRAINT "trip_seat_map_version_id_fkey" FOREIGN KEY ("seat_map_version_id") REFERENCES "seat_map_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seat_map_version" ADD CONSTRAINT "seat_map_version_seat_map_id_fkey" FOREIGN KEY ("seat_map_id") REFERENCES "seat_map"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seat_map_cell" ADD CONSTRAINT "seat_map_cell_seat_map_version_id_fkey" FOREIGN KEY ("seat_map_version_id") REFERENCES "seat_map_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Row-local invariants
-- ---------------------------------------------------------------------------

ALTER TABLE "seat_map" ADD CONSTRAINT "seat_map_code_normalized"
  CHECK ("code" = upper(btrim("code")) AND "code" ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$');
ALTER TABLE "seat_map" ADD CONSTRAINT "seat_map_name_normalized"
  CHECK (length(btrim("name")) > 0 AND "name" = btrim("name"));

ALTER TABLE "seat_map_version" ADD CONSTRAINT "seat_map_version_number_positive"
  CHECK ("version" > 0);
ALTER TABLE "seat_map_version" ADD CONSTRAINT "seat_map_version_status_timestamps"
  CHECK (
    ("status" = 'DRAFT' AND "published_at" IS NULL AND "retired_at" IS NULL)
    OR ("status" = 'PUBLISHED' AND "published_at" IS NOT NULL AND "retired_at" IS NULL)
    OR (
      "status" = 'RETIRED'
      AND "published_at" IS NOT NULL
      AND "retired_at" IS NOT NULL
      AND "retired_at" >= "published_at"
    )
  );

-- Coordinates are 1-based. Bounds against abuse: 4 decks, 100 rows,
-- 20 columns per deck.
ALTER TABLE "seat_map_cell" ADD CONSTRAINT "seat_map_cell_coordinates_range"
  CHECK (
    "deck" BETWEEN 1 AND 4
    AND "row_number" BETWEEN 1 AND 100
    AND "column_number" BETWEEN 1 AND 20
  );
-- A SEAT has a label; any other kind has none.
ALTER TABLE "seat_map_cell" ADD CONSTRAINT "seat_map_cell_label_for_seats"
  CHECK (("kind" = 'SEAT') = ("seat_label" IS NOT NULL));
-- No worldwide numbering convention: trimmed, uppercase, 1-8 characters.
ALTER TABLE "seat_map_cell" ADD CONSTRAINT "seat_map_cell_label_normalized"
  CHECK ("seat_label" IS NULL OR "seat_label" ~ '^[A-Z0-9][A-Z0-9-]{0,7}$');

-- At most one DRAFT and one PUBLISHED version per seat map.
CREATE UNIQUE INDEX "seat_map_version_one_draft_per_seat_map"
  ON "seat_map_version"("seat_map_id") WHERE "status" = 'DRAFT';
CREATE UNIQUE INDEX "seat_map_version_one_published_per_seat_map"
  ON "seat_map_version"("seat_map_id") WHERE "status" = 'PUBLISHED';

-- ---------------------------------------------------------------------------
-- Version lifecycle and historical immutability
-- ---------------------------------------------------------------------------

-- A version is created as DRAFT; its identity never changes. DRAFT ->
-- PUBLISHED requires an active seat map and at least one SEAT; PUBLISHED ->
-- RETIRED keeps the publication date; RETIRED is frozen. Published or retired
-- versions are never deleted.
CREATE FUNCTION "seat_map_version_history_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_active BOOLEAN;
  seats INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'seat map versions must be created as DRAFT'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'published or retired seat map versions are immutable'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."seat_map_id" IS DISTINCT FROM OLD."seat_map_id"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'seat map version identity is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" = 'RETIRED' THEN
    RAISE EXCEPTION 'retired seat map versions are immutable'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF OLD."status" = 'PUBLISHED' THEN
    IF NEW."status" <> 'RETIRED'
       OR NEW."published_at" IS DISTINCT FROM OLD."published_at"
       OR NEW."retired_at" IS NULL THEN
      RAISE EXCEPTION 'a published seat map version may only transition to RETIRED'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."status" NOT IN ('DRAFT', 'PUBLISHED') THEN
    RAISE EXCEPTION 'a draft seat map version may only transition to PUBLISHED'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF NEW."status" = 'PUBLISHED' THEN
    SELECT "active" INTO parent_active FROM "seat_map" WHERE "id" = NEW."seat_map_id";
    IF NOT COALESCE(parent_active, false) THEN
      RAISE EXCEPTION 'an inactive seat map cannot publish a version'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO seats
    FROM "seat_map_cell" WHERE "seat_map_version_id" = NEW."id" AND "kind" = 'SEAT';
    IF seats < 1 THEN
      RAISE EXCEPTION 'a seat map version needs at least one SEAT to be published'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "seat_map_version_history_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "seat_map_version"
  FOR EACH ROW EXECUTE FUNCTION "seat_map_version_history_guard"();

-- Cells can be written only while their version is DRAFT. The version row is
-- locked FOR UPDATE, so cell writes and publication are serialized. The id
-- and the version of a cell never change.
CREATE FUNCTION "seat_map_cell_draft_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_id UUID;
  parent_status "seat_map_version_status";
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."seat_map_version_id" IS DISTINCT FROM OLD."seat_map_version_id"
  ) THEN
    RAISE EXCEPTION 'seat map cell identity and version are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    parent_id := OLD."seat_map_version_id";
  ELSE
    parent_id := NEW."seat_map_version_id";
  END IF;

  SELECT "status" INTO parent_status
  FROM "seat_map_version" WHERE "id" = parent_id
  FOR UPDATE;

  IF FOUND AND parent_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'cells of published or retired seat map versions are immutable'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "seat_map_cell_draft_only"
  BEFORE INSERT OR UPDATE OR DELETE ON "seat_map_cell"
  FOR EACH ROW EXECUTE FUNCTION "seat_map_cell_draft_only"();

-- Row-level DELETE triggers do not fire for TRUNCATE.
CREATE FUNCTION "seat_map_history_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'seat map history cannot be truncated'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "seat_map_version_no_truncate"
  BEFORE TRUNCATE ON "seat_map_version"
  FOR EACH STATEMENT EXECUTE FUNCTION "seat_map_history_no_truncate"();
CREATE TRIGGER "seat_map_cell_no_truncate"
  BEFORE TRUNCATE ON "seat_map_cell"
  FOR EACH STATEMENT EXECUTE FUNCTION "seat_map_history_no_truncate"();

-- ---------------------------------------------------------------------------
-- Vehicle: currently configured seat map
-- ---------------------------------------------------------------------------

-- A vehicle can only be configured with a version that has been published.
-- Retiring that version later does not affect the vehicle (no re-check).
-- The fleet lifecycle trigger still freezes RETIRED vehicles.
CREATE FUNCTION "vehicle_seat_map_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  version_published TIMESTAMPTZ;
BEGIN
  IF NEW."seat_map_version_id" IS NOT NULL AND (
    TG_OP = 'INSERT' OR NEW."seat_map_version_id" IS DISTINCT FROM OLD."seat_map_version_id"
  ) THEN
    SELECT "published_at" INTO version_published
    FROM "seat_map_version" WHERE "id" = NEW."seat_map_version_id";
    IF FOUND AND version_published IS NULL THEN
      RAISE EXCEPTION 'a vehicle seat map must be a version that has been published'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "vehicle_seat_map_guard"
  BEFORE INSERT OR UPDATE ON "vehicle"
  FOR EACH ROW EXECUTE FUNCTION "vehicle_seat_map_guard"();

-- ---------------------------------------------------------------------------
-- Trip: historical seat map (extends the PR-06 lifecycle guard)
-- ---------------------------------------------------------------------------

-- Added to the PR-06 rules (unchanged otherwise):
-- - the seat map changes only while the trip stays DRAFT; it is frozen by
--   scheduling and cancellation;
-- - an assigned seat map version must have been published;
-- - when the trip carries a seat map and a vehicle, the vehicle must be
--   configured with exactly that version. Checked when the vehicle or the
--   seat map of the trip changes and when it is scheduled. A later change
--   of the vehicle's configuration does not touch existing trips.
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

    seat_map_changed := NEW."seat_map_version_id" IS DISTINCT FROM OLD."seat_map_version_id";
    IF seat_map_changed AND NOT (OLD."status" = 'DRAFT' AND NEW."status" = 'DRAFT') THEN
      RAISE EXCEPTION 'the seat map of a scheduled or cancelled trip is frozen'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    vehicle_changed := NEW."vehicle_id" IS DISTINCT FROM OLD."vehicle_id";
    scheduling := OLD."status" = 'DRAFT' AND NEW."status" = 'SCHEDULED';

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

  IF NEW."vehicle_id" IS NOT NULL AND (vehicle_changed OR seat_map_changed OR scheduling) THEN
    SELECT "status", "seat_map_version_id" INTO vehicle_state, vehicle_seat_map
    FROM "vehicle" WHERE "id" = NEW."vehicle_id" FOR SHARE;
    IF FOUND THEN
      IF (vehicle_changed OR scheduling) AND vehicle_state <> 'ACTIVE' THEN
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

-- ---------------------------------------------------------------------------
-- Authorization catalogue
-- ---------------------------------------------------------------------------

-- Every fleet.manage and trip.manage holder also holds seatmap.read, needed
-- to choose a published version for a vehicle or a trip.
INSERT INTO "authorization_permission" ("key", "description") VALUES
  ('seatmap.read', 'Read seat maps, their versions, cells and capacity'),
  ('seatmap.manage', 'Create seat maps, edit draft layouts and publish versions');

INSERT INTO "authorization_role_permission" ("role_key", "permission_key") VALUES
  ('SUPER_ADMIN', 'seatmap.read'),
  ('SUPER_ADMIN', 'seatmap.manage'),
  ('DIRECTOR', 'seatmap.read'),
  ('DIRECTOR', 'seatmap.manage'),
  ('OPS_MANAGER', 'seatmap.read'),
  ('OPS_MANAGER', 'seatmap.manage'),
  ('DISPATCHER', 'seatmap.read'),
  ('BOOKING_AGENT', 'seatmap.read'),
  ('COMPLIANCE_AGENT', 'seatmap.read'),
  ('CUSTOMER_SUPPORT', 'seatmap.read'),
  ('AUDITOR', 'seatmap.read');
