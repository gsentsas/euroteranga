-- PR-10 Payments: provider abstraction, payment attempts, provider events and
-- booking confirmation.

-- CreateEnum
CREATE TYPE "payment_provider" AS ENUM ('SANDBOX');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "payment_event_type" AS ENUM ('PAYMENT_SUCCEEDED', 'PAYMENT_FAILED');

-- AlterTable
ALTER TABLE "booking" ADD COLUMN     "confirmed_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "payment" (
    "id" UUID NOT NULL,
    "reference" VARCHAR(16) NOT NULL,
    "booking_id" UUID NOT NULL,
    "customer_identity_id" UUID NOT NULL,
    "provider" "payment_provider" NOT NULL,
    "provider_payment_id" VARCHAR(128),
    "status" "payment_status" NOT NULL DEFAULT 'PENDING',
    "amount_minor" BIGINT NOT NULL,
    "currency_code" VARCHAR(3) NOT NULL,
    "currency_minor_unit" INTEGER NOT NULL,
    "idempotency_key" VARCHAR(64),
    "failure_code" VARCHAR(48),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "succeeded_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_event" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "provider" "payment_provider" NOT NULL,
    "provider_event_id" VARCHAR(128) NOT NULL,
    "type" "payment_event_type" NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "processed_at" TIMESTAMPTZ(3),
    "rejection_code" VARCHAR(48),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_reference_key" ON "payment"("reference");

-- CreateIndex
CREATE INDEX "payment_booking_id_id_idx" ON "payment"("booking_id", "id");

