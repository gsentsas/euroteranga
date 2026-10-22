-- CARGO-1: independent road-freight domain for Paris <-> Dakar.
-- Pricing, payments, public tracking, QR scanning and private customs documents
-- remain explicitly outside this migration.

CREATE TYPE "road_freight_direction" AS ENUM ('PAR_DKR', 'DKR_PAR');
CREATE TYPE "road_freight_lifecycle_status" AS ENUM (
  'QUOTE', 'BOOKED', 'RECEIVED', 'INSPECTED', 'ASSIGNED', 'LOADED',
  'DEPARTED', 'IN_TRANSIT', 'ARRIVED', 'AVAILABLE', 'DELIVERED',
  'REFUSED', 'CANCELLED'
);
CREATE TYPE "road_freight_exception_status" AS ENUM ('HELD', 'CUSTOMS_HOLD', 'DAMAGED');
CREATE TYPE "road_freight_event_type" AS ENUM (
  'QUOTE', 'BOOKED', 'RECEIVED', 'INSPECTED', 'ASSIGNED', 'LOADED',
  'DEPARTED', 'IN_TRANSIT', 'ARRIVED', 'AVAILABLE', 'DELIVERED',
  'REFUSED', 'CANCELLED', 'HELD', 'CUSTOMS_HOLD', 'DAMAGED',
  'EXCEPTION_RESOLVED', 'ASSIGNMENT_UPDATED'
);

