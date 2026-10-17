-- PR-20 operational border crossings.
-- This is deliberately operational only: no customs/legal clearance is inferred.

CREATE TYPE "border_event_type" AS ENUM (
  'ARRIVED',
  'CONTROL_STARTED',
  'CONTROL_COMPLETED',
  'DEPARTED'
);

CREATE TYPE "border_event_source" AS ENUM ('STAFF', 'CREW');

CREATE TABLE "border_event" (
  "id" UUID NOT NULL,
  "trip_id" UUID NOT NULL,
  "route_waypoint_id" UUID NOT NULL,
  "type" "border_event_type" NOT NULL,
  "source" "border_event_source" NOT NULL,
  "client_event_id" VARCHAR(64) NOT NULL,
  "payload_fingerprint" CHAR(64) NOT NULL,
  "occurred_at" TIMESTAMPTZ(3) NOT NULL,
  "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recorded_by_identity_id" UUID NOT NULL,
  "crew_assignment_id" UUID,
  "crew_device_id" UUID,
  CONSTRAINT "border_event_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "border_event_trip_id_client_event_id_key" UNIQUE ("trip_id", "client_event_id"),
  CONSTRAINT "border_event_client_event_id_format"
    CHECK ("client_event_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$'),
  CONSTRAINT "border_event_payload_fingerprint_format"
    CHECK ("payload_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "border_event_source_shape"
    CHECK (
      ("source" = 'STAFF' AND "crew_assignment_id" IS NULL AND "crew_device_id" IS NULL)
      OR
      ("source" = 'CREW' AND "crew_assignment_id" IS NOT NULL AND "crew_device_id" IS NOT NULL)
    )
);

CREATE INDEX "border_event_trip_id_route_waypoint_id_recorded_at_id_idx"
  ON "border_event"("trip_id", "route_waypoint_id", "recorded_at", "id");
CREATE INDEX "border_event_route_waypoint_id_idx" ON "border_event"("route_waypoint_id");
CREATE INDEX "border_event_recorded_by_identity_id_idx" ON "border_event"("recorded_by_identity_id");
CREATE INDEX "border_event_crew_assignment_id_idx" ON "border_event"("crew_assignment_id");
CREATE INDEX "border_event_crew_device_id_idx" ON "border_event"("crew_device_id");

ALTER TABLE "border_event" ADD CONSTRAINT "border_event_trip_id_fkey"
  FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "border_event" ADD CONSTRAINT "border_event_route_waypoint_id_fkey"
  FOREIGN KEY ("route_waypoint_id") REFERENCES "route_waypoint"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "border_event" ADD CONSTRAINT "border_event_recorded_by_identity_id_fkey"
  FOREIGN KEY ("recorded_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "border_event" ADD CONSTRAINT "border_event_crew_assignment_id_fkey"
  FOREIGN KEY ("crew_assignment_id") REFERENCES "crew_trip_assignment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "border_event" ADD CONSTRAINT "border_event_crew_device_id_fkey"
  FOREIGN KEY ("crew_device_id") REFERENCES "crew_device"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "border_event_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  trip_route UUID;
  trip_state "trip_status";
  waypoint_route UUID;
  checkpoint_kind "checkpoint_type";
  previous_type "border_event_type";
  previous_occurred TIMESTAMPTZ(3);
  assignment_trip UUID;
  assignment_identity UUID;
  assignment_revoked TIMESTAMPTZ(3);
  assignment_expires TIMESTAMPTZ(3);
  device_identity UUID;
  device_revoked TIMESTAMPTZ(3);
  device_expires TIMESTAMPTZ(3);
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'border events are append-only'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW."trip_id"::text || ':' || NEW."route_waypoint_id"::text, 0
  ));

  SELECT "route_version_id", "status"
    INTO trip_route, trip_state
    FROM "trip"
    WHERE "id" = NEW."trip_id"
    FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF trip_state <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'border events require an in-progress trip'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT rw."route_version_id", c."type"
    INTO waypoint_route, checkpoint_kind
    FROM "route_waypoint" rw
    LEFT JOIN "checkpoint" c ON c."id" = rw."checkpoint_id"
    WHERE rw."id" = NEW."route_waypoint_id";
  IF NOT FOUND OR waypoint_route <> trip_route OR checkpoint_kind IS DISTINCT FROM 'BORDER'::"checkpoint_type" THEN
    RAISE EXCEPTION 'border event waypoint must be a BORDER checkpoint on the trip route'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."occurred_at" > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'border event timestamp is too far in the future'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."source" = 'CREW' THEN
    SELECT "trip_id", "crew_identity_id", "revoked_at", "expires_at"
      INTO assignment_trip, assignment_identity, assignment_revoked, assignment_expires
      FROM "crew_trip_assignment"
      WHERE "id" = NEW."crew_assignment_id";
    SELECT "identity_id", "revoked_at", "expires_at"
      INTO device_identity, device_revoked, device_expires
      FROM "crew_device"
      WHERE "id" = NEW."crew_device_id";

    IF assignment_trip IS DISTINCT FROM NEW."trip_id"
       OR assignment_identity IS DISTINCT FROM NEW."recorded_by_identity_id"
       OR device_identity IS DISTINCT FROM NEW."recorded_by_identity_id"
       OR assignment_revoked IS NOT NULL
       OR (assignment_expires IS NOT NULL AND assignment_expires <= NEW."recorded_at")
       OR device_revoked IS NOT NULL
       OR device_expires <= NEW."recorded_at" THEN
      RAISE EXCEPTION 'crew provenance is not active for this border event'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  SELECT "type", "occurred_at"
    INTO previous_type, previous_occurred
    FROM "border_event"
    WHERE "trip_id" = NEW."trip_id"
      AND "route_waypoint_id" = NEW."route_waypoint_id"
    ORDER BY "recorded_at" DESC, "id" DESC
    LIMIT 1;

  IF FOUND THEN
    IF NEW."occurred_at" < previous_occurred THEN
      RAISE EXCEPTION 'border event occurrence time cannot move backwards'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (
      (previous_type = 'ARRIVED' AND NEW."type" = 'CONTROL_STARTED')
      OR (previous_type = 'CONTROL_STARTED' AND NEW."type" = 'CONTROL_COMPLETED')
      OR (previous_type = 'CONTROL_COMPLETED' AND NEW."type" = 'DEPARTED')
    ) THEN
      RAISE EXCEPTION 'invalid border event transition'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  ELSIF NEW."type" <> 'ARRIVED' THEN
    RAISE EXCEPTION 'first border event must be ARRIVED'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "border_event_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "border_event"
  FOR EACH ROW EXECUTE FUNCTION "border_event_guard"();

CREATE FUNCTION "border_event_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'border event history cannot be truncated'
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;

CREATE TRIGGER "border_event_no_truncate"
  BEFORE TRUNCATE ON "border_event"
  FOR EACH STATEMENT EXECUTE FUNCTION "border_event_no_truncate"();

INSERT INTO "authorization_permission" ("key", "description") VALUES
  ('border.read', 'Read operational border crossing history and current state'),
  ('border.manage', 'Record operational border crossing events for in-progress trips'),
  ('crew.border.report', 'Report operational border crossing events for an assigned trip from Crew');

INSERT INTO "authorization_role_permission" ("role_key", "permission_key") VALUES
  ('SUPER_ADMIN', 'border.read'),
  ('SUPER_ADMIN', 'border.manage'),
  ('SUPER_ADMIN', 'crew.border.report'),
  ('DIRECTOR', 'border.read'),
  ('DIRECTOR', 'border.manage'),
  ('OPS_MANAGER', 'border.read'),
  ('OPS_MANAGER', 'border.manage'),
  ('DISPATCHER', 'border.read'),
  ('DISPATCHER', 'border.manage'),
  ('CUSTOMER_SUPPORT', 'border.read'),
  ('AUDITOR', 'border.read'),
  ('DRIVER', 'crew.border.report'),
  ('CREW', 'crew.border.report')
ON CONFLICT DO NOTHING;
