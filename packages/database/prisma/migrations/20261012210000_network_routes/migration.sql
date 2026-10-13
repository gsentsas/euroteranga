-- PR-04 Network geography and versioned commercial routes.
--
-- The Prisma-shaped DDL is followed by PostgreSQL constraints, partial
-- indexes and triggers for invariants that cannot be represented completely
-- in the Prisma schema. No real route or geographic data is seeded here.

-- CreateEnum
CREATE TYPE "checkpoint_type" AS ENUM ('BORDER', 'FERRY_TERMINAL', 'PORT', 'TECHNICAL');

-- CreateEnum
CREATE TYPE "route_version_status" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateTable
CREATE TABLE "country" (
    "id" UUID NOT NULL,
    "iso2" VARCHAR(2) NOT NULL,
    "iso3" VARCHAR(3) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "country_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stop" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "country_id" UUID NOT NULL,
    "locality" VARCHAR(128) NOT NULL,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "timezone" VARCHAR(64) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkpoint" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "country_id" UUID NOT NULL,
    "type" "checkpoint_type" NOT NULL,
    "locality" VARCHAR(128) NOT NULL,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "timezone" VARCHAR(64) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "checkpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "route_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_version" (
    "id" UUID NOT NULL,
    "route_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "route_version_status" NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMPTZ(3),
    "retired_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "route_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_waypoint" (
    "id" UUID NOT NULL,
    "route_version_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "stop_id" UUID,
    "checkpoint_id" UUID,
    "boarding_allowed" BOOLEAN NOT NULL DEFAULT false,
    "alighting_allowed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "route_waypoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "country_iso2_key" ON "country"("iso2");
CREATE UNIQUE INDEX "country_iso3_key" ON "country"("iso3");
CREATE INDEX "country_active_id_idx" ON "country"("active", "id");

CREATE UNIQUE INDEX "stop_code_key" ON "stop"("code");
CREATE INDEX "stop_country_id_idx" ON "stop"("country_id");
CREATE INDEX "stop_active_id_idx" ON "stop"("active", "id");

CREATE UNIQUE INDEX "checkpoint_code_key" ON "checkpoint"("code");
CREATE INDEX "checkpoint_country_id_idx" ON "checkpoint"("country_id");
CREATE INDEX "checkpoint_type_idx" ON "checkpoint"("type");
CREATE INDEX "checkpoint_active_id_idx" ON "checkpoint"("active", "id");

CREATE UNIQUE INDEX "route_code_key" ON "route"("code");
CREATE INDEX "route_active_id_idx" ON "route"("active", "id");

CREATE UNIQUE INDEX "route_version_route_id_version_key" ON "route_version"("route_id", "version");
CREATE INDEX "route_version_status_idx" ON "route_version"("status");

CREATE UNIQUE INDEX "route_waypoint_route_version_id_sequence_key"
  ON "route_waypoint"("route_version_id", "sequence");
CREATE INDEX "route_waypoint_stop_id_idx" ON "route_waypoint"("stop_id");
CREATE INDEX "route_waypoint_checkpoint_id_idx" ON "route_waypoint"("checkpoint_id");

-- AddForeignKey
ALTER TABLE "stop" ADD CONSTRAINT "stop_country_id_fkey"
  FOREIGN KEY ("country_id") REFERENCES "country"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "checkpoint" ADD CONSTRAINT "checkpoint_country_id_fkey"
  FOREIGN KEY ("country_id") REFERENCES "country"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "route_version" ADD CONSTRAINT "route_version_route_id_fkey"
  FOREIGN KEY ("route_id") REFERENCES "route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "route_waypoint" ADD CONSTRAINT "route_waypoint_route_version_id_fkey"
  FOREIGN KEY ("route_version_id") REFERENCES "route_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "route_waypoint" ADD CONSTRAINT "route_waypoint_stop_id_fkey"
  FOREIGN KEY ("stop_id") REFERENCES "stop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "route_waypoint" ADD CONSTRAINT "route_waypoint_checkpoint_id_fkey"
  FOREIGN KEY ("checkpoint_id") REFERENCES "checkpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Scalar and row-local invariants
-- ---------------------------------------------------------------------------

ALTER TABLE "country" ADD CONSTRAINT "country_iso2_format"
  CHECK ("iso2" ~ '^[A-Z]{2}$');
ALTER TABLE "country" ADD CONSTRAINT "country_iso3_format"
  CHECK ("iso3" ~ '^[A-Z]{3}$');
ALTER TABLE "country" ADD CONSTRAINT "country_name_normalized"
  CHECK (length(btrim("name")) > 0 AND "name" = btrim("name"));

ALTER TABLE "stop" ADD CONSTRAINT "stop_code_normalized"
  CHECK ("code" = upper(btrim("code")) AND "code" ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$');
ALTER TABLE "stop" ADD CONSTRAINT "stop_name_normalized"
  CHECK (length(btrim("name")) > 0 AND "name" = btrim("name"));
ALTER TABLE "stop" ADD CONSTRAINT "stop_locality_normalized"
  CHECK (length(btrim("locality")) > 0 AND "locality" = btrim("locality"));
ALTER TABLE "stop" ADD CONSTRAINT "stop_timezone_normalized"
  CHECK (length(btrim("timezone")) > 0 AND "timezone" = btrim("timezone"));
ALTER TABLE "stop" ADD CONSTRAINT "stop_latitude_range"
  CHECK ("latitude" >= -90 AND "latitude" <= 90);
ALTER TABLE "stop" ADD CONSTRAINT "stop_longitude_range"
  CHECK ("longitude" >= -180 AND "longitude" <= 180);

ALTER TABLE "checkpoint" ADD CONSTRAINT "checkpoint_code_normalized"
  CHECK ("code" = upper(btrim("code")) AND "code" ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$');
ALTER TABLE "checkpoint" ADD CONSTRAINT "checkpoint_name_normalized"
  CHECK (length(btrim("name")) > 0 AND "name" = btrim("name"));
ALTER TABLE "checkpoint" ADD CONSTRAINT "checkpoint_locality_normalized"
  CHECK (length(btrim("locality")) > 0 AND "locality" = btrim("locality"));
ALTER TABLE "checkpoint" ADD CONSTRAINT "checkpoint_timezone_normalized"
  CHECK (length(btrim("timezone")) > 0 AND "timezone" = btrim("timezone"));
ALTER TABLE "checkpoint" ADD CONSTRAINT "checkpoint_latitude_range"
  CHECK ("latitude" >= -90 AND "latitude" <= 90);
ALTER TABLE "checkpoint" ADD CONSTRAINT "checkpoint_longitude_range"
  CHECK ("longitude" >= -180 AND "longitude" <= 180);

ALTER TABLE "route" ADD CONSTRAINT "route_code_normalized"
  CHECK ("code" = upper(btrim("code")) AND "code" ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$');
ALTER TABLE "route" ADD CONSTRAINT "route_name_normalized"
  CHECK (length(btrim("name")) > 0 AND "name" = btrim("name"));

ALTER TABLE "route_version" ADD CONSTRAINT "route_version_number_positive"
  CHECK ("version" > 0);
ALTER TABLE "route_version" ADD CONSTRAINT "route_version_status_timestamps"
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

ALTER TABLE "route_waypoint" ADD CONSTRAINT "route_waypoint_sequence_positive"
  CHECK ("sequence" > 0);
ALTER TABLE "route_waypoint" ADD CONSTRAINT "route_waypoint_exactly_one_location"
  CHECK (num_nonnulls("stop_id", "checkpoint_id") = 1);
ALTER TABLE "route_waypoint" ADD CONSTRAINT "route_waypoint_checkpoint_no_passenger_activity"
  CHECK ("checkpoint_id" IS NULL OR (NOT "boarding_allowed" AND NOT "alighting_allowed"));

-- Concurrent creation/publication cannot leave two active versions in the
-- same lifecycle state. RETIRED history is deliberately unrestricted.
CREATE UNIQUE INDEX "route_version_one_draft_per_route"
  ON "route_version"("route_id") WHERE "status" = 'DRAFT';
CREATE UNIQUE INDEX "route_version_one_published_per_route"
  ON "route_version"("route_id") WHERE "status" = 'PUBLISHED';

-- ---------------------------------------------------------------------------
-- Historical immutability and lifecycle protection
-- ---------------------------------------------------------------------------

-- A version is created as DRAFT. Its identity never changes. Once published,
-- the only legal update is PUBLISHED -> RETIRED with a retirement timestamp;
-- a retired version cannot be changed. Published/retired rows cannot be
-- deleted even if they have no waypoint.
CREATE FUNCTION "route_version_history_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'route versions must be created as DRAFT'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'published or retired route versions are immutable'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."route_id" IS DISTINCT FROM OLD."route_id"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'route version identity is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" = 'RETIRED' THEN
    RAISE EXCEPTION 'retired route versions are immutable'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF OLD."status" = 'PUBLISHED' THEN
    IF NEW."status" <> 'RETIRED'
       OR NEW."published_at" IS DISTINCT FROM OLD."published_at"
       OR NEW."retired_at" IS NULL THEN
      RAISE EXCEPTION 'a published route version may only transition to RETIRED'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."status" NOT IN ('DRAFT', 'PUBLISHED') THEN
    RAISE EXCEPTION 'a draft route version may only transition to PUBLISHED'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "route_version_history_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "route_version"
  FOR EACH ROW EXECUTE FUNCTION "route_version_history_guard"();

-- Locking the parent row serialises waypoint replacement with publication.
-- Both the old and new parent are protected by making route_version_id itself
-- immutable. Missing parents fall through to the foreign-key error.
CREATE FUNCTION "route_waypoint_draft_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_id UUID;
  parent_status "route_version_status";
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."route_version_id" IS DISTINCT FROM OLD."route_version_id"
  ) THEN
    RAISE EXCEPTION 'waypoint identity and route version are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    parent_id := OLD."route_version_id";
  ELSE
    parent_id := NEW."route_version_id";
  END IF;

  SELECT "status" INTO parent_status
  FROM "route_version"
  WHERE "id" = parent_id
  FOR UPDATE;

  IF FOUND AND parent_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'waypoints of published or retired route versions are immutable'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "route_waypoint_draft_only"
  BEFORE INSERT OR UPDATE OR DELETE ON "route_waypoint"
  FOR EACH ROW EXECUTE FUNCTION "route_waypoint_draft_only"();

-- Row-level DELETE triggers do not fire for TRUNCATE. Reject it explicitly so
-- direct SQL cannot bypass the historical protections above.
CREATE FUNCTION "network_history_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'network route history cannot be truncated'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "route_version_no_truncate"
  BEFORE TRUNCATE ON "route_version"
  FOR EACH STATEMENT EXECUTE FUNCTION "network_history_no_truncate"();
CREATE TRIGGER "route_waypoint_no_truncate"
  BEFORE TRUNCATE ON "route_waypoint"
  FOR EACH STATEMENT EXECUTE FUNCTION "network_history_no_truncate"();

-- ---------------------------------------------------------------------------
-- Authorization catalogue
-- ---------------------------------------------------------------------------

INSERT INTO "authorization_permission" ("key", "description") VALUES
  ('network.read', 'Read countries, stops, checkpoints and versioned routes'),
  ('network.manage', 'Manage countries, stops, checkpoints and versioned routes');

INSERT INTO "authorization_role_permission" ("role_key", "permission_key") VALUES
  ('SUPER_ADMIN', 'network.read'),
  ('SUPER_ADMIN', 'network.manage'),
  ('DIRECTOR', 'network.read'),
  ('DIRECTOR', 'network.manage'),
  ('OPS_MANAGER', 'network.read'),
  ('OPS_MANAGER', 'network.manage'),
  ('DISPATCHER', 'network.read'),
  ('BOOKING_AGENT', 'network.read'),
  ('COMPLIANCE_AGENT', 'network.read'),
  ('CUSTOMER_SUPPORT', 'network.read'),
  ('AUDITOR', 'network.read');
