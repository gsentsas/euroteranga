-- PR-09 Booking: customer holds and segment-based seat inventory.

-- CreateTable
CREATE TABLE "booking" (
    "id" UUID NOT NULL,
    "reference" VARCHAR(16) NOT NULL,
    "customer_identity_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "origin_route_waypoint_id" UUID NOT NULL,
    "destination_route_waypoint_id" UUID NOT NULL,
    "origin_sequence" INTEGER NOT NULL,
    "destination_sequence" INTEGER NOT NULL,
    "fare_entry_id" UUID NOT NULL,
    "unit_amount_minor" INTEGER NOT NULL,
    "currency_code" VARCHAR(3) NOT NULL,
    "currency_minor_unit" INTEGER NOT NULL,
    "hold_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancellation_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_seat" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "seat_map_cell_id" UUID NOT NULL,
    "released_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_seat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seat_inventory_lock" (
    "id" UUID NOT NULL,
    "booking_seat_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "seat_map_cell_id" UUID NOT NULL,
    "segment_sequence" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seat_inventory_lock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "booking_reference_key" ON "booking"("reference");

-- CreateIndex
CREATE INDEX "booking_customer_identity_id_id_idx" ON "booking"("customer_identity_id", "id");

-- CreateIndex
CREATE INDEX "booking_trip_id_id_idx" ON "booking"("trip_id", "id");

-- CreateIndex
CREATE INDEX "booking_hold_expires_at_id_idx" ON "booking"("hold_expires_at", "id");

-- CreateIndex
CREATE INDEX "booking_origin_route_waypoint_id_idx" ON "booking"("origin_route_waypoint_id");

-- CreateIndex
CREATE INDEX "booking_destination_route_waypoint_id_idx" ON "booking"("destination_route_waypoint_id");

-- CreateIndex
CREATE INDEX "booking_fare_entry_id_idx" ON "booking"("fare_entry_id");

-- CreateIndex
CREATE INDEX "booking_seat_seat_map_cell_id_idx" ON "booking_seat"("seat_map_cell_id");

-- CreateIndex
CREATE UNIQUE INDEX "booking_seat_booking_id_seat_map_cell_id_key" ON "booking_seat"("booking_id", "seat_map_cell_id");

-- CreateIndex
CREATE INDEX "seat_inventory_lock_seat_map_cell_id_idx" ON "seat_inventory_lock"("seat_map_cell_id");

-- CreateIndex
CREATE UNIQUE INDEX "seat_inventory_lock_trip_id_seat_map_cell_id_segment_sequen_key" ON "seat_inventory_lock"("trip_id", "seat_map_cell_id", "segment_sequence");

-- CreateIndex
CREATE UNIQUE INDEX "seat_inventory_lock_booking_seat_id_segment_sequence_key" ON "seat_inventory_lock"("booking_seat_id", "segment_sequence");

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_customer_identity_id_fkey" FOREIGN KEY ("customer_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_origin_route_waypoint_id_fkey" FOREIGN KEY ("origin_route_waypoint_id") REFERENCES "route_waypoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_destination_route_waypoint_id_fkey" FOREIGN KEY ("destination_route_waypoint_id") REFERENCES "route_waypoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_fare_entry_id_fkey" FOREIGN KEY ("fare_entry_id") REFERENCES "fare_entry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_seat" ADD CONSTRAINT "booking_seat_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_seat" ADD CONSTRAINT "booking_seat_seat_map_cell_id_fkey" FOREIGN KEY ("seat_map_cell_id") REFERENCES "seat_map_cell"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seat_inventory_lock" ADD CONSTRAINT "seat_inventory_lock_booking_seat_id_fkey" FOREIGN KEY ("booking_seat_id") REFERENCES "booking_seat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seat_inventory_lock" ADD CONSTRAINT "seat_inventory_lock_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seat_inventory_lock" ADD CONSTRAINT "seat_inventory_lock_seat_map_cell_id_fkey" FOREIGN KEY ("seat_map_cell_id") REFERENCES "seat_map_cell"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- PR-09 Booking. The rules below apply to every writer (API, Prisma, raw SQL,
-- future workers). The service validates first and returns precise public
-- errors; these are the second, authoritative barrier.
-- ---------------------------------------------------------------------------

-- Public reference: ETB- + 12 Crockford base32 characters (CSPRNG, 60 bits).
ALTER TABLE "booking" ADD CONSTRAINT "booking_reference_format"
  CHECK ("reference" ~ '^ETB-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$');
ALTER TABLE "booking" ADD CONSTRAINT "booking_sequences_ordered"
  CHECK ("origin_sequence" > 0 AND "origin_sequence" < "destination_sequence");
ALTER TABLE "booking" ADD CONSTRAINT "booking_unit_amount_positive"
  CHECK ("unit_amount_minor" > 0);
ALTER TABLE "booking" ADD CONSTRAINT "booking_currency_code_format"
  CHECK ("currency_code" ~ '^[A-Z]{3}$');
ALTER TABLE "booking" ADD CONSTRAINT "booking_currency_minor_unit_range"
  CHECK ("currency_minor_unit" BETWEEN 0 AND 3);
ALTER TABLE "booking" ADD CONSTRAINT "booking_hold_after_creation"
  CHECK ("hold_expires_at" > "created_at");
ALTER TABLE "booking" ADD CONSTRAINT "booking_cancellation_consistent"
  CHECK (
    ("cancelled_at" IS NULL) = ("cancellation_reason" IS NULL)
    AND ("cancelled_at" IS NULL OR "cancelled_at" >= "created_at")
    AND (
      "cancellation_reason" IS NULL
      OR (length(btrim("cancellation_reason")) > 0 AND "cancellation_reason" = btrim("cancellation_reason"))
    )
  );
ALTER TABLE "booking_seat" ADD CONSTRAINT "booking_seat_released_after_creation"
  CHECK ("released_at" IS NULL OR "released_at" >= "created_at");
ALTER TABLE "seat_inventory_lock" ADD CONSTRAINT "seat_inventory_lock_segment_positive"
  CHECK ("segment_sequence" > 0);

-- Booking: created as an active hold on a bookable trip, for an exact priced
-- origin/destination; afterwards only a single cancellation is allowed.
CREATE FUNCTION "booking_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  customer_realm "auth_realm";
  customer_status "auth_identity_status";
  trip_row RECORD;
  origin RECORD;
  destination RECORD;
  fare RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bookings cannot be deleted; cancel them instead'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."reference" IS DISTINCT FROM OLD."reference"
       OR NEW."customer_identity_id" IS DISTINCT FROM OLD."customer_identity_id"
       OR NEW."trip_id" IS DISTINCT FROM OLD."trip_id"
       OR NEW."origin_route_waypoint_id" IS DISTINCT FROM OLD."origin_route_waypoint_id"
       OR NEW."destination_route_waypoint_id" IS DISTINCT FROM OLD."destination_route_waypoint_id"
       OR NEW."origin_sequence" IS DISTINCT FROM OLD."origin_sequence"
       OR NEW."destination_sequence" IS DISTINCT FROM OLD."destination_sequence"
       OR NEW."fare_entry_id" IS DISTINCT FROM OLD."fare_entry_id"
       OR NEW."unit_amount_minor" IS DISTINCT FROM OLD."unit_amount_minor"
       OR NEW."currency_code" IS DISTINCT FROM OLD."currency_code"
       OR NEW."currency_minor_unit" IS DISTINCT FROM OLD."currency_minor_unit"
       OR NEW."hold_expires_at" IS DISTINCT FROM OLD."hold_expires_at"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
      RAISE EXCEPTION 'booking identity, journey, price and hold are immutable'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."cancelled_at" IS NOT NULL THEN
      RAISE EXCEPTION 'cancelled bookings are immutable'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF NEW."cancelled_at" IS NOT NULL AND OLD."hold_expires_at" <= now() THEN
      RAISE EXCEPTION 'an expired hold cannot be cancelled'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT
  IF NEW."cancelled_at" IS NOT NULL OR NEW."cancellation_reason" IS NOT NULL THEN
    RAISE EXCEPTION 'bookings must be created as active holds'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT "realm", "status" INTO customer_realm, customer_status
  FROM "auth_identity" WHERE "id" = NEW."customer_identity_id";
  IF FOUND THEN
    IF customer_realm <> 'CUSTOMER' THEN
      RAISE EXCEPTION 'a booking belongs to a CUSTOMER identity'
        USING ERRCODE = 'check_violation';
    END IF;
    IF customer_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'only an ACTIVE customer can hold seats'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- FOR SHARE: a concurrent trip cancellation (FOR UPDATE) is serialized.
  SELECT "status", "route_version_id", "seat_map_version_id", "fare_table_version_id",
         "planned_departure_at"
    INTO trip_row
  FROM "trip" WHERE "id" = NEW."trip_id" FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports the missing trip
  END IF;
  IF trip_row."status" <> 'SCHEDULED' THEN
    RAISE EXCEPTION 'only a SCHEDULED trip can be booked'
      USING ERRCODE = 'check_violation';
  END IF;
  IF trip_row."planned_departure_at" IS NULL OR trip_row."planned_departure_at" <= now() THEN
    RAISE EXCEPTION 'a trip that has departed cannot be booked'
      USING ERRCODE = 'check_violation';
  END IF;
  IF trip_row."seat_map_version_id" IS NULL THEN
    RAISE EXCEPTION 'a booked trip needs a seat map'
      USING ERRCODE = 'check_violation';
  END IF;
  IF trip_row."fare_table_version_id" IS NULL THEN
    RAISE EXCEPTION 'a booked trip needs pricing'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."hold_expires_at" > trip_row."planned_departure_at" THEN
    RAISE EXCEPTION 'a hold cannot outlast the trip departure'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT "route_version_id", "sequence", "stop_id", "boarding_allowed", "alighting_allowed"
    INTO origin
  FROM "route_waypoint" WHERE "id" = NEW."origin_route_waypoint_id";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  SELECT "route_version_id", "sequence", "stop_id", "boarding_allowed", "alighting_allowed"
    INTO destination
  FROM "route_waypoint" WHERE "id" = NEW."destination_route_waypoint_id";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF origin."route_version_id" <> trip_row."route_version_id"
     OR destination."route_version_id" <> trip_row."route_version_id" THEN
    RAISE EXCEPTION 'booking waypoints must belong to the trip route version'
      USING ERRCODE = 'check_violation';
  END IF;
  IF origin."stop_id" IS NULL OR destination."stop_id" IS NULL THEN
    RAISE EXCEPTION 'bookings are between stops only'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT origin."boarding_allowed" THEN
    RAISE EXCEPTION 'the booking origin must allow boarding'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT destination."alighting_allowed" THEN
    RAISE EXCEPTION 'the booking destination must allow alighting'
      USING ERRCODE = 'check_violation';
  END IF;
  IF origin."sequence" >= destination."sequence" THEN
    RAISE EXCEPTION 'the booking origin must come before the destination'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."origin_sequence" <> origin."sequence"
     OR NEW."destination_sequence" <> destination."sequence" THEN
    RAISE EXCEPTION 'booking sequences must be those of its waypoints'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT fe."fare_table_version_id", fe."origin_route_waypoint_id",
         fe."destination_route_waypoint_id", fe."amount_minor",
         ft."currency_code", ft."currency_minor_unit"
    INTO fare
  FROM "fare_entry" fe
  JOIN "fare_table_version" v ON v."id" = fe."fare_table_version_id"
  JOIN "fare_table" ft ON ft."id" = v."fare_table_id"
  WHERE fe."id" = NEW."fare_entry_id";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF fare."fare_table_version_id" <> trip_row."fare_table_version_id" THEN
    RAISE EXCEPTION 'the booking fare must belong to the trip pricing'
      USING ERRCODE = 'check_violation';
  END IF;
  IF fare."origin_route_waypoint_id" <> NEW."origin_route_waypoint_id"
     OR fare."destination_route_waypoint_id" <> NEW."destination_route_waypoint_id" THEN
    RAISE EXCEPTION 'the booking fare must price exactly its origin and destination'
      USING ERRCODE = 'check_violation';
  END IF;
  IF fare."amount_minor" <> NEW."unit_amount_minor"
     OR fare."currency_code" <> NEW."currency_code"
     OR fare."currency_minor_unit" <> NEW."currency_minor_unit" THEN
    RAISE EXCEPTION 'the booking price must be the exact snapshot of its fare'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "booking_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "booking"
  FOR EACH ROW EXECUTE FUNCTION "booking_guard"();

-- BookingSeat: historical. Created on an active hold, for a SEAT cell of the
-- trip's historical seat map; afterwards only released once.
CREATE FUNCTION "booking_seat_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  booking_row RECORD;
  cell RECORD;
  trip_seat_map UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'booking seats are historical and cannot be deleted'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."booking_id" IS DISTINCT FROM OLD."booking_id"
       OR NEW."seat_map_cell_id" IS DISTINCT FROM OLD."seat_map_cell_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
      RAISE EXCEPTION 'a booking seat cannot change'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."released_at" IS NOT NULL AND NEW."released_at" IS DISTINCT FROM OLD."released_at" THEN
      RAISE EXCEPTION 'a released booking seat is final'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF NEW."released_at" IS NOT NULL AND OLD."released_at" IS NULL THEN
      SELECT "cancelled_at", "hold_expires_at" INTO booking_row
      FROM "booking" WHERE "id" = NEW."booking_id";
      IF booking_row."cancelled_at" IS NULL AND booking_row."hold_expires_at" > now() THEN
        RAISE EXCEPTION 'a seat of an active hold cannot be released'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT
  IF NEW."released_at" IS NOT NULL THEN
    RAISE EXCEPTION 'booking seats are created held'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "cancelled_at", "hold_expires_at", "trip_id" INTO booking_row
  FROM "booking" WHERE "id" = NEW."booking_id" FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF booking_row."cancelled_at" IS NOT NULL OR booking_row."hold_expires_at" <= now() THEN
    RAISE EXCEPTION 'seats can only be added to an active hold'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT "seat_map_version_id" INTO trip_seat_map FROM "trip" WHERE "id" = booking_row."trip_id";
  SELECT "seat_map_version_id", "kind" INTO cell
  FROM "seat_map_cell" WHERE "id" = NEW."seat_map_cell_id";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF cell."seat_map_version_id" IS DISTINCT FROM trip_seat_map THEN
    RAISE EXCEPTION 'a booked seat must belong to the trip seat map'
      USING ERRCODE = 'check_violation';
  END IF;
  IF cell."kind" <> 'SEAT' THEN
    RAISE EXCEPTION 'only SEAT cells can be booked'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "booking_seat_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "booking_seat"
  FOR EACH ROW EXECUTE FUNCTION "booking_seat_guard"();

-- SeatInventoryLock: one seat on one segment [n, n + 1) of an active hold.
-- Immutable; deletable only once its hold is cancelled or expired.
CREATE FUNCTION "seat_inventory_lock_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  seat_row RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'seat inventory locks are immutable; release them by deletion'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    SELECT b."cancelled_at", b."hold_expires_at" INTO seat_row
    FROM "booking_seat" bs JOIN "booking" b ON b."id" = bs."booking_id"
    WHERE bs."id" = OLD."booking_seat_id";
    IF FOUND AND seat_row."cancelled_at" IS NULL AND seat_row."hold_expires_at" > now() THEN
      RAISE EXCEPTION 'the seat lock of an active hold cannot be deleted'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN OLD;
  END IF;

  -- INSERT
  SELECT bs."seat_map_cell_id", bs."released_at", b."trip_id", b."origin_sequence",
         b."destination_sequence", b."cancelled_at", b."hold_expires_at"
    INTO seat_row
  FROM "booking_seat" bs JOIN "booking" b ON b."id" = bs."booking_id"
  WHERE bs."id" = NEW."booking_seat_id"
  FOR SHARE OF b;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF NEW."trip_id" <> seat_row."trip_id" OR NEW."seat_map_cell_id" <> seat_row."seat_map_cell_id" THEN
    RAISE EXCEPTION 'a seat lock must match its booking seat and trip'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."segment_sequence" < seat_row."origin_sequence"
     OR NEW."segment_sequence" >= seat_row."destination_sequence" THEN
    RAISE EXCEPTION 'a seat lock must cover a segment of its booking journey'
      USING ERRCODE = 'check_violation';
  END IF;
  IF seat_row."released_at" IS NOT NULL OR seat_row."cancelled_at" IS NOT NULL
     OR seat_row."hold_expires_at" <= now() THEN
    RAISE EXCEPTION 'only an active hold can lock seats'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "seat_inventory_lock_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "seat_inventory_lock"
  FOR EACH ROW EXECUTE FUNCTION "seat_inventory_lock_guard"();

-- Row-level DELETE triggers do not fire for TRUNCATE.
CREATE FUNCTION "booking_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'booking history and seat inventory cannot be truncated'
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;

CREATE TRIGGER "booking_no_truncate"
  BEFORE TRUNCATE ON "booking"
  FOR EACH STATEMENT EXECUTE FUNCTION "booking_no_truncate"();
CREATE TRIGGER "booking_seat_no_truncate"
  BEFORE TRUNCATE ON "booking_seat"
  FOR EACH STATEMENT EXECUTE FUNCTION "booking_no_truncate"();
CREATE TRIGGER "seat_inventory_lock_no_truncate"
  BEFORE TRUNCATE ON "seat_inventory_lock"
  FOR EACH STATEMENT EXECUTE FUNCTION "booking_no_truncate"();

-- Trip lifecycle (PR-06, PR-07, PR-08 rules kept verbatim): a trip with active
-- booking holds cannot become CANCELLED before they are released.
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

    -- PR-09: a cancellation releases every active booking hold first, in the
    -- same transaction (BOOKING_CANCELLED_BY_TRIP).
    IF NEW."status" = 'CANCELLED' AND EXISTS (
      SELECT 1 FROM "booking"
      WHERE "trip_id" = NEW."id" AND "cancelled_at" IS NULL AND "hold_expires_at" > now()
    ) THEN
      RAISE EXCEPTION 'a trip with active booking holds cannot be cancelled'
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

-- Authorization catalogue (PR-03 model): explicit grants, no wildcard.
INSERT INTO "authorization_permission" ("key", "description") VALUES
  ('booking.read', 'Read customer booking holds, their seats and prices'),
  ('booking.manage', 'Cancel customer booking holds');

INSERT INTO "authorization_role_permission" ("role_key", "permission_key") VALUES
  ('SUPER_ADMIN', 'booking.read'),
  ('SUPER_ADMIN', 'booking.manage'),
  ('DIRECTOR', 'booking.read'),
  ('DIRECTOR', 'booking.manage'),
  ('OPS_MANAGER', 'booking.read'),
  ('OPS_MANAGER', 'booking.manage'),
  ('BOOKING_AGENT', 'booking.read'),
  ('BOOKING_AGENT', 'booking.manage'),
  ('CUSTOMER_SUPPORT', 'booking.read'),
  ('CUSTOMER_SUPPORT', 'booking.manage');