CREATE TABLE "road_freight_shipment" (
  "id" UUID NOT NULL,
  "reference" VARCHAR(16) NOT NULL,
  "direction" "road_freight_direction" NOT NULL,
  "booking_id" UUID,
  "customer_identity_id" UUID,
  "trip_id" UUID,
  "vehicle_id" UUID,
  "sender_name" VARCHAR(160) NOT NULL,
  "sender_contact" VARCHAR(200) NOT NULL,
  "recipient_name" VARCHAR(160) NOT NULL,
  "recipient_contact" VARCHAR(200) NOT NULL,
  "weight_kg" DECIMAL(8,3) NOT NULL,
  "volume_liters" INTEGER NOT NULL,
  "package_count" INTEGER NOT NULL,
  "length_cm" INTEGER,
  "width_cm" INTEGER,
  "height_cm" INTEGER,
  "declared_contents" VARCHAR(500) NOT NULL,
  "declared_value_minor" BIGINT,
  "declared_value_currency_code" VARCHAR(3),
  "declared_value_currency_minor_unit" INTEGER,
  "fragile" BOOLEAN NOT NULL DEFAULT false,
  "professional" BOOLEAN NOT NULL DEFAULT false,
  "pickup_required" BOOLEAN NOT NULL DEFAULT false,
  "delivery_required" BOOLEAN NOT NULL DEFAULT false,
  "lifecycle_status" "road_freight_lifecycle_status" NOT NULL DEFAULT 'QUOTE',
  "exception_status" "road_freight_exception_status",
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "road_freight_shipment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "road_freight_shipment_event" (
  "id" UUID NOT NULL,
  "shipment_id" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "type" "road_freight_event_type" NOT NULL,
  "lifecycle_status" "road_freight_lifecycle_status" NOT NULL,
  "exception_status" "road_freight_exception_status",
  "occurred_at" TIMESTAMPTZ(3) NOT NULL,
  "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actor_identity_id" UUID NOT NULL,
  "route_waypoint_id" UUID,
  "trip_id" UUID,
  "vehicle_id" UUID,
  "client_event_id" VARCHAR(64),
  "payload_fingerprint" CHAR(64) NOT NULL,
  CONSTRAINT "road_freight_shipment_event_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "road_freight_shipment_reference_key"
  ON "road_freight_shipment"("reference");
CREATE INDEX "road_freight_shipment_direction_lifecycle_status_id_idx"
  ON "road_freight_shipment"("direction", "lifecycle_status", "id");
CREATE INDEX "road_freight_shipment_exception_status_id_idx"
  ON "road_freight_shipment"("exception_status", "id");
CREATE INDEX "road_freight_shipment_booking_id_idx"
  ON "road_freight_shipment"("booking_id");
CREATE INDEX "road_freight_shipment_customer_identity_id_idx"
  ON "road_freight_shipment"("customer_identity_id");
CREATE INDEX "road_freight_shipment_trip_id_vehicle_id_id_idx"
  ON "road_freight_shipment"("trip_id", "vehicle_id", "id");
CREATE INDEX "road_freight_shipment_created_at_id_idx"
  ON "road_freight_shipment"("created_at", "id");

CREATE UNIQUE INDEX "road_freight_shipment_event_shipment_id_sequence_key"
  ON "road_freight_shipment_event"("shipment_id", "sequence");
CREATE UNIQUE INDEX "road_freight_shipment_event_shipment_id_client_event_id_key"
  ON "road_freight_shipment_event"("shipment_id", "client_event_id");
CREATE INDEX "road_freight_shipment_event_actor_identity_id_recorded_at_idx"
  ON "road_freight_shipment_event"("actor_identity_id", "recorded_at");
CREATE INDEX "road_freight_shipment_event_route_waypoint_id_idx"
  ON "road_freight_shipment_event"("route_waypoint_id");

ALTER TABLE "road_freight_shipment"
  ADD CONSTRAINT "road_freight_shipment_booking_id_fkey"
  FOREIGN KEY ("booking_id") REFERENCES "booking"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "road_freight_shipment"
  ADD CONSTRAINT "road_freight_shipment_customer_identity_id_fkey"
  FOREIGN KEY ("customer_identity_id") REFERENCES "auth_identity"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "road_freight_shipment"
  ADD CONSTRAINT "road_freight_shipment_trip_id_fkey"
  FOREIGN KEY ("trip_id") REFERENCES "trip"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "road_freight_shipment"
  ADD CONSTRAINT "road_freight_shipment_vehicle_id_fkey"
  FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "road_freight_shipment_event"
  ADD CONSTRAINT "road_freight_shipment_event_shipment_id_fkey"
  FOREIGN KEY ("shipment_id") REFERENCES "road_freight_shipment"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "road_freight_shipment_event"
  ADD CONSTRAINT "road_freight_shipment_event_actor_identity_id_fkey"
  FOREIGN KEY ("actor_identity_id") REFERENCES "auth_identity"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "road_freight_shipment_event"
  ADD CONSTRAINT "road_freight_shipment_event_route_waypoint_id_fkey"
  FOREIGN KEY ("route_waypoint_id") REFERENCES "route_waypoint"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "road_freight_shipment_event"
  ADD CONSTRAINT "road_freight_shipment_event_trip_id_fkey"
  FOREIGN KEY ("trip_id") REFERENCES "trip"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "road_freight_shipment_event"
  ADD CONSTRAINT "road_freight_shipment_event_vehicle_id_fkey"
  FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "road_freight_shipment" ADD CONSTRAINT "road_freight_reference_format"
  CHECK ("reference" ~ '^ETC-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$');
ALTER TABLE "road_freight_shipment" ADD CONSTRAINT "road_freight_text_shape"
  CHECK (
    length("sender_name") BETWEEN 1 AND 160 AND "sender_name" = btrim("sender_name")
    AND length("sender_contact") BETWEEN 1 AND 200 AND "sender_contact" = btrim("sender_contact")
    AND length("recipient_name") BETWEEN 1 AND 160 AND "recipient_name" = btrim("recipient_name")
    AND length("recipient_contact") BETWEEN 1 AND 200 AND "recipient_contact" = btrim("recipient_contact")
    AND length("declared_contents") BETWEEN 1 AND 500 AND "declared_contents" = btrim("declared_contents")
  );
ALTER TABLE "road_freight_shipment" ADD CONSTRAINT "road_freight_weight_valid"
  CHECK ("weight_kg" BETWEEN 0.001 AND 99999.999);
ALTER TABLE "road_freight_shipment" ADD CONSTRAINT "road_freight_volume_valid"
  CHECK ("volume_liters" BETWEEN 1 AND 1000000);
ALTER TABLE "road_freight_shipment" ADD CONSTRAINT "road_freight_package_count_valid"
  CHECK ("package_count" BETWEEN 1 AND 9999);
ALTER TABLE "road_freight_shipment" ADD CONSTRAINT "road_freight_dimensions_group"
  CHECK (
    ("length_cm" IS NULL AND "width_cm" IS NULL AND "height_cm" IS NULL)
    OR (
      "length_cm" BETWEEN 1 AND 2000
      AND "width_cm" BETWEEN 1 AND 2000
      AND "height_cm" BETWEEN 1 AND 2000
    )
  );
ALTER TABLE "road_freight_shipment" ADD CONSTRAINT "road_freight_declared_value_group"
  CHECK (
    ("declared_value_minor" IS NULL
      AND "declared_value_currency_code" IS NULL
      AND "declared_value_currency_minor_unit" IS NULL)
    OR (
      "declared_value_minor" BETWEEN 0 AND 999999999999999999
      AND "declared_value_currency_code" ~ '^[A-Z]{3}$'
      AND "declared_value_currency_minor_unit" BETWEEN 0 AND 3
    )
  );
ALTER TABLE "road_freight_shipment" ADD CONSTRAINT "road_freight_assignment_pair"
  CHECK (("trip_id" IS NULL) = ("vehicle_id" IS NULL));
ALTER TABLE "road_freight_shipment" ADD CONSTRAINT "road_freight_booking_customer_pair"
  CHECK ("booking_id" IS NULL OR "customer_identity_id" IS NOT NULL);

ALTER TABLE "road_freight_shipment_event" ADD CONSTRAINT "road_freight_event_sequence_positive"
  CHECK ("sequence" > 0);
ALTER TABLE "road_freight_shipment_event" ADD CONSTRAINT "road_freight_event_assignment_pair"
  CHECK (("trip_id" IS NULL) = ("vehicle_id" IS NULL));
ALTER TABLE "road_freight_shipment_event" ADD CONSTRAINT "road_freight_event_client_id_format"
  CHECK (
    "client_event_id" IS NULL
    OR "client_event_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$'
  );
ALTER TABLE "road_freight_shipment_event" ADD CONSTRAINT "road_freight_event_fingerprint_format"
  CHECK ("payload_fingerprint" ~ '^[0-9a-f]{64}$');

CREATE FUNCTION "road_freight_direction_for_trip"(target_trip UUID)
RETURNS "road_freight_direction"
LANGUAGE plpgsql STABLE AS $$
DECLARE
  version_id UUID;
  origin_code TEXT;
  destination_code TEXT;
BEGIN
  SELECT "route_version_id" INTO version_id FROM "trip" WHERE "id" = target_trip;
  SELECT s."code" INTO origin_code
  FROM "route_waypoint" rw
  JOIN "stop" s ON s."id" = rw."stop_id"
  WHERE rw."route_version_id" = version_id
  ORDER BY rw."sequence" ASC
  LIMIT 1;
  SELECT s."code" INTO destination_code
  FROM "route_waypoint" rw
  JOIN "stop" s ON s."id" = rw."stop_id"
  WHERE rw."route_version_id" = version_id
  ORDER BY rw."sequence" DESC
  LIMIT 1;
  IF origin_code = 'PAR' AND destination_code = 'DKR' THEN RETURN 'PAR_DKR'; END IF;
  IF origin_code = 'DKR' AND destination_code = 'PAR' THEN RETURN 'DKR_PAR'; END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION "road_freight_shipment_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  booking_customer UUID;
  booking_trip UUID;
  booking_direction "road_freight_direction";
  frozen BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'road freight shipments cannot be deleted'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."lifecycle_status" <> 'QUOTE'
       OR NEW."exception_status" IS NOT NULL
       OR NEW."trip_id" IS NOT NULL
       OR NEW."vehicle_id" IS NOT NULL THEN
      RAISE EXCEPTION 'road freight must start as an unassigned QUOTE'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."reference" IS DISTINCT FROM OLD."reference"
       OR NEW."direction" IS DISTINCT FROM OLD."direction"
       OR NEW."booking_id" IS DISTINCT FROM OLD."booking_id"
       OR NEW."customer_identity_id" IS DISTINCT FROM OLD."customer_identity_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
      RAISE EXCEPTION 'road freight identity and commercial subject are immutable'
        USING ERRCODE = 'check_violation';
    END IF;

    frozen := OLD."lifecycle_status" IN (
      'LOADED', 'DEPARTED', 'IN_TRANSIT', 'ARRIVED', 'AVAILABLE',
      'DELIVERED', 'REFUSED', 'CANCELLED'
    );
    IF frozen AND (
      NEW."sender_name" IS DISTINCT FROM OLD."sender_name"
      OR NEW."sender_contact" IS DISTINCT FROM OLD."sender_contact"
      OR NEW."recipient_name" IS DISTINCT FROM OLD."recipient_name"
      OR NEW."recipient_contact" IS DISTINCT FROM OLD."recipient_contact"
      OR NEW."weight_kg" IS DISTINCT FROM OLD."weight_kg"
      OR NEW."volume_liters" IS DISTINCT FROM OLD."volume_liters"
      OR NEW."package_count" IS DISTINCT FROM OLD."package_count"
      OR NEW."length_cm" IS DISTINCT FROM OLD."length_cm"
      OR NEW."width_cm" IS DISTINCT FROM OLD."width_cm"
      OR NEW."height_cm" IS DISTINCT FROM OLD."height_cm"
      OR NEW."declared_contents" IS DISTINCT FROM OLD."declared_contents"
      OR NEW."declared_value_minor" IS DISTINCT FROM OLD."declared_value_minor"
      OR NEW."declared_value_currency_code" IS DISTINCT FROM OLD."declared_value_currency_code"
      OR NEW."declared_value_currency_minor_unit" IS DISTINCT FROM OLD."declared_value_currency_minor_unit"
      OR NEW."fragile" IS DISTINCT FROM OLD."fragile"
      OR NEW."professional" IS DISTINCT FROM OLD."professional"
      OR NEW."pickup_required" IS DISTINCT FROM OLD."pickup_required"
      OR NEW."delivery_required" IS DISTINCT FROM OLD."delivery_required"
      OR NEW."trip_id" IS DISTINCT FROM OLD."trip_id"
      OR NEW."vehicle_id" IS DISTINCT FROM OLD."vehicle_id"
    ) THEN
      RAISE EXCEPTION 'road freight details are frozen after loading'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;

  IF NEW."booking_id" IS NOT NULL THEN
    SELECT b."customer_identity_id", b."trip_id"
      INTO booking_customer, booking_trip
    FROM "booking" b WHERE b."id" = NEW."booking_id" FOR SHARE;
    IF NOT FOUND THEN RETURN NEW; END IF;
    IF NEW."customer_identity_id" IS DISTINCT FROM booking_customer THEN
      RAISE EXCEPTION 'road freight booking customer mismatch'
        USING ERRCODE = 'check_violation';
    END IF;
    booking_direction := "road_freight_direction_for_trip"(booking_trip);
    IF booking_direction IS NULL OR booking_direction <> NEW."direction" THEN
      RAISE EXCEPTION 'road freight direction does not match booking trip'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  NEW."updated_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "road_freight_shipment_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "road_freight_shipment"
  FOR EACH ROW EXECUTE FUNCTION "road_freight_shipment_guard"();

CREATE FUNCTION "road_freight_assignment_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  trip_state "trip_status";
  primary_vehicle UUID;
  support_vehicle UUID;
  target_state "vehicle_status";
  target_payload INTEGER;
  target_volume INTEGER;
  booking_trip UUID;
  assigned_weight NUMERIC(12,3);
  assigned_volume BIGINT;
BEGIN
  IF NEW."trip_id" IS NULL THEN RETURN NEW; END IF;

  SELECT t."status", t."vehicle_id", t."support_vehicle_id"
    INTO trip_state, primary_vehicle, support_vehicle
  FROM "trip" t WHERE t."id" = NEW."trip_id" FOR SHARE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF trip_state NOT IN ('DRAFT', 'SCHEDULED') THEN
    RAISE EXCEPTION 'road freight assignment requires a future trip'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF "road_freight_direction_for_trip"(NEW."trip_id") IS DISTINCT FROM NEW."direction" THEN
    RAISE EXCEPTION 'road freight direction does not match assigned trip'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."vehicle_id" IS DISTINCT FROM primary_vehicle
     AND NEW."vehicle_id" IS DISTINCT FROM support_vehicle THEN
    RAISE EXCEPTION 'assigned cargo vehicle is not part of the trip convoy'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT v."status", v."payload_capacity_kg", v."cargo_volume_liters"
    INTO target_state, target_payload, target_volume
  FROM "vehicle" v WHERE v."id" = NEW."vehicle_id" FOR SHARE;
  IF target_state <> 'ACTIVE' OR target_payload IS NULL OR target_volume IS NULL THEN
    RAISE EXCEPTION 'assigned cargo vehicle needs ACTIVE state and dual capacity'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."booking_id" IS NOT NULL THEN
    SELECT b."trip_id" INTO booking_trip FROM "booking" b WHERE b."id" = NEW."booking_id";
    IF booking_trip IS DISTINCT FROM NEW."trip_id" THEN
      RAISE EXCEPTION 'booking trip must match cargo assignment'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."lifecycle_status" IN (
    'ASSIGNED', 'LOADED', 'DEPARTED', 'IN_TRANSIT', 'ARRIVED', 'AVAILABLE'
  ) THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('road-freight-capacity:' || NEW."trip_id"::text || ':' || NEW."vehicle_id"::text, 0)
    );
    SELECT
      COALESCE(sum(s."weight_kg"), 0),
      COALESCE(sum(s."volume_liters"), 0)
      INTO assigned_weight, assigned_volume
    FROM "road_freight_shipment" s
    WHERE s."id" <> NEW."id"
      AND s."trip_id" = NEW."trip_id"
      AND s."vehicle_id" = NEW."vehicle_id"
      AND s."lifecycle_status" IN (
        'ASSIGNED', 'LOADED', 'DEPARTED', 'IN_TRANSIT', 'ARRIVED', 'AVAILABLE'
      );
    IF assigned_weight + NEW."weight_kg" > target_payload
       OR assigned_volume + NEW."volume_liters" > target_volume THEN
      RAISE EXCEPTION 'road freight capacity exceeded'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "road_freight_assignment_guard"
  BEFORE INSERT OR UPDATE OF "trip_id", "vehicle_id", "weight_kg", "volume_liters", "lifecycle_status"
  ON "road_freight_shipment"
  FOR EACH ROW EXECUTE FUNCTION "road_freight_assignment_guard"();

