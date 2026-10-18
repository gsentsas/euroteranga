-- FLEET-1: operational vehicle name and vehicle availability across trips.
--
-- 1. A vehicle may carry an operational name (e.g. "Teranga 01"), unique when
--    present, trimmed and non-empty.
-- 2. A vehicle never serves two trips whose planned windows overlap. The
--    check runs when a trip becomes SCHEDULED, or when the vehicle or the
--    planned window of a SCHEDULED trip changes. Trips already in progress
--    are not re-judged, so historical overlaps never block a departure.

-- AlterTable
ALTER TABLE "vehicle" ADD COLUMN "name" VARCHAR(80);

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_name_key" ON "vehicle"("name");

ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_name_format_check"
  CHECK ("name" IS NULL OR ("name" = btrim("name") AND char_length("name") >= 1));

CREATE FUNCTION "trip_vehicle_availability_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  conflicting_reference TEXT;
BEGIN
  IF NEW."status" <> 'SCHEDULED'
     OR NEW."vehicle_id" IS NULL
     OR NEW."planned_departure_at" IS NULL
     OR NEW."planned_arrival_at" IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'SCHEDULED'
     AND OLD."vehicle_id" IS NOT DISTINCT FROM NEW."vehicle_id"
     AND OLD."planned_departure_at" IS NOT DISTINCT FROM NEW."planned_departure_at"
     AND OLD."planned_arrival_at" IS NOT DISTINCT FROM NEW."planned_arrival_at" THEN
    RETURN NEW;
  END IF;

  -- One availability decision per vehicle at a time (same key as the API).
  PERFORM pg_advisory_xact_lock(hashtextextended('trip-vehicle:' || NEW."vehicle_id"::text, 0));

  SELECT t."reference" INTO conflicting_reference
  FROM "trip" t
  WHERE t."vehicle_id" = NEW."vehicle_id"
    AND t."id" <> NEW."id"
    AND t."status" IN ('SCHEDULED', 'IN_PROGRESS')
    AND t."planned_departure_at" < NEW."planned_arrival_at"
    AND t."planned_arrival_at" > NEW."planned_departure_at"
  ORDER BY t."planned_departure_at", t."id"
  LIMIT 1;

  IF conflicting_reference IS NOT NULL THEN
    RAISE EXCEPTION 'vehicle is already assigned to the overlapping trip %', conflicting_reference;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trip_vehicle_availability_guard"
  BEFORE UPDATE ON "trip"
  FOR EACH ROW EXECUTE FUNCTION "trip_vehicle_availability_guard"();
