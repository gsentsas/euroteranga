-- PR-08 Pricing: versioned base fare tables and the historical pricing of a
-- trip.
--
-- The Prisma-shaped DDL is followed by PostgreSQL constraints and triggers
-- for invariants that must also hold for direct database writes. Money is
-- an exact integer in the currency's minor unit; no floating point anywhere.
-- No fare is seeded. Existing trips get no pricing (NULL) and stay valid.
-- CreateEnum
CREATE TYPE "fare_table_version_status" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- AlterTable
ALTER TABLE "trip" ADD COLUMN     "fare_table_version_id" UUID;

-- CreateTable
CREATE TABLE "fare_table" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "route_id" UUID NOT NULL,
    "currency_code" VARCHAR(3) NOT NULL,
    "currency_minor_unit" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fare_table_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fare_table_version" (
    "id" UUID NOT NULL,
    "fare_table_id" UUID NOT NULL,
    "route_version_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "fare_table_version_status" NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMPTZ(3),
    "retired_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fare_table_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fare_entry" (
    "id" UUID NOT NULL,
    "fare_table_version_id" UUID NOT NULL,
    "origin_route_waypoint_id" UUID NOT NULL,
    "destination_route_waypoint_id" UUID NOT NULL,
    "amount_minor" INTEGER NOT NULL,

    CONSTRAINT "fare_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fare_table_code_key" ON "fare_table"("code");

-- CreateIndex
CREATE INDEX "fare_table_route_id_idx" ON "fare_table"("route_id");

-- CreateIndex
CREATE INDEX "fare_table_active_id_idx" ON "fare_table"("active", "id");

-- CreateIndex
CREATE INDEX "fare_table_version_route_version_id_idx" ON "fare_table_version"("route_version_id");

-- CreateIndex
CREATE INDEX "fare_table_version_status_idx" ON "fare_table_version"("status");

-- CreateIndex
CREATE UNIQUE INDEX "fare_table_version_fare_table_id_version_key" ON "fare_table_version"("fare_table_id", "version");

-- CreateIndex
CREATE INDEX "fare_entry_origin_route_waypoint_id_idx" ON "fare_entry"("origin_route_waypoint_id");

-- CreateIndex
CREATE INDEX "fare_entry_destination_route_waypoint_id_idx" ON "fare_entry"("destination_route_waypoint_id");

-- CreateIndex
CREATE UNIQUE INDEX "fare_entry_fare_table_version_id_origin_route_waypoint_id_d_key" ON "fare_entry"("fare_table_version_id", "origin_route_waypoint_id", "destination_route_waypoint_id");

-- CreateIndex
CREATE INDEX "trip_fare_table_version_id_idx" ON "trip"("fare_table_version_id");

-- AddForeignKey
ALTER TABLE "trip" ADD CONSTRAINT "trip_fare_table_version_id_fkey" FOREIGN KEY ("fare_table_version_id") REFERENCES "fare_table_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fare_table" ADD CONSTRAINT "fare_table_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fare_table_version" ADD CONSTRAINT "fare_table_version_fare_table_id_fkey" FOREIGN KEY ("fare_table_id") REFERENCES "fare_table"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fare_table_version" ADD CONSTRAINT "fare_table_version_route_version_id_fkey" FOREIGN KEY ("route_version_id") REFERENCES "route_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fare_entry" ADD CONSTRAINT "fare_entry_fare_table_version_id_fkey" FOREIGN KEY ("fare_table_version_id") REFERENCES "fare_table_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fare_entry" ADD CONSTRAINT "fare_entry_origin_route_waypoint_id_fkey" FOREIGN KEY ("origin_route_waypoint_id") REFERENCES "route_waypoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fare_entry" ADD CONSTRAINT "fare_entry_destination_route_waypoint_id_fkey" FOREIGN KEY ("destination_route_waypoint_id") REFERENCES "route_waypoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Row-local invariants
-- ---------------------------------------------------------------------------

ALTER TABLE "fare_table" ADD CONSTRAINT "fare_table_code_normalized"
  CHECK ("code" = upper(btrim("code")) AND "code" ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$');
ALTER TABLE "fare_table" ADD CONSTRAINT "fare_table_name_normalized"
  CHECK (length(btrim("name")) > 0 AND "name" = btrim("name"));
-- Three uppercase letters; no fixed ISO 4217 list.
ALTER TABLE "fare_table" ADD CONSTRAINT "fare_table_currency_code_format"
  CHECK ("currency_code" ~ '^[A-Z]{3}$');
ALTER TABLE "fare_table" ADD CONSTRAINT "fare_table_currency_minor_unit_range"
  CHECK ("currency_minor_unit" BETWEEN 0 AND 3);

ALTER TABLE "fare_table_version" ADD CONSTRAINT "fare_table_version_number_positive"
  CHECK ("version" > 0);
ALTER TABLE "fare_table_version" ADD CONSTRAINT "fare_table_version_status_timestamps"
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

ALTER TABLE "fare_entry" ADD CONSTRAINT "fare_entry_amount_positive"
  CHECK ("amount_minor" > 0);
ALTER TABLE "fare_entry" ADD CONSTRAINT "fare_entry_distinct_waypoints"
  CHECK ("origin_route_waypoint_id" <> "destination_route_waypoint_id");

-- At most one DRAFT and one PUBLISHED version per fare table.
CREATE UNIQUE INDEX "fare_table_version_one_draft_per_fare_table"
  ON "fare_table_version"("fare_table_id") WHERE "status" = 'DRAFT';
CREATE UNIQUE INDEX "fare_table_version_one_published_per_fare_table"
  ON "fare_table_version"("fare_table_id") WHERE "status" = 'PUBLISHED';

-- ---------------------------------------------------------------------------
-- Fare table: economic identity
-- ---------------------------------------------------------------------------

-- The route and the currency (code and minor unit) define what every stored
-- amount means: changing them would silently change all prices. They are
-- immutable; a new currency means a new fare table. Fare tables are never
-- deleted once they have versions (foreign key) and have no deletion API.
CREATE FUNCTION "fare_table_identity_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."route_id" IS DISTINCT FROM OLD."route_id"
     OR NEW."currency_code" IS DISTINCT FROM OLD."currency_code"
     OR NEW."currency_minor_unit" IS DISTINCT FROM OLD."currency_minor_unit"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'fare table route and currency are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "fare_table_identity_guard"
  BEFORE UPDATE ON "fare_table"
  FOR EACH ROW EXECUTE FUNCTION "fare_table_identity_guard"();

-- ---------------------------------------------------------------------------
-- Fare table version: lifecycle and historical immutability
-- ---------------------------------------------------------------------------

-- - created as DRAFT, on a route version of the fare table's route that has
--   already been published (its waypoints are then immutable);
-- - identity (fare table, route version, number) never changes;
-- - DRAFT -> PUBLISHED requires an active fare table and at least one fare;
-- - PUBLISHED -> RETIRED keeps the publication date; RETIRED is frozen;
-- - published or retired versions are never deleted.
CREATE FUNCTION "fare_table_version_history_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  table_route UUID;
  table_active BOOLEAN;
  version_route UUID;
  version_published TIMESTAMPTZ;
  fares INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'published or retired fare table versions are immutable'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'fare table versions must be created as DRAFT'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT "route_id" INTO table_route FROM "fare_table" WHERE "id" = NEW."fare_table_id";
    SELECT "route_id", "published_at" INTO version_route, version_published
    FROM "route_version" WHERE "id" = NEW."route_version_id";
    IF table_route IS NOT NULL AND version_route IS NOT NULL THEN
      IF version_route <> table_route THEN
        RAISE EXCEPTION 'a fare table version must use a route version of the fare table route'
          USING ERRCODE = 'check_violation';
      END IF;
      IF version_published IS NULL THEN
        RAISE EXCEPTION 'a fare table version must use a route version that has been published'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."fare_table_id" IS DISTINCT FROM OLD."fare_table_id"
     OR NEW."route_version_id" IS DISTINCT FROM OLD."route_version_id"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'fare table version identity is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" = 'RETIRED' THEN
    RAISE EXCEPTION 'retired fare table versions are immutable'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF OLD."status" = 'PUBLISHED' THEN
    IF NEW."status" <> 'RETIRED'
       OR NEW."published_at" IS DISTINCT FROM OLD."published_at"
       OR NEW."retired_at" IS NULL THEN
      RAISE EXCEPTION 'a published fare table version may only transition to RETIRED'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."status" NOT IN ('DRAFT', 'PUBLISHED') THEN
    RAISE EXCEPTION 'a draft fare table version may only transition to PUBLISHED'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF NEW."status" = 'PUBLISHED' THEN
    SELECT "active" INTO table_active FROM "fare_table" WHERE "id" = NEW."fare_table_id";
    IF NOT COALESCE(table_active, false) THEN
      RAISE EXCEPTION 'an inactive fare table cannot publish a version'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO fares FROM "fare_entry" WHERE "fare_table_version_id" = NEW."id";
    IF fares < 1 THEN
      RAISE EXCEPTION 'a fare table version needs at least one fare to be published'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "fare_table_version_history_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "fare_table_version"
  FOR EACH ROW EXECUTE FUNCTION "fare_table_version_history_guard"();

-- ---------------------------------------------------------------------------
-- Fare entries: draft-only, valid origin/destination
-- ---------------------------------------------------------------------------

-- Writes only while the version is DRAFT (the version row is locked FOR
-- UPDATE, serializing fare writes with publication). Both waypoints belong
-- to the version's route version and are stops; the origin allows boarding,
-- the destination allows alighting and comes later in the route.
CREATE FUNCTION "fare_entry_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_id UUID;
  parent_status "fare_table_version_status";
  parent_route_version UUID;
  origin RECORD;
  destination RECORD;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."fare_table_version_id" IS DISTINCT FROM OLD."fare_table_version_id"
  ) THEN
    RAISE EXCEPTION 'fare entry identity and version are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    parent_id := OLD."fare_table_version_id";
  ELSE
    parent_id := NEW."fare_table_version_id";
  END IF;

  SELECT "status", "route_version_id" INTO parent_status, parent_route_version
  FROM "fare_table_version" WHERE "id" = parent_id
  FOR UPDATE;

  IF FOUND AND parent_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'fares of published or retired fare table versions are immutable'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  SELECT "route_version_id", "sequence", "stop_id", "boarding_allowed", "alighting_allowed"
    INTO origin
  FROM "route_waypoint" WHERE "id" = NEW."origin_route_waypoint_id";
  SELECT "route_version_id", "sequence", "stop_id", "boarding_allowed", "alighting_allowed"
    INTO destination
  FROM "route_waypoint" WHERE "id" = NEW."destination_route_waypoint_id";

  IF origin."route_version_id" IS NOT NULL AND destination."route_version_id" IS NOT NULL
     AND parent_route_version IS NOT NULL THEN
    IF origin."route_version_id" <> parent_route_version
       OR destination."route_version_id" <> parent_route_version THEN
      RAISE EXCEPTION 'fare waypoints must belong to the fare table version route version'
        USING ERRCODE = 'check_violation';
    END IF;
    IF origin."stop_id" IS NULL OR destination."stop_id" IS NULL THEN
      RAISE EXCEPTION 'fares are defined between stops only'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT origin."boarding_allowed" THEN
      RAISE EXCEPTION 'the fare origin must allow boarding'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT destination."alighting_allowed" THEN
      RAISE EXCEPTION 'the fare destination must allow alighting'
        USING ERRCODE = 'check_violation';
    END IF;
    IF origin."sequence" >= destination."sequence" THEN
      RAISE EXCEPTION 'the fare origin must come before the destination'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "fare_entry_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "fare_entry"
  FOR EACH ROW EXECUTE FUNCTION "fare_entry_guard"();

-- Row-level DELETE triggers do not fire for TRUNCATE.
CREATE FUNCTION "fare_history_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'fare history cannot be truncated'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "fare_table_version_no_truncate"
  BEFORE TRUNCATE ON "fare_table_version"
  FOR EACH STATEMENT EXECUTE FUNCTION "fare_history_no_truncate"();
CREATE TRIGGER "fare_entry_no_truncate"
  BEFORE TRUNCATE ON "fare_entry"
  FOR EACH STATEMENT EXECUTE FUNCTION "fare_history_no_truncate"();

-- ---------------------------------------------------------------------------
-- Trip: historical pricing (extends the PR-06/PR-07 lifecycle guard)
-- ---------------------------------------------------------------------------

-- Added to the PR-06 and PR-07 rules (unchanged otherwise):
-- - the fare table version changes only while the trip stays DRAFT; it is
--   frozen by scheduling and cancellation;
-- - an assigned version must have been published and must price the trip's
--   route version. Retiring it later does not affect the trip.
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

    fare_changed := NEW."fare_table_version_id" IS DISTINCT FROM OLD."fare_table_version_id";
    IF fare_changed AND NOT (OLD."status" = 'DRAFT' AND NEW."status" = 'DRAFT') THEN
      RAISE EXCEPTION 'the pricing of a scheduled or cancelled trip is frozen'
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

-- Every trip.manage holder also holds pricing.read (it assigns fare tables to
-- trips); every pricing.manage holder holds network.read (it picks routes).
INSERT INTO "authorization_permission" ("key", "description") VALUES
  ('pricing.read', 'Read fare tables, their versions and fares, and resolve trip fares'),
  ('pricing.manage', 'Create fare tables, edit draft fares and publish versions');

INSERT INTO "authorization_role_permission" ("role_key", "permission_key") VALUES
  ('SUPER_ADMIN', 'pricing.read'),
  ('SUPER_ADMIN', 'pricing.manage'),
  ('DIRECTOR', 'pricing.read'),
  ('DIRECTOR', 'pricing.manage'),
  ('OPS_MANAGER', 'pricing.read'),
  ('OPS_MANAGER', 'pricing.manage'),
  ('DISPATCHER', 'pricing.read'),
  ('BOOKING_AGENT', 'pricing.read'),
  ('CUSTOMER_SUPPORT', 'pricing.read'),
  ('FINANCE', 'pricing.read'),
  ('AUDITOR', 'pricing.read');