CREATE FUNCTION "road_freight_event_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current RECORD;
  previous_sequence INTEGER;
  waypoint_version UUID;
  trip_version UUID;
  expected_next "road_freight_lifecycle_status";
  actor_realm "auth_realm";
  actor_status "auth_identity_status";
  now_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'road freight event history is append-only'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT s.* INTO current
  FROM "road_freight_shipment" s
  WHERE s."id" = NEW."shipment_id"
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;

  SELECT a."realm", a."status" INTO actor_realm, actor_status
  FROM "auth_identity" a
  WHERE a."id" = NEW."actor_identity_id"
  FOR SHARE;
  IF NOT FOUND OR actor_realm <> 'STAFF' OR actor_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'only active STAFF may record road freight events'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW."occurred_at" < GREATEST(current."created_at", now_at - interval '30 days')
     OR NEW."occurred_at" > now_at + interval '5 minutes' THEN
    RAISE EXCEPTION 'road freight event occurred_at is outside the accepted window'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW."recorded_at" := now_at;

  SELECT max(e."sequence") INTO previous_sequence
  FROM "road_freight_shipment_event" e
  WHERE e."shipment_id" = NEW."shipment_id";

  IF NEW."sequence" <> COALESCE(previous_sequence, 0) + 1 THEN
    RAISE EXCEPTION 'road freight event sequence must be gapless'
      USING ERRCODE = 'check_violation';
  END IF;

  IF previous_sequence IS NULL THEN
    IF NEW."type" <> 'QUOTE'
       OR NEW."lifecycle_status" <> 'QUOTE'
       OR NEW."exception_status" IS NOT NULL
       OR NEW."trip_id" IS NOT NULL
       OR NEW."vehicle_id" IS NOT NULL THEN
      RAISE EXCEPTION 'road freight first event must be QUOTE'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF current."lifecycle_status" IN ('DELIVERED', 'REFUSED', 'CANCELLED') THEN
    RAISE EXCEPTION 'road freight lifecycle is terminal'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF NEW."route_waypoint_id" IS NOT NULL THEN
    IF current."trip_id" IS NULL THEN
      RAISE EXCEPTION 'road freight event waypoint requires an assigned trip'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT rw."route_version_id" INTO waypoint_version
    FROM "route_waypoint" rw WHERE rw."id" = NEW."route_waypoint_id";
    SELECT t."route_version_id" INTO trip_version FROM "trip" t WHERE t."id" = current."trip_id";
    IF waypoint_version IS DISTINCT FROM trip_version THEN
      RAISE EXCEPTION 'road freight event waypoint does not belong to assigned trip'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."trip_id" IS DISTINCT FROM current."trip_id"
     OR NEW."vehicle_id" IS DISTINCT FROM current."vehicle_id" THEN
    RAISE EXCEPTION 'road freight event assignment snapshot mismatch'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."type" = 'ASSIGNMENT_UPDATED' THEN
    IF current."lifecycle_status" <> 'ASSIGNED'
       OR current."exception_status" IS NOT NULL
       OR NEW."lifecycle_status" <> 'ASSIGNED'
       OR NEW."exception_status" IS NOT NULL THEN
      RAISE EXCEPTION 'road freight event projection invalid for assignment update'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."type" = 'EXCEPTION_RESOLVED' THEN
    IF current."exception_status" IS NULL
       OR NEW."lifecycle_status" <> current."lifecycle_status"
       OR NEW."exception_status" IS NOT NULL THEN
      RAISE EXCEPTION 'road freight exception resolution is invalid'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."type" IN ('HELD', 'CUSTOMS_HOLD', 'DAMAGED') THEN
    IF current."exception_status" IS NOT NULL
       OR current."lifecycle_status" NOT IN (
         'BOOKED', 'RECEIVED', 'INSPECTED', 'ASSIGNED', 'LOADED',
         'DEPARTED', 'IN_TRANSIT', 'ARRIVED', 'AVAILABLE'
       )
       OR NEW."lifecycle_status" <> current."lifecycle_status"
       OR NEW."exception_status"::text <> NEW."type"::text THEN
      RAISE EXCEPTION 'road freight exception opening is invalid'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."type" = 'REFUSED' THEN
    IF NEW."lifecycle_status" <> 'REFUSED' OR NEW."exception_status" IS NOT NULL THEN
      RAISE EXCEPTION 'road freight lifecycle REFUSED projection invalid'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."type" = 'CANCELLED' THEN
    IF current."lifecycle_status" NOT IN ('QUOTE', 'BOOKED', 'RECEIVED', 'INSPECTED', 'ASSIGNED')
       OR NEW."lifecycle_status" <> 'CANCELLED'
       OR NEW."exception_status" IS NOT NULL THEN
      RAISE EXCEPTION 'road freight lifecycle cancellation invalid'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF current."exception_status" IS NOT NULL THEN
    RAISE EXCEPTION 'road freight exception must be resolved before progression'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  expected_next := CASE current."lifecycle_status"
    WHEN 'QUOTE' THEN 'BOOKED'
    WHEN 'BOOKED' THEN 'RECEIVED'
    WHEN 'RECEIVED' THEN 'INSPECTED'
    WHEN 'INSPECTED' THEN 'ASSIGNED'
    WHEN 'ASSIGNED' THEN 'LOADED'
    WHEN 'LOADED' THEN 'DEPARTED'
    WHEN 'DEPARTED' THEN 'IN_TRANSIT'
    WHEN 'IN_TRANSIT' THEN 'ARRIVED'
    WHEN 'ARRIVED' THEN 'AVAILABLE'
    WHEN 'AVAILABLE' THEN 'DELIVERED'
    ELSE NULL
  END;

  IF expected_next IS NULL
     OR NEW."type"::text <> expected_next::text
     OR NEW."lifecycle_status" <> expected_next
     OR NEW."exception_status" IS NOT NULL THEN
    RAISE EXCEPTION 'road freight lifecycle transition invalid'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."type" = 'ASSIGNED' AND (current."trip_id" IS NULL OR current."vehicle_id" IS NULL) THEN
    RAISE EXCEPTION 'road freight assignment event requires trip and vehicle'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "road_freight_event_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "road_freight_shipment_event"
  FOR EACH ROW EXECUTE FUNCTION "road_freight_event_guard"();

