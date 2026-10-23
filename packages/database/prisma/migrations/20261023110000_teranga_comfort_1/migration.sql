-- TERANGA-COMFORT-1: append-only operational status for traveller-visible journey waypoints.
-- TERANGA-STOPS remains the authority for checkpoint kind/facilities/visibility.
-- PLANNED is derived when no explicit event exists.

CREATE TYPE "comfort_waypoint_event_type" AS ENUM ('CONFIRMED', 'COMPLETED', 'CANCELLED', 'SKIPPED');

CREATE TABLE "comfort_waypoint_event" (
  "id" UUID NOT NULL,
  "trip_id" UUID NOT NULL,
  "route_waypoint_id" UUID NOT NULL,
  "type" "comfort_waypoint_event_type" NOT NULL,
  "actual_facilities" "teranga_facility"[] NOT NULL DEFAULT ARRAY[]::"teranga_facility"[],
  "client_event_id" VARCHAR(64) NOT NULL,
  "payload_fingerprint" CHAR(64) NOT NULL,
  "occurred_at" TIMESTAMPTZ(3) NOT NULL,
  "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recorded_by_identity_id" UUID NOT NULL,
  CONSTRAINT "comfort_waypoint_event_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "comfort_waypoint_event_trip_id_client_event_id_key"
  ON "comfort_waypoint_event"("trip_id", "client_event_id");
CREATE INDEX "comfort_waypoint_event_trip_id_route_waypoint_id_recorded_a_idx"
  ON "comfort_waypoint_event"("trip_id", "route_waypoint_id", "recorded_at", "id");
CREATE INDEX "comfort_waypoint_event_route_waypoint_id_idx"
  ON "comfort_waypoint_event"("route_waypoint_id");
CREATE INDEX "comfort_waypoint_event_recorded_by_identity_id_idx"
  ON "comfort_waypoint_event"("recorded_by_identity_id");

ALTER TABLE "comfort_waypoint_event"
  ADD CONSTRAINT "comfort_waypoint_event_trip_id_fkey"
  FOREIGN KEY ("trip_id") REFERENCES "trip"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "comfort_waypoint_event_route_waypoint_id_fkey"
  FOREIGN KEY ("route_waypoint_id") REFERENCES "route_waypoint"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "comfort_waypoint_event_recorded_by_identity_id_fkey"
  FOREIGN KEY ("recorded_by_identity_id") REFERENCES "auth_identity"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "comfort_waypoint_event_fingerprint_format"
  CHECK ("payload_fingerprint" ~ '^[0-9a-f]{64}$');

CREATE FUNCTION "comfort_waypoint_event_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  trip_row RECORD;
  waypoint_row RECORD;
  latest RECORD;
BEGIN
  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'comfort waypoint events are append-only'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT t."route_version_id", t."status"
    INTO trip_row
  FROM "trip" t
  WHERE t."id" = NEW."trip_id"
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'comfort trip does not exist'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF trip_row."status" NOT IN ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED') THEN
    RAISE EXCEPTION 'comfort events require a scheduled, in-progress or completed trip'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT rw."id", rw."checkpoint_id"
    INTO waypoint_row
  FROM "route_waypoint" rw
  WHERE rw."id" = NEW."route_waypoint_id"
    AND rw."route_version_id" = trip_row."route_version_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'comfort waypoint must belong to the trip route version'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."type" <> 'COMPLETED' AND cardinality(NEW."actual_facilities") > 0 THEN
    RAISE EXCEPTION 'actual comfort facilities are allowed only on COMPLETED events'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."type" = 'COMPLETED'
     AND trip_row."status" NOT IN ('IN_PROGRESS', 'COMPLETED') THEN
    RAISE EXCEPTION 'a waypoint cannot be completed before the trip starts'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT e."type"
    INTO latest
  FROM "comfort_waypoint_event" e
  WHERE e."trip_id" = NEW."trip_id"
    AND e."route_waypoint_id" = NEW."route_waypoint_id"
  ORDER BY e."recorded_at" DESC, e."id" DESC
  LIMIT 1;

  IF FOUND THEN
    IF latest."type" IN ('COMPLETED', 'CANCELLED', 'SKIPPED') THEN
      RAISE EXCEPTION 'comfort waypoint terminal status is immutable'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF latest."type" = 'CONFIRMED' AND NEW."type" = 'CONFIRMED' THEN
      RAISE EXCEPTION 'comfort waypoint is already confirmed'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "comfort_waypoint_event_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "comfort_waypoint_event"
  FOR EACH ROW EXECUTE FUNCTION "comfort_waypoint_event_guard"();

CREATE FUNCTION "comfort_waypoint_event_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'comfort waypoint history cannot be truncated'
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;

CREATE TRIGGER "comfort_waypoint_event_no_truncate"
  BEFORE TRUNCATE ON "comfort_waypoint_event"
  FOR EACH STATEMENT EXECUTE FUNCTION "comfort_waypoint_event_no_truncate"();
