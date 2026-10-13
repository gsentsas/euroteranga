-- PR-05 Fleet core: the vehicle registry and its lifecycle.
--
-- The Prisma-shaped DDL is followed by PostgreSQL constraints and triggers
-- for invariants that must also hold for direct database writes. No real
-- vehicle, VIN or registration plate is seeded here.
-- CreateEnum
CREATE TYPE "vehicle_status" AS ENUM ('PLANNED', 'ACTIVE', 'OUT_OF_SERVICE', 'RETIRED');

-- CreateTable
CREATE TABLE "vehicle" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "vin" VARCHAR(17),
    "registration_plate" VARCHAR(16),
    "registration_country_id" UUID,
    "manufacturer" VARCHAR(80) NOT NULL,
    "model" VARCHAR(80) NOT NULL,
    "model_year" INTEGER,
    "status" "vehicle_status" NOT NULL DEFAULT 'PLANNED',
    "status_changed_at" TIMESTAMPTZ(3),
    "retired_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_code_key" ON "vehicle"("code");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_vin_key" ON "vehicle"("vin");

-- CreateIndex
CREATE INDEX "vehicle_status_id_idx" ON "vehicle"("status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_registration_country_id_registration_plate_key" ON "vehicle"("registration_country_id", "registration_plate");

-- AddForeignKey
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_registration_country_id_fkey" FOREIGN KEY ("registration_country_id") REFERENCES "country"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Row-local invariants
-- ---------------------------------------------------------------------------

ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_code_normalized"
  CHECK ("code" = upper(btrim("code")) AND "code" ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$');

-- Shape only: 17 characters from the VIN alphabet (no I, O or Q). The check
-- digit and the national rules are deliberately not validated.
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_vin_shape"
  CHECK ("vin" IS NULL OR "vin" ~ '^[A-HJ-NPR-Z0-9]{17}$');

-- Plate formats differ per country: no worldwide pattern. The value must be
-- trimmed, uppercase, without control characters or repeated spaces, and is
-- only meaningful together with its registration country.
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_registration_plate_normalized"
  CHECK (
    "registration_plate" IS NULL
    OR (
      "registration_plate" = upper(btrim("registration_plate"))
      AND length("registration_plate") BETWEEN 1 AND 16
      AND "registration_plate" !~ '[[:cntrl:]]'
      AND "registration_plate" !~ '\s\s'
    )
  );
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_registration_complete"
  CHECK (("registration_plate" IS NULL) = ("registration_country_id" IS NULL));

ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_manufacturer_normalized"
  CHECK (length(btrim("manufacturer")) > 0 AND "manufacturer" = btrim("manufacturer"));
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_model_normalized"
  CHECK (length(btrim("model")) > 0 AND "model" = btrim("model"));
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_model_year_range"
  CHECK ("model_year" IS NULL OR "model_year" BETWEEN 1950 AND 2100);

ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_retired_at_consistent"
  CHECK (("status" = 'RETIRED') = ("retired_at" IS NOT NULL));

-- ---------------------------------------------------------------------------
-- Lifecycle protection
-- ---------------------------------------------------------------------------

-- A vehicle is created as PLANNED. Its identity never changes. Status changes
-- follow the transition matrix below; RETIRED is terminal and a retired row is
-- frozen. Vehicles are never physically deleted: audit events and future
-- trips refer to them.
CREATE FUNCTION "vehicle_lifecycle_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PLANNED' THEN
      RAISE EXCEPTION 'vehicles must be created as PLANNED'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'vehicles cannot be deleted; retire them instead'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'vehicle identity is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" = 'RETIRED' THEN
    RAISE EXCEPTION 'retired vehicles are immutable'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'PLANNED' AND NEW."status" IN ('ACTIVE', 'RETIRED'))
    OR (OLD."status" = 'ACTIVE' AND NEW."status" IN ('OUT_OF_SERVICE', 'RETIRED'))
    OR (OLD."status" = 'OUT_OF_SERVICE' AND NEW."status" IN ('ACTIVE', 'RETIRED'))
  ) THEN
    RAISE EXCEPTION 'invalid vehicle status transition from % to %', OLD."status", NEW."status"
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "vehicle_lifecycle_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "vehicle"
  FOR EACH ROW EXECUTE FUNCTION "vehicle_lifecycle_guard"();

-- Row-level DELETE triggers do not fire for TRUNCATE.
CREATE FUNCTION "vehicle_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the vehicle registry cannot be truncated'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "vehicle_no_truncate"
  BEFORE TRUNCATE ON "vehicle"
  FOR EACH STATEMENT EXECUTE FUNCTION "vehicle_no_truncate"();

-- ---------------------------------------------------------------------------
-- Authorization catalogue
-- ---------------------------------------------------------------------------

INSERT INTO "authorization_permission" ("key", "description") VALUES
  ('fleet.read', 'Read the vehicle registry'),
  ('fleet.manage', 'Register vehicles, edit their administrative data and change their status');

INSERT INTO "authorization_role_permission" ("role_key", "permission_key") VALUES
  ('SUPER_ADMIN', 'fleet.read'),
  ('SUPER_ADMIN', 'fleet.manage'),
  ('DIRECTOR', 'fleet.read'),
  ('DIRECTOR', 'fleet.manage'),
  ('OPS_MANAGER', 'fleet.read'),
  ('OPS_MANAGER', 'fleet.manage'),
  ('DISPATCHER', 'fleet.read'),
  ('COMPLIANCE_AGENT', 'fleet.read'),
  ('AUDITOR', 'fleet.read');