CREATE FUNCTION "road_freight_projection_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_id UUID;
  shipment RECORD;
  latest RECORD;
BEGIN
  IF TG_TABLE_NAME = 'road_freight_shipment' THEN
    target_id := NEW."id";
  ELSE
    target_id := NEW."shipment_id";
  END IF;
  SELECT s.* INTO shipment FROM "road_freight_shipment" s WHERE s."id" = target_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT e.* INTO latest
  FROM "road_freight_shipment_event" e
  WHERE e."shipment_id" = target_id
  ORDER BY e."sequence" DESC
  LIMIT 1;
  IF NOT FOUND
     OR latest."lifecycle_status" IS DISTINCT FROM shipment."lifecycle_status"
     OR latest."exception_status" IS DISTINCT FROM shipment."exception_status"
     OR latest."trip_id" IS DISTINCT FROM shipment."trip_id"
     OR latest."vehicle_id" IS DISTINCT FROM shipment."vehicle_id" THEN
    RAISE EXCEPTION 'road freight projection mismatch'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "road_freight_shipment_projection_guard"
  AFTER INSERT OR UPDATE ON "road_freight_shipment"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "road_freight_projection_guard"();

CREATE CONSTRAINT TRIGGER "road_freight_event_projection_guard"
  AFTER INSERT ON "road_freight_shipment_event"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "road_freight_projection_guard"();