-- CreateIndex
CREATE INDEX "payment_status_id_idx" ON "payment"("status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_provider_provider_payment_id_key" ON "payment"("provider", "provider_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_customer_identity_id_idempotency_key_key" ON "payment"("customer_identity_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "payment_event_payment_id_id_idx" ON "payment_event"("payment_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_event_provider_provider_event_id_key" ON "payment_event"("provider", "provider_event_id");

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_customer_identity_id_fkey" FOREIGN KEY ("customer_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_event" ADD CONSTRAINT "payment_event_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- PR-10 Payments. The rules below apply to every writer (API, Prisma, raw SQL,
-- future workers). The service validates first and returns precise public
-- errors; these are the second, authoritative barrier.
--
-- Lock hierarchy (no cycle): trip -> payment -> booking -> booking seats ->
-- seat locks. Payment initiation takes the trip FOR SHARE, then the booking,
-- then inserts the attempt; webhooks lock the payment, then its booking; trip
-- cancellation locks the trip, the trip's PENDING payments, then its bookings.
-- Nothing locks the trip after a booking, or a payment after a booking.
-- ---------------------------------------------------------------------------

-- Booking confirmation: never cancelled at the same time, within the hold.
ALTER TABLE "booking" ADD CONSTRAINT "booking_confirmation_consistent"
  CHECK (
    "confirmed_at" IS NULL
    OR ("cancelled_at" IS NULL AND "confirmed_at" >= "created_at" AND "confirmed_at" < "hold_expires_at")
  );

-- Public reference: ETP- + 12 Crockford base32 characters (CSPRNG, 60 bits).
ALTER TABLE "payment" ADD CONSTRAINT "payment_reference_format"
  CHECK ("reference" ~ '^ETP-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$');
ALTER TABLE "payment" ADD CONSTRAINT "payment_amount_positive"
  CHECK ("amount_minor" > 0);
ALTER TABLE "payment" ADD CONSTRAINT "payment_currency_code_format"
  CHECK ("currency_code" ~ '^[A-Z]{3}$');
ALTER TABLE "payment" ADD CONSTRAINT "payment_currency_minor_unit_range"
  CHECK ("currency_minor_unit" BETWEEN 0 AND 3);
ALTER TABLE "payment" ADD CONSTRAINT "payment_provider_payment_id_format"
  CHECK ("provider_payment_id" IS NULL OR "provider_payment_id" ~ '^[A-Za-z0-9_-]{8,128}$');
ALTER TABLE "payment" ADD CONSTRAINT "payment_idempotency_key_format"
  CHECK ("idempotency_key" IS NULL OR "idempotency_key" ~ '^[A-Za-z0-9_-]{16,64}$');
-- Normalized failure codes only: never raw provider text.
ALTER TABLE "payment" ADD CONSTRAINT "payment_failure_code_known"
  CHECK ("failure_code" IS NULL OR "failure_code" IN ('DECLINED', 'INSUFFICIENT_FUNDS', 'AUTHENTICATION_FAILED', 'CHECKOUT_EXPIRED', 'PROVIDER_ERROR', 'UNKNOWN', 'BOOKING_EXPIRED', 'BOOKING_NOT_PAYABLE'));
-- Exactly the timestamp (and failure code) of the current status.
ALTER TABLE "payment" ADD CONSTRAINT "payment_status_consistent"
  CHECK (
    ("status" = 'SUCCEEDED') = ("succeeded_at" IS NOT NULL)
    AND ("status" = 'FAILED') = ("failed_at" IS NOT NULL)
    AND ("status" = 'FAILED') = ("failure_code" IS NOT NULL)
    AND ("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)
  );
ALTER TABLE "payment" ADD CONSTRAINT "payment_transition_after_creation"
  CHECK (
    ("succeeded_at" IS NULL OR "succeeded_at" >= "created_at")
    AND ("failed_at" IS NULL OR "failed_at" >= "created_at")
    AND ("cancelled_at" IS NULL OR "cancelled_at" >= "created_at")
  );

ALTER TABLE "payment_event" ADD CONSTRAINT "payment_event_provider_event_id_format"
  CHECK ("provider_event_id" ~ '^[A-Za-z0-9_.:-]{8,128}$');
ALTER TABLE "payment_event" ADD CONSTRAINT "payment_event_payload_hash_format"
  CHECK ("payload_hash" ~ '^[0-9a-f]{64}$');
-- An event either moved its payment (processed) or is recorded with the
-- stable reason it changed nothing.
ALTER TABLE "payment_event" ADD CONSTRAINT "payment_event_outcome_consistent"
  CHECK (
    ("processed_at" IS NULL) <> ("rejection_code" IS NULL)
    AND ("processed_at" IS NULL OR "processed_at" >= "received_at")
    AND ("rejection_code" IS NULL OR "rejection_code" IN ('AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'PAYMENT_NOT_PENDING', 'PAYMENT_ALREADY_SUCCEEDED'))
  );

-- At most one attempt in progress and one success per booking; at most one
-- event processed per payment (its single terminal transition).
CREATE UNIQUE INDEX "payment_one_pending_per_booking"
  ON "payment"("booking_id") WHERE "status" = 'PENDING';
CREATE UNIQUE INDEX "payment_one_succeeded_per_booking"
  ON "payment"("booking_id") WHERE "status" = 'SUCCEEDED';
CREATE UNIQUE INDEX "payment_event_one_processed_per_payment"
  ON "payment_event"("payment_id") WHERE "processed_at" IS NOT NULL;

-- Payment: created PENDING by the booking owner for an active hold of a
-- SCHEDULED trip, with the exact booking total; afterwards a single terminal
-- transition. An isolated Payment UPDATE cannot mark paid: SUCCEEDED and
-- FAILED need a processed event, and success needs booking confirmation in the
-- same transaction. Provider authenticity is checked by the API webhook
-- boundary; actors with full SQL access are in the trusted computing base.
-- Never deleted.
CREATE FUNCTION "payment_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  booking_row RECORD;
  trip_state "trip_status";
  seat_count BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payments cannot be deleted'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."reference" IS DISTINCT FROM OLD."reference"
       OR NEW."booking_id" IS DISTINCT FROM OLD."booking_id"
       OR NEW."customer_identity_id" IS DISTINCT FROM OLD."customer_identity_id"
       OR NEW."provider" IS DISTINCT FROM OLD."provider"
       OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
       OR NEW."currency_code" IS DISTINCT FROM OLD."currency_code"
       OR NEW."currency_minor_unit" IS DISTINCT FROM OLD."currency_minor_unit"
       OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
      RAISE EXCEPTION 'payment identity, booking and amount are immutable'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'a % payment is final', OLD."status"
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF OLD."provider_payment_id" IS NOT NULL
       AND NEW."provider_payment_id" IS DISTINCT FROM OLD."provider_payment_id" THEN
      RAISE EXCEPTION 'the provider payment id is immutable once known'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'SUCCEEDED' THEN
      IF NOT EXISTS (
        SELECT 1 FROM "payment_event" e
        WHERE e."payment_id" = NEW."id" AND e."type" = 'PAYMENT_SUCCEEDED'
          AND e."processed_at" IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'a payment succeeds only through a processed provider success event'
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT "cancelled_at", "confirmed_at", "hold_expires_at" INTO booking_row
      FROM "booking" WHERE "id" = NEW."booking_id" FOR SHARE;
      IF booking_row."cancelled_at" IS NOT NULL OR booking_row."confirmed_at" IS NOT NULL
         OR booking_row."hold_expires_at" <= now() THEN
        RAISE EXCEPTION 'only the payment of an active hold can succeed'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
    ELSIF NEW."status" = 'FAILED' THEN
      IF NOT EXISTS (
        SELECT 1 FROM "payment_event" e
        WHERE e."payment_id" = NEW."id" AND e."processed_at" IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'a payment fails only through a processed provider event'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT
  IF NEW."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'payments must be created PENDING'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "customer_identity_id", "trip_id", "unit_amount_minor", "currency_code",
         "currency_minor_unit", "cancelled_at", "confirmed_at", "hold_expires_at"
    INTO booking_row
  FROM "booking" WHERE "id" = NEW."booking_id" FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports the missing booking
  END IF;
  IF NEW."customer_identity_id" <> booking_row."customer_identity_id" THEN
    RAISE EXCEPTION 'a payment is made by the owner of its booking'
      USING ERRCODE = 'check_violation';
  END IF;
  IF booking_row."cancelled_at" IS NOT NULL OR booking_row."confirmed_at" IS NOT NULL
     OR booking_row."hold_expires_at" <= now() THEN
    RAISE EXCEPTION 'only an active hold can be paid'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT "status" INTO trip_state FROM "trip" WHERE "id" = booking_row."trip_id";
  IF trip_state IS DISTINCT FROM 'SCHEDULED' THEN
    RAISE EXCEPTION 'only a booking of a SCHEDULED trip can be paid'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT count(*) INTO seat_count FROM "booking_seat" WHERE "booking_id" = NEW."booking_id";
  IF NEW."amount_minor" <> booking_row."unit_amount_minor"::bigint * seat_count
     OR NEW."currency_code" <> booking_row."currency_code"
     OR NEW."currency_minor_unit" <> booking_row."currency_minor_unit" THEN
    RAISE EXCEPTION 'the payment amount must be the exact total of its booking'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "payment"
  FOR EACH ROW EXECUTE FUNCTION "payment_guard"();

-- A succeeded payment and its booking confirmation commit together.
CREATE FUNCTION "payment_success_confirms_booking"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'SUCCEEDED' AND NOT EXISTS (
    SELECT 1 FROM "booking" WHERE "id" = NEW."booking_id" AND "confirmed_at" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'a succeeded payment must confirm its booking in the same transaction'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "payment_success_confirms_booking"
  AFTER UPDATE ON "payment"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "payment_success_confirms_booking"();

-- PaymentEvent: append-only. An event comes from its payment's provider and
-- can only be processed while that payment is PENDING.
CREATE FUNCTION "payment_event_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  payment_row RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'payment events are immutable'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT "provider", "status" INTO payment_row FROM "payment" WHERE "id" = NEW."payment_id";
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports the missing payment
  END IF;
  IF NEW."provider" <> payment_row."provider" THEN
    RAISE EXCEPTION 'a payment event comes from the provider of its payment'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."processed_at" IS NOT NULL AND payment_row."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'only an event of a PENDING payment can be processed'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_event_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "payment_event"
  FOR EACH ROW EXECUTE FUNCTION "payment_event_guard"();

-- Row-level DELETE triggers do not fire for TRUNCATE.
CREATE FUNCTION "payment_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payment history cannot be truncated (%)', TG_TABLE_NAME
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;

CREATE TRIGGER "payment_no_truncate"
  BEFORE TRUNCATE ON "payment"
  FOR EACH STATEMENT EXECUTE FUNCTION "payment_no_truncate"();
CREATE TRIGGER "payment_event_no_truncate"
  BEFORE TRUNCATE ON "payment_event"
  FOR EACH STATEMENT EXECUTE FUNCTION "payment_no_truncate"();

-- Booking (PR-09 rules kept verbatim): confirmation once, by a succeeded
-- payment, while the hold is active; a confirmed booking cannot be cancelled.
CREATE OR REPLACE FUNCTION "booking_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  customer_realm "auth_realm";
  customer_status "auth_identity_status";
  trip_row RECORD;
  origin RECORD;
  destination RECORD;
  fare RECORD;
  confirming_trip_status "trip_status";
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
    -- PR-10: a confirmed (paid) booking is final while refunds do not exist.
    IF OLD."confirmed_at" IS NOT NULL THEN
      IF NEW."cancelled_at" IS NOT NULL THEN
        RAISE EXCEPTION 'a confirmed booking cannot be cancelled (no refund workflow yet)'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
      IF NEW."confirmed_at" IS DISTINCT FROM OLD."confirmed_at" THEN
        RAISE EXCEPTION 'the confirmation of a booking is immutable'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW."cancelled_at" IS NOT NULL AND OLD."hold_expires_at" <= now() THEN
      RAISE EXCEPTION 'an expired hold cannot be cancelled'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    -- PR-10: confirmation (NULL -> timestamp, once) of a still active hold,
    -- only by a succeeded payment of this booking. The trip is read without a
    -- lock: booking -> trip would form a cycle with trip cancellation, which
    -- locks the trip first and then every booking of the trip.
    IF NEW."confirmed_at" IS NOT NULL THEN
      IF OLD."hold_expires_at" <= now() THEN
        RAISE EXCEPTION 'an expired hold cannot be confirmed'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
      SELECT "status" INTO confirming_trip_status FROM "trip" WHERE "id" = NEW."trip_id";
      IF confirming_trip_status IS DISTINCT FROM 'SCHEDULED' THEN
        RAISE EXCEPTION 'only a booking of a SCHEDULED trip can be confirmed'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM "payment" p
        WHERE p."booking_id" = NEW."id" AND p."status" = 'SUCCEEDED'
      ) THEN
        RAISE EXCEPTION 'a booking is confirmed only by a succeeded payment'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT
  IF NEW."cancelled_at" IS NOT NULL OR NEW."cancellation_reason" IS NOT NULL
     OR NEW."confirmed_at" IS NOT NULL THEN
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

-- BookingSeat (PR-09 rules kept verbatim): the seats of a confirmed booking
-- are never released and none can be added.
CREATE OR REPLACE FUNCTION "booking_seat_guard"() RETURNS trigger
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
      SELECT "cancelled_at", "hold_expires_at", "confirmed_at" INTO booking_row
      FROM "booking" WHERE "id" = NEW."booking_id";
      -- PR-10: a confirmed booking keeps its seats, even after hold_expires_at.
      IF booking_row."confirmed_at" IS NOT NULL THEN
        RAISE EXCEPTION 'a seat of a confirmed booking cannot be released'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
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
  SELECT "cancelled_at", "hold_expires_at", "trip_id", "confirmed_at" INTO booking_row
  FROM "booking" WHERE "id" = NEW."booking_id" FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  -- PR-10: the seats (and so the amount) of a confirmed booking are final.
  IF booking_row."confirmed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'seats cannot be added to a confirmed booking'
      USING ERRCODE = 'object_not_in_prerequisite_state';
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

-- SeatInventoryLock (PR-09 rules kept verbatim): the locks of a confirmed
-- booking are permanent; a confirmed booking takes no new lock.
CREATE OR REPLACE FUNCTION "seat_inventory_lock_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  seat_row RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'seat inventory locks are immutable; release them by deletion'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    SELECT b."cancelled_at", b."hold_expires_at", b."confirmed_at" INTO seat_row
    FROM "booking_seat" bs JOIN "booking" b ON b."id" = bs."booking_id"
    WHERE bs."id" = OLD."booking_seat_id";
    -- PR-10: the inventory of a confirmed booking stays occupied for good.
    IF FOUND AND seat_row."confirmed_at" IS NOT NULL THEN
      RAISE EXCEPTION 'the seat lock of a confirmed booking cannot be deleted'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF FOUND AND seat_row."cancelled_at" IS NULL AND seat_row."hold_expires_at" > now() THEN
      RAISE EXCEPTION 'the seat lock of an active hold cannot be deleted'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN OLD;
  END IF;

  -- INSERT
  SELECT bs."seat_map_cell_id", bs."released_at", b."trip_id", b."origin_sequence",
         b."destination_sequence", b."cancelled_at", b."hold_expires_at", b."confirmed_at"
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
     OR seat_row."confirmed_at" IS NOT NULL OR seat_row."hold_expires_at" <= now() THEN
    RAISE EXCEPTION 'only an active hold can lock seats'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END;
$$;

-- Trip lifecycle (PR-06 to PR-09 rules kept verbatim): a trip with a
-- confirmed booking cannot become CANCELLED.
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

    -- PR-10: refunds do not exist yet, so a trip with a confirmed (paid)
    -- booking cannot be cancelled (TRIP_HAS_CONFIRMED_BOOKINGS).
    IF NEW."status" = 'CANCELLED' AND EXISTS (
      SELECT 1 FROM "booking"
      WHERE "trip_id" = NEW."id" AND "confirmed_at" IS NOT NULL AND "cancelled_at" IS NULL
    ) THEN
      RAISE EXCEPTION 'a trip with confirmed bookings cannot be cancelled'
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
  ('payment.read', 'Read payment attempts, their amounts and provider events'),
  ('payment.manage', 'Cancel a pending payment attempt (never mark one paid)');

INSERT INTO "authorization_role_permission" ("role_key", "permission_key") VALUES
  ('SUPER_ADMIN', 'payment.read'),
  ('SUPER_ADMIN', 'payment.manage'),
  ('DIRECTOR', 'payment.read'),
  ('DIRECTOR', 'payment.manage'),
  ('OPS_MANAGER', 'payment.read'),
  ('BOOKING_AGENT', 'payment.read'),
  ('CUSTOMER_SUPPORT', 'payment.read'),
  ('FINANCE', 'payment.read'),
  ('FINANCE', 'payment.manage'),
  ('AUDITOR', 'payment.read');
