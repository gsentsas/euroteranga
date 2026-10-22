-- CONVOY-1: one optional operational cargo-support vehicle per trip.
--
-- Trip.vehicle_id remains the authoritative primary passenger vehicle.
-- The support vehicle is explicit, optional, distinct from the primary vehicle,
-- and participates in the same cross-trip availability invariant.

ALTER TABLE "trip"
  ADD COLUMN "support_vehicle_id" UUID;

ALTER TABLE "trip"
  ADD CONSTRAINT "trip_support_vehicle_id_fkey"
  FOREIGN KEY ("support_vehicle_id") REFERENCES "vehicle"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "trip"
  ADD CONSTRAINT "trip_support_vehicle_distinct_check"
  CHECK ("support_vehicle_id" IS NULL OR "support_vehicle_id" <> "vehicle_id");

CREATE INDEX "trip_support_vehicle_id_idx" ON "trip"("support_vehicle_id");

-- Preserve historical v1 authorizations while allowing CONVOY-1 readiness v2.
ALTER TABLE "departure_authorization"
  DROP CONSTRAINT "departure_authorization_engine_version";

ALTER TABLE "departure_authorization"
  ADD CONSTRAINT "departure_authorization_engine_version"
  CHECK ("engine_version" IN ('departure-readiness/1', 'departure-readiness/2'));

-- Keep support-vehicle lifecycle invariants authoritative in PostgreSQL too.
-- The API owns the operational reason; the database owns immutability and
-- revalidation of the assigned support at scheduling/departure boundaries.
CREATE FUNCTION "trip_support_vehicle_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  support_changed BOOLEAN;
  scheduling BOOLEAN;
  departing BOOLEAN;
  support_state "vehicle_status";
  support_role "vehicle_role";
  support_payload INTEGER;
  support_volume INTEGER;
BEGIN
  support_changed := NEW."support_vehicle_id" IS DISTINCT FROM OLD."support_vehicle_id";
  scheduling := OLD."status" = 'DRAFT' AND NEW."status" = 'SCHEDULED';
  departing := OLD."status" = 'SCHEDULED' AND NEW."status" = 'IN_PROGRESS';

  IF support_changed AND OLD."status" IN ('IN_PROGRESS', 'COMPLETED', 'CANCELLED') THEN
    RAISE EXCEPTION 'the support vehicle of a dispatched trip is frozen'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF support_changed AND NEW."status" = 'CANCELLED' THEN
    RAISE EXCEPTION 'a trip cannot change support vehicle while being cancelled'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF NEW."support_vehicle_id" IS NOT NULL AND (support_changed OR scheduling OR departing) THEN
    SELECT "status", "role", "payload_capacity_kg", "cargo_volume_liters"
      INTO support_state, support_role, support_payload, support_volume
    FROM "vehicle"
    WHERE "id" = NEW."support_vehicle_id"
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'support vehicle does not exist'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF support_state <> 'ACTIVE' THEN
      RAISE EXCEPTION 'an assigned support vehicle must be ACTIVE'
        USING ERRCODE = 'check_violation';
    END IF;
    IF support_role <> 'CARGO_SUPPORT' THEN
      RAISE EXCEPTION 'an assigned support vehicle must be CARGO_SUPPORT'
        USING ERRCODE = 'check_violation';
    END IF;
    IF support_payload IS NULL OR support_volume IS NULL THEN
      RAISE EXCEPTION 'an assigned support vehicle must have payload and cargo volume configured'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "trip_support_vehicle_guard"
  BEFORE UPDATE OF "support_vehicle_id", "status" ON "trip"
  FOR EACH ROW EXECUTE FUNCTION "trip_support_vehicle_guard"();

CREATE OR REPLACE FUNCTION "trip_vehicle_availability_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  conflicting_reference TEXT;
  candidate_vehicle UUID;
BEGIN
  IF NEW."status" <> 'SCHEDULED'
     OR (NEW."vehicle_id" IS NULL AND NEW."support_vehicle_id" IS NULL)
     OR NEW."planned_departure_at" IS NULL
     OR NEW."planned_arrival_at" IS NULL THEN
    RETURN NEW;
  END IF;

  IF OLD."status" = 'SCHEDULED'
     AND OLD."vehicle_id" IS NOT DISTINCT FROM NEW."vehicle_id"
     AND OLD."support_vehicle_id" IS NOT DISTINCT FROM NEW."support_vehicle_id"
     AND OLD."planned_departure_at" IS NOT DISTINCT FROM NEW."planned_departure_at"
     AND OLD."planned_arrival_at" IS NOT DISTINCT FROM NEW."planned_arrival_at" THEN
    RETURN NEW;
  END IF;

  FOR candidate_vehicle IN
    SELECT DISTINCT id
    FROM (VALUES (NEW."vehicle_id"), (NEW."support_vehicle_id")) AS candidate(id)
    WHERE id IS NOT NULL
    ORDER BY id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('trip-vehicle:' || candidate_vehicle::text, 0));
  END LOOP;

  SELECT t."reference" INTO conflicting_reference
  FROM "trip" t
  WHERE t."id" <> NEW."id"
    AND t."status" IN ('SCHEDULED', 'IN_PROGRESS')
    AND t."planned_departure_at" < NEW."planned_arrival_at"
    AND t."planned_arrival_at" > NEW."planned_departure_at"
    AND (
      (NEW."vehicle_id" IS NOT NULL AND
        (t."vehicle_id" = NEW."vehicle_id" OR t."support_vehicle_id" = NEW."vehicle_id"))
      OR
      (NEW."support_vehicle_id" IS NOT NULL AND
        (t."vehicle_id" = NEW."support_vehicle_id" OR t."support_vehicle_id" = NEW."support_vehicle_id"))
    )
  ORDER BY t."planned_departure_at", t."id"
  LIMIT 1;

  IF conflicting_reference IS NOT NULL THEN
    RAISE EXCEPTION 'vehicle is already assigned to the overlapping trip %', conflicting_reference;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON COLUMN "trip"."support_vehicle_id" IS
  'Optional operational CARGO_SUPPORT vehicle; never a second primary passenger vehicle.';