CREATE FUNCTION "road_freight_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'road freight history cannot be truncated'
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;

CREATE TRIGGER "road_freight_shipment_no_truncate"
  BEFORE TRUNCATE ON "road_freight_shipment"
  FOR EACH STATEMENT EXECUTE FUNCTION "road_freight_no_truncate"();
CREATE TRIGGER "road_freight_event_no_truncate"
  BEFORE TRUNCATE ON "road_freight_shipment_event"
  FOR EACH STATEMENT EXECUTE FUNCTION "road_freight_no_truncate"();


-- CARGO-1 extends CONVOY-1: an active freight assignment keeps its vehicle in
-- the trip convoy. This trigger is the direct-SQL/concurrency backstop; the
-- TripService performs the same check to return a stable public 409.
CREATE FUNCTION "road_freight_trip_convoy_guard"() RETURNS trigger
LANGUAGE plpgsql AS $cargo$
DECLARE
  conflicting_id UUID;
BEGIN
  IF NEW."vehicle_id" IS NOT DISTINCT FROM OLD."vehicle_id"
     AND NEW."support_vehicle_id" IS NOT DISTINCT FROM OLD."support_vehicle_id" THEN
    RETURN NEW;
  END IF;

  SELECT s."id" INTO conflicting_id
  FROM "road_freight_shipment" s
  WHERE s."trip_id" = NEW."id"
    AND s."lifecycle_status" IN (
      'ASSIGNED', 'LOADED', 'DEPARTED', 'IN_TRANSIT', 'ARRIVED', 'AVAILABLE'
    )
    AND s."vehicle_id" IS NOT NULL
    AND s."vehicle_id" IS DISTINCT FROM NEW."vehicle_id"
    AND s."vehicle_id" IS DISTINCT FROM NEW."support_vehicle_id"
  LIMIT 1;

  IF conflicting_id IS NOT NULL THEN
    RAISE EXCEPTION 'active road freight would be orphaned by this convoy change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$cargo$;

CREATE TRIGGER "road_freight_trip_convoy_guard"
  BEFORE UPDATE OF "vehicle_id", "support_vehicle_id" ON "trip"
  FOR EACH ROW EXECUTE FUNCTION "road_freight_trip_convoy_guard"();

INSERT INTO "authorization_permission" ("key", "description") VALUES
  ('cargo.read', 'Read road-freight identity, assignment and operational history'),
  ('cargo.manage', 'Create and manage road-freight records and operational events');

INSERT INTO "authorization_role_permission" ("role_key", "permission_key") VALUES
  ('SUPER_ADMIN', 'cargo.read'),
  ('SUPER_ADMIN', 'cargo.manage'),
  ('DIRECTOR', 'cargo.read'),
  ('DIRECTOR', 'cargo.manage'),
  ('OPS_MANAGER', 'cargo.read'),
  ('OPS_MANAGER', 'cargo.manage'),
  ('DISPATCHER', 'cargo.read'),
  ('DISPATCHER', 'cargo.manage'),
  ('BOOKING_AGENT', 'cargo.read'),
  ('BOOKING_AGENT', 'cargo.manage'),
  ('CUSTOMER_SUPPORT', 'cargo.read');
