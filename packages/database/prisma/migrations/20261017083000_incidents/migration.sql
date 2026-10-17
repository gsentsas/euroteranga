-- PR-21 operational incident management.
-- No insurance, claim, compensation or finance state is introduced here.

CREATE TYPE "incident_type" AS ENUM (
  'BREAKDOWN', 'ACCIDENT', 'DELAY', 'BORDER', 'CUSTOMS', 'POLICE',
  'PASSENGER', 'HEALTH', 'BAGGAGE', 'SECURITY', 'WEATHER', 'FERRY', 'OTHER'
);
CREATE TYPE "incident_severity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE "incident_status" AS ENUM (
  'OPEN', 'ASSESSING', 'ACTION_REQUIRED', 'MITIGATING', 'RESOLVED', 'CLOSED'
);
CREATE TYPE "incident_source" AS ENUM ('STAFF', 'CREW');
CREATE TYPE "incident_action_type" AS ENUM (
  'NOTE', 'ACTION_PLAN', 'MITIGATION', 'PASSENGERS_INFORMED', 'POSTMORTEM'
);

CREATE TABLE "incident" (
  "id" uuid NOT NULL,
  "reference" varchar(16) NOT NULL,
  "trip_id" uuid NOT NULL,
  "vehicle_id" uuid,
  "route_waypoint_id" uuid,
  "baggage_id" uuid,
  "type" "incident_type" NOT NULL,
  "severity" "incident_severity" NOT NULL,
  "status" "incident_status" NOT NULL DEFAULT 'OPEN',
  "source" "incident_source" NOT NULL,
  "description" varchar(2000) NOT NULL,
  "location_label" varchar(160),
  "opened_at" timestamptz(3) NOT NULL,
  "recorded_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" timestamptz(3),
  "closed_at" timestamptz(3),
  "opened_by_identity_id" uuid NOT NULL,
  "owner_identity_id" uuid,
  "client_event_id" varchar(64) NOT NULL,
  "payload_fingerprint" char(64) NOT NULL,
  "crew_assignment_id" uuid,
  "crew_device_id" uuid,
  CONSTRAINT "incident_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "incident_reference_key" UNIQUE ("reference"),
  CONSTRAINT "incident_trip_id_client_event_id_key" UNIQUE ("trip_id", "client_event_id"),
  CONSTRAINT "incident_reference_format"
    CHECK ("reference" ~ '^ETI-[0-9A-HJKMNP-TV-Z]{12}$'),
  CONSTRAINT "incident_client_event_id_format"
    CHECK ("client_event_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$'),
  CONSTRAINT "incident_payload_fingerprint_format"
    CHECK ("payload_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "incident_description_normalized"
    CHECK (length("description") BETWEEN 10 AND 2000 AND "description" = btrim("description")),
  CONSTRAINT "incident_location_label_normalized"
    CHECK ("location_label" IS NULL OR (
      length("location_label") BETWEEN 1 AND 160 AND "location_label" = btrim("location_label")
    )),
  CONSTRAINT "incident_source_shape"
    CHECK (
      ("source" = 'STAFF' AND "crew_assignment_id" IS NULL AND "crew_device_id" IS NULL)
      OR
      ("source" = 'CREW' AND "crew_assignment_id" IS NOT NULL AND "crew_device_id" IS NOT NULL)
    ),
  CONSTRAINT "incident_baggage_shape"
    CHECK (
      ("type" = 'BAGGAGE' AND "baggage_id" IS NOT NULL)
      OR
      ("type" <> 'BAGGAGE' AND "baggage_id" IS NULL)
    ),
  CONSTRAINT "incident_resolution_shape"
    CHECK (
      ("status" IN ('OPEN','ASSESSING','ACTION_REQUIRED','MITIGATING')
        AND "resolved_at" IS NULL AND "closed_at" IS NULL)
      OR
      ("status" = 'RESOLVED' AND "resolved_at" IS NOT NULL AND "closed_at" IS NULL)
      OR
      ("status" = 'CLOSED' AND "resolved_at" IS NOT NULL AND "closed_at" IS NOT NULL)
    )
);

CREATE TABLE "incident_action" (
  "id" uuid NOT NULL,
  "incident_id" uuid NOT NULL,
  "sequence" integer NOT NULL,
  "type" "incident_action_type" NOT NULL,
  "content" varchar(2000) NOT NULL,
  "client_action_id" varchar(64) NOT NULL,
  "payload_fingerprint" char(64) NOT NULL,
  "created_by_identity_id" uuid NOT NULL,
  "created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "incident_action_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "incident_action_incident_id_sequence_key" UNIQUE ("incident_id", "sequence"),
  CONSTRAINT "incident_action_incident_id_client_action_id_key" UNIQUE ("incident_id", "client_action_id"),
  CONSTRAINT "incident_action_sequence_positive" CHECK ("sequence" > 0),
  CONSTRAINT "incident_action_client_action_id_format"
    CHECK ("client_action_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$'),
  CONSTRAINT "incident_action_payload_fingerprint_format"
    CHECK ("payload_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "incident_action_content_normalized"
    CHECK (length("content") BETWEEN 3 AND 2000 AND "content" = btrim("content"))
);

CREATE TABLE "incident_attachment" (
  "id" uuid NOT NULL,
  "incident_id" uuid NOT NULL,
  "object_key" varchar(96) NOT NULL,
  "sha256" char(64) NOT NULL,
  "mime_type" varchar(64) NOT NULL,
  "size_bytes" integer NOT NULL,
  "uploaded_by_identity_id" uuid NOT NULL,
  "created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "incident_attachment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "incident_attachment_object_key_key" UNIQUE ("object_key"),
  CONSTRAINT "incident_attachment_object_key_format"
    CHECK ("object_key" ~ '^incident-attachments/[0-9a-f]{2}/[0-9a-f]{64}$'),
  CONSTRAINT "incident_attachment_sha256_format"
    CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "incident_attachment_mime_supported"
    CHECK ("mime_type" IN ('application/pdf','image/jpeg','image/png')),
  CONSTRAINT "incident_attachment_size_positive"
    CHECK ("size_bytes" > 0)
);

CREATE INDEX "incident_status_severity_recorded_at_id_idx"
  ON "incident"("status", "severity", "recorded_at", "id");
CREATE INDEX "incident_trip_id_recorded_at_id_idx"
  ON "incident"("trip_id", "recorded_at", "id");
CREATE INDEX "incident_vehicle_id_status_idx" ON "incident"("vehicle_id", "status");
CREATE INDEX "incident_route_waypoint_id_idx" ON "incident"("route_waypoint_id");
CREATE INDEX "incident_baggage_id_idx" ON "incident"("baggage_id");
CREATE INDEX "incident_owner_identity_id_status_idx" ON "incident"("owner_identity_id", "status");
CREATE INDEX "incident_crew_assignment_id_idx" ON "incident"("crew_assignment_id");
CREATE INDEX "incident_crew_device_id_idx" ON "incident"("crew_device_id");
CREATE INDEX "incident_action_incident_id_created_at_id_idx"
  ON "incident_action"("incident_id", "created_at", "id");
CREATE INDEX "incident_action_created_by_identity_id_created_at_idx"
  ON "incident_action"("created_by_identity_id", "created_at");
CREATE INDEX "incident_attachment_incident_id_created_at_id_idx"
  ON "incident_attachment"("incident_id", "created_at", "id");
CREATE INDEX "incident_attachment_uploaded_by_identity_id_created_at_idx"
  ON "incident_attachment"("uploaded_by_identity_id", "created_at");

ALTER TABLE "incident" ADD CONSTRAINT "incident_trip_id_fkey"
  FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "incident" ADD CONSTRAINT "incident_vehicle_id_fkey"
  FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "incident" ADD CONSTRAINT "incident_route_waypoint_id_fkey"
  FOREIGN KEY ("route_waypoint_id") REFERENCES "route_waypoint"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "incident" ADD CONSTRAINT "incident_baggage_id_fkey"
  FOREIGN KEY ("baggage_id") REFERENCES "baggage"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "incident" ADD CONSTRAINT "incident_opened_by_identity_id_fkey"
  FOREIGN KEY ("opened_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "incident" ADD CONSTRAINT "incident_owner_identity_id_fkey"
  FOREIGN KEY ("owner_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "incident" ADD CONSTRAINT "incident_crew_assignment_id_fkey"
  FOREIGN KEY ("crew_assignment_id") REFERENCES "crew_trip_assignment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "incident" ADD CONSTRAINT "incident_crew_device_id_fkey"
  FOREIGN KEY ("crew_device_id") REFERENCES "crew_device"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "incident_action" ADD CONSTRAINT "incident_action_incident_id_fkey"
  FOREIGN KEY ("incident_id") REFERENCES "incident"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "incident_action" ADD CONSTRAINT "incident_action_created_by_identity_id_fkey"
  FOREIGN KEY ("created_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "incident_attachment" ADD CONSTRAINT "incident_attachment_incident_id_fkey"
  FOREIGN KEY ("incident_id") REFERENCES "incident"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "incident_attachment" ADD CONSTRAINT "incident_attachment_uploaded_by_identity_id_fkey"
  FOREIGN KEY ("uploaded_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "incident_assert_active_staff"(identity uuid, label text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  actor_realm "auth_realm";
  actor_status "auth_identity_status";
BEGIN
  SELECT "realm", "status" INTO actor_realm, actor_status
  FROM "auth_identity" WHERE "id" = identity;
  IF actor_realm IS DISTINCT FROM 'STAFF' OR actor_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'incident % must be active STAFF', label USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION "incident_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  trip_status "trip_status";
  trip_route_version uuid;
  trip_vehicle uuid;
  actor_realm "auth_realm";
  actor_status "auth_identity_status";
  baggage_trip uuid;
  baggage_exception "baggage_exception_status";
  assignment_ok boolean;
  device_ok boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'incidents cannot be deleted' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' OR NEW."resolved_at" IS NOT NULL OR NEW."closed_at" IS NOT NULL THEN
      RAISE EXCEPTION 'incidents must be created OPEN' USING ERRCODE = '23514';
    END IF;

    IF NEW."opened_at" > clock_timestamp() + interval '5 minutes' THEN
      RAISE EXCEPTION 'incident opened_at is too far in the future' USING ERRCODE = '23514';
    END IF;

    SELECT "status", "route_version_id", "vehicle_id"
      INTO trip_status, trip_route_version, trip_vehicle
    FROM "trip" WHERE "id" = NEW."trip_id" FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'incident trip does not exist' USING ERRCODE = '23503';
    END IF;
    IF trip_status NOT IN ('SCHEDULED','IN_PROGRESS') THEN
      RAISE EXCEPTION 'incidents require a scheduled or in-progress trip' USING ERRCODE = '23514';
    END IF;

    IF NEW."vehicle_id" IS DISTINCT FROM trip_vehicle THEN
      RAISE EXCEPTION 'incident vehicle must equal the trip vehicle snapshot' USING ERRCODE = '23514';
    END IF;

    IF NEW."route_waypoint_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "route_waypoint"
      WHERE "id" = NEW."route_waypoint_id" AND "route_version_id" = trip_route_version
    ) THEN
      RAISE EXCEPTION 'incident waypoint must belong to the trip route' USING ERRCODE = '23514';
    END IF;

    IF NEW."baggage_id" IS NOT NULL THEN
      SELECT b."exception_status", bk."trip_id"
        INTO baggage_exception, baggage_trip
      FROM "baggage" b
      JOIN "booking" bk ON bk."id" = b."booking_id"
      WHERE b."id" = NEW."baggage_id";
      IF NOT FOUND OR baggage_trip <> NEW."trip_id" OR baggage_exception NOT IN ('MISSING','DAMAGED') THEN
        RAISE EXCEPTION 'baggage incidents require a missing or damaged bag on the same trip'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    SELECT "realm", "status" INTO actor_realm, actor_status
    FROM "auth_identity" WHERE "id" = NEW."opened_by_identity_id";
    IF actor_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'incident opener must be active' USING ERRCODE = '23514';
    END IF;
    IF NEW."source" = 'STAFF' AND actor_realm IS DISTINCT FROM 'STAFF' THEN
      RAISE EXCEPTION 'staff incident opener must be STAFF' USING ERRCODE = '23514';
    END IF;
    IF NEW."source" = 'CREW' AND actor_realm IS DISTINCT FROM 'CREW' THEN
      RAISE EXCEPTION 'crew incident opener must be CREW' USING ERRCODE = '23514';
    END IF;

    IF NEW."source" = 'CREW' THEN
      SELECT EXISTS (
        SELECT 1 FROM "crew_trip_assignment"
        WHERE "id" = NEW."crew_assignment_id"
          AND "trip_id" = NEW."trip_id"
          AND "crew_identity_id" = NEW."opened_by_identity_id"
          AND "revoked_at" IS NULL
          AND ("expires_at" IS NULL OR "expires_at" > clock_timestamp())
      ) INTO assignment_ok;
      SELECT EXISTS (
        SELECT 1 FROM "crew_device"
        WHERE "id" = NEW."crew_device_id"
          AND "identity_id" = NEW."opened_by_identity_id"
          AND "revoked_at" IS NULL
          AND "expires_at" > clock_timestamp()
      ) INTO device_ok;
      IF NOT assignment_ok OR NOT device_ok THEN
        RAISE EXCEPTION 'crew provenance is not active for this incident' USING ERRCODE = '23514';
      END IF;
    END IF;

    IF NEW."owner_identity_id" IS NOT NULL THEN
      PERFORM "incident_assert_active_staff"(NEW."owner_identity_id", 'owner');
    END IF;

    RETURN NEW;
  END IF;

  -- Initial report facts and provenance never change.
  IF NEW."reference" IS DISTINCT FROM OLD."reference"
    OR NEW."trip_id" IS DISTINCT FROM OLD."trip_id"
    OR NEW."vehicle_id" IS DISTINCT FROM OLD."vehicle_id"
    OR NEW."route_waypoint_id" IS DISTINCT FROM OLD."route_waypoint_id"
    OR NEW."baggage_id" IS DISTINCT FROM OLD."baggage_id"
    OR NEW."type" IS DISTINCT FROM OLD."type"
    OR NEW."severity" IS DISTINCT FROM OLD."severity"
    OR NEW."source" IS DISTINCT FROM OLD."source"
    OR NEW."description" IS DISTINCT FROM OLD."description"
    OR NEW."location_label" IS DISTINCT FROM OLD."location_label"
    OR NEW."opened_at" IS DISTINCT FROM OLD."opened_at"
    OR NEW."recorded_at" IS DISTINCT FROM OLD."recorded_at"
    OR NEW."opened_by_identity_id" IS DISTINCT FROM OLD."opened_by_identity_id"
    OR NEW."client_event_id" IS DISTINCT FROM OLD."client_event_id"
    OR NEW."payload_fingerprint" IS DISTINCT FROM OLD."payload_fingerprint"
    OR NEW."crew_assignment_id" IS DISTINCT FROM OLD."crew_assignment_id"
    OR NEW."crew_device_id" IS DISTINCT FROM OLD."crew_device_id"
  THEN
    RAISE EXCEPTION 'incident initial facts are immutable' USING ERRCODE = '23514';
  END IF;

  IF NEW."owner_identity_id" IS DISTINCT FROM OLD."owner_identity_id"
    AND NEW."owner_identity_id" IS NOT NULL THEN
    PERFORM "incident_assert_active_staff"(NEW."owner_identity_id", 'owner');
  END IF;

  IF NEW."status" = OLD."status" THEN
    IF NEW."resolved_at" IS DISTINCT FROM OLD."resolved_at"
      OR NEW."closed_at" IS DISTINCT FROM OLD."closed_at" THEN
      RAISE EXCEPTION 'incident resolution timestamps are server-owned' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD."status" = 'OPEN' AND NEW."status" = 'ASSESSING')
    OR (OLD."status" = 'ASSESSING' AND NEW."status" = 'ACTION_REQUIRED')
    OR (OLD."status" = 'ACTION_REQUIRED' AND NEW."status" = 'MITIGATING')
    OR (OLD."status" = 'MITIGATING' AND NEW."status" = 'RESOLVED')
    OR (OLD."status" = 'RESOLVED' AND NEW."status" = 'CLOSED')
  ) THEN
    RAISE EXCEPTION 'invalid incident status transition' USING ERRCODE = '23514';
  END IF;

  IF OLD."severity" = 'CRITICAL' AND OLD."type" = 'BREAKDOWN' THEN
    IF NEW."status" = 'MITIGATING' AND NOT EXISTS (
      SELECT 1 FROM "incident_action" WHERE "incident_id" = OLD."id" AND "type" = 'ACTION_PLAN'
    ) THEN
      RAISE EXCEPTION 'critical breakdown requires an action plan before mitigation'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."status" = 'RESOLVED' AND NOT EXISTS (
      SELECT 1 FROM "incident_action" WHERE "incident_id" = OLD."id" AND "type" = 'PASSENGERS_INFORMED'
    ) THEN
      RAISE EXCEPTION 'critical breakdown requires passenger notification before resolution'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."status" = 'CLOSED' AND NOT EXISTS (
      SELECT 1 FROM "incident_action" WHERE "incident_id" = OLD."id" AND "type" = 'POSTMORTEM'
    ) THEN
      RAISE EXCEPTION 'critical breakdown requires a postmortem before closure'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."status" = 'RESOLVED' THEN
    NEW."resolved_at" := clock_timestamp();
    NEW."closed_at" := NULL;
  ELSIF NEW."status" = 'CLOSED' THEN
    NEW."resolved_at" := OLD."resolved_at";
    NEW."closed_at" := clock_timestamp();
  ELSE
    NEW."resolved_at" := NULL;
    NEW."closed_at" := NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "incident_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "incident"
  FOR EACH ROW EXECUTE FUNCTION "incident_guard"();

CREATE FUNCTION "incident_action_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected_sequence integer;
  current_status "incident_status";
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'incident actions are append-only' USING ERRCODE = '23514';
  END IF;

  SELECT "status" INTO current_status FROM "incident"
  WHERE "id" = NEW."incident_id" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'incident does not exist' USING ERRCODE = '23503';
  END IF;
  IF current_status = 'CLOSED' THEN
    RAISE EXCEPTION 'closed incidents do not accept new actions' USING ERRCODE = '23514';
  END IF;

  PERFORM "incident_assert_active_staff"(NEW."created_by_identity_id", 'action actor');

  SELECT COALESCE(MAX("sequence"), 0) + 1 INTO expected_sequence
  FROM "incident_action" WHERE "incident_id" = NEW."incident_id";
  IF NEW."sequence" <> expected_sequence THEN
    RAISE EXCEPTION 'incident action sequence must be %', expected_sequence USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "incident_action_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "incident_action"
  FOR EACH ROW EXECUTE FUNCTION "incident_action_guard"();

CREATE FUNCTION "incident_attachment_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_status "incident_status";
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'incident attachments are immutable' USING ERRCODE = '23514';
  END IF;
  SELECT "status" INTO current_status FROM "incident"
  WHERE "id" = NEW."incident_id" FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'incident does not exist' USING ERRCODE = '23503';
  END IF;
  IF current_status = 'CLOSED' THEN
    RAISE EXCEPTION 'closed incidents do not accept attachments' USING ERRCODE = '23514';
  END IF;
  PERFORM "incident_assert_active_staff"(NEW."uploaded_by_identity_id", 'attachment uploader');
  RETURN NEW;
END;
$$;

CREATE TRIGGER "incident_attachment_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "incident_attachment"
  FOR EACH ROW EXECUTE FUNCTION "incident_attachment_guard"();

CREATE FUNCTION "incident_history_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'incident history cannot be truncated' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "incident_no_truncate"
  BEFORE TRUNCATE ON "incident"
  FOR EACH STATEMENT EXECUTE FUNCTION "incident_history_no_truncate"();
CREATE TRIGGER "incident_action_no_truncate"
  BEFORE TRUNCATE ON "incident_action"
  FOR EACH STATEMENT EXECUTE FUNCTION "incident_history_no_truncate"();
CREATE TRIGGER "incident_attachment_no_truncate"
  BEFORE TRUNCATE ON "incident_attachment"
  FOR EACH STATEMENT EXECUTE FUNCTION "incident_history_no_truncate"();

INSERT INTO "authorization_permission" ("key", "description") VALUES
  ('incident.read', 'Read operational incident queues, details, actions and evidence metadata'),
  ('incident.manage', 'Open, assign, progress and document operational incidents'),
  ('crew.incident.report', 'Report operational incidents for an assigned trip from Crew');

INSERT INTO "authorization_role_permission" ("role_key", "permission_key") VALUES
  ('SUPER_ADMIN', 'incident.read'),
  ('SUPER_ADMIN', 'incident.manage'),
  ('SUPER_ADMIN', 'crew.incident.report'),
  ('DIRECTOR', 'incident.read'),
  ('DIRECTOR', 'incident.manage'),
  ('OPS_MANAGER', 'incident.read'),
  ('OPS_MANAGER', 'incident.manage'),
  ('DISPATCHER', 'incident.read'),
  ('DISPATCHER', 'incident.manage'),
  ('CUSTOMER_SUPPORT', 'incident.read'),
  ('AUDITOR', 'incident.read'),
  ('DRIVER', 'crew.incident.report'),
  ('CREW', 'crew.incident.report')
ON CONFLICT DO NOTHING;
