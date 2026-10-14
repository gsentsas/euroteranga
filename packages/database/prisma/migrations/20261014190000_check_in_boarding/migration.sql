-- PR-14 Check-in / Boarding: seat assignment of a BookingPassenger, the one
-- append-only check-in with its readiness snapshot and boarding credential,
-- and the one append-only boarding. Additive only: no backfill, no earlier
-- table rewritten (booking_seat only gains a unique (id, booking_id) target).

-- CreateTable
CREATE TABLE "booking_passenger_seat" (
    "booking_id" UUID NOT NULL,
    "passenger_id" UUID NOT NULL,
    "booking_seat_id" UUID NOT NULL,
    "assigned_by_identity_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_passenger_seat_pkey" PRIMARY KEY ("booking_id","passenger_id")
);

-- CreateTable
CREATE TABLE "passenger_check_in" (
    "id" UUID NOT NULL,
    "reference" VARCHAR(16) NOT NULL,
    "credential_reference" VARCHAR(20) NOT NULL,
    "booking_id" UUID NOT NULL,
    "passenger_id" UUID NOT NULL,
    "booking_seat_id" UUID NOT NULL,
    "compliance_evaluation_id" UUID NOT NULL,
    "compliance_review_id" UUID,
    "engine_version" VARCHAR(32) NOT NULL,
    "readiness_fingerprint" CHAR(64) NOT NULL,
    "readiness_snapshot" JSONB NOT NULL,
    "checked_in_by_identity_id" UUID NOT NULL,
    "checked_in_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "passenger_check_in_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "passenger_boarding" (
    "id" UUID NOT NULL,
    "reference" VARCHAR(16) NOT NULL,
    "check_in_id" UUID NOT NULL,
    "device_id" VARCHAR(64) NOT NULL,
    "client_event_id" VARCHAR(64),
    "payload_fingerprint" CHAR(64) NOT NULL,
    "readiness_fingerprint" CHAR(64) NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "boarded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "boarded_by_identity_id" UUID NOT NULL,

    CONSTRAINT "passenger_boarding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "booking_passenger_seat_booking_seat_id_key" ON "booking_passenger_seat"("booking_seat_id");

-- CreateIndex
CREATE INDEX "booking_passenger_seat_assigned_by_identity_id_idx" ON "booking_passenger_seat"("assigned_by_identity_id");

-- CreateIndex
CREATE UNIQUE INDEX "booking_passenger_seat_booking_id_passenger_id_booking_seat_key" ON "booking_passenger_seat"("booking_id", "passenger_id", "booking_seat_id");

-- CreateIndex
CREATE UNIQUE INDEX "passenger_check_in_reference_key" ON "passenger_check_in"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "passenger_check_in_credential_reference_key" ON "passenger_check_in"("credential_reference");

-- CreateIndex
CREATE INDEX "passenger_check_in_checked_in_at_id_idx" ON "passenger_check_in"("checked_in_at", "id");

-- CreateIndex
CREATE INDEX "passenger_check_in_compliance_evaluation_id_idx" ON "passenger_check_in"("compliance_evaluation_id");

-- CreateIndex
CREATE INDEX "passenger_check_in_compliance_review_id_idx" ON "passenger_check_in"("compliance_review_id");

-- CreateIndex
CREATE INDEX "passenger_check_in_checked_in_by_identity_id_idx" ON "passenger_check_in"("checked_in_by_identity_id");

-- CreateIndex
CREATE UNIQUE INDEX "passenger_check_in_booking_id_passenger_id_key" ON "passenger_check_in"("booking_id", "passenger_id");

-- CreateIndex
CREATE UNIQUE INDEX "passenger_boarding_reference_key" ON "passenger_boarding"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "passenger_boarding_check_in_id_key" ON "passenger_boarding"("check_in_id");

-- CreateIndex
CREATE INDEX "passenger_boarding_boarded_at_id_idx" ON "passenger_boarding"("boarded_at", "id");

-- CreateIndex
CREATE INDEX "passenger_boarding_boarded_by_identity_id_idx" ON "passenger_boarding"("boarded_by_identity_id");

-- CreateIndex
CREATE UNIQUE INDEX "passenger_boarding_device_id_client_event_id_key" ON "passenger_boarding"("device_id", "client_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "booking_seat_id_booking_id_key" ON "booking_seat"("id", "booking_id");

-- AddForeignKey
ALTER TABLE "booking_passenger_seat" ADD CONSTRAINT "booking_passenger_seat_booking_passenger_fkey" FOREIGN KEY ("booking_id", "passenger_id") REFERENCES "booking_passenger"("booking_id", "passenger_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_passenger_seat" ADD CONSTRAINT "booking_passenger_seat_booking_seat_fkey" FOREIGN KEY ("booking_seat_id", "booking_id") REFERENCES "booking_seat"("id", "booking_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_passenger_seat" ADD CONSTRAINT "booking_passenger_seat_assigned_by_identity_id_fkey" FOREIGN KEY ("assigned_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "passenger_check_in" ADD CONSTRAINT "passenger_check_in_booking_passenger_fkey" FOREIGN KEY ("booking_id", "passenger_id") REFERENCES "booking_passenger"("booking_id", "passenger_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "passenger_check_in" ADD CONSTRAINT "passenger_check_in_seat_assignment_fkey" FOREIGN KEY ("booking_id", "passenger_id", "booking_seat_id") REFERENCES "booking_passenger_seat"("booking_id", "passenger_id", "booking_seat_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "passenger_check_in" ADD CONSTRAINT "passenger_check_in_compliance_evaluation_id_fkey" FOREIGN KEY ("compliance_evaluation_id") REFERENCES "compliance_evaluation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "passenger_check_in" ADD CONSTRAINT "passenger_check_in_compliance_review_id_fkey" FOREIGN KEY ("compliance_review_id") REFERENCES "compliance_review"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "passenger_check_in" ADD CONSTRAINT "passenger_check_in_checked_in_by_identity_id_fkey" FOREIGN KEY ("checked_in_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "passenger_boarding" ADD CONSTRAINT "passenger_boarding_check_in_id_fkey" FOREIGN KEY ("check_in_id") REFERENCES "passenger_check_in"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "passenger_boarding" ADD CONSTRAINT "passenger_boarding_boarded_by_identity_id_fkey" FOREIGN KEY ("boarded_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- CHECK constraints: public formats, fingerprints and bounded metadata.
ALTER TABLE "passenger_check_in" ADD CONSTRAINT "passenger_check_in_reference_format"
  CHECK ("reference" ~ '^ETK-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$');
ALTER TABLE "passenger_check_in" ADD CONSTRAINT "passenger_check_in_credential_format"
  CHECK ("credential_reference" ~ '^ETQ-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{16}$');
ALTER TABLE "passenger_check_in" ADD CONSTRAINT "passenger_check_in_fingerprint_format"
  CHECK ("readiness_fingerprint" ~ '^[0-9a-f]{64}$');
ALTER TABLE "passenger_check_in" ADD CONSTRAINT "passenger_check_in_engine_format"
  CHECK ("engine_version" ~ '^checkin-readiness/[1-9][0-9]*$');
ALTER TABLE "passenger_check_in" ADD CONSTRAINT "passenger_check_in_snapshot_object"
  CHECK (jsonb_typeof("readiness_snapshot") = 'object');
ALTER TABLE "passenger_boarding" ADD CONSTRAINT "passenger_boarding_reference_format"
  CHECK ("reference" ~ '^ETE-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$');
ALTER TABLE "passenger_boarding" ADD CONSTRAINT "passenger_boarding_device_id_format"
  CHECK ("device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$');
ALTER TABLE "passenger_boarding" ADD CONSTRAINT "passenger_boarding_client_event_id_format"
  CHECK ("client_event_id" IS NULL OR "client_event_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$');
ALTER TABLE "passenger_boarding" ADD CONSTRAINT "passenger_boarding_fingerprint_format"
  CHECK ("payload_fingerprint" ~ '^[0-9a-f]{64}$' AND "readiness_fingerprint" ~ '^[0-9a-f]{64}$');

-- A seat assignment links an existing, unreleased BookingSeat of the same
-- confirmed, active booking on a SCHEDULED trip (composite FKs prove the
-- same booking). It is changeable until check-in and never deleted.
CREATE FUNCTION "booking_passenger_seat_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  seat RECORD;
  actor_realm "auth_realm";
  actor_status "auth_identity_status";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'seat assignments are never deleted; reassign before check-in instead'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."booking_id" IS DISTINCT FROM OLD."booking_id"
       OR NEW."passenger_id" IS DISTINCT FROM OLD."passenger_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
      RAISE EXCEPTION 'the seat assignment subject is immutable'
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "passenger_check_in" c
      WHERE c."booking_id" = OLD."booking_id" AND c."passenger_id" = OLD."passenger_id"
    ) THEN
      RAISE EXCEPTION 'the seat of a checked-in passenger is immutable'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;

  SELECT bs."released_at", b."confirmed_at", b."cancelled_at", b."customer_identity_id",
         t."status" AS trip_status
    INTO seat
  FROM "booking_seat" bs
  JOIN "booking" b ON b."id" = bs."booking_id"
  JOIN "trip" t ON t."id" = b."trip_id"
  WHERE bs."id" = NEW."booking_seat_id" AND bs."booking_id" = NEW."booking_id"
  FOR SHARE OF bs;
  IF NOT FOUND THEN
    RETURN NEW; -- the composite foreign key reports a foreign or unknown seat
  END IF;
  IF seat."released_at" IS NOT NULL THEN
    RAISE EXCEPTION 'a released seat cannot be assigned'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF seat."confirmed_at" IS NULL OR seat."cancelled_at" IS NOT NULL
     OR seat.trip_status <> 'SCHEDULED' THEN
    RAISE EXCEPTION 'seat assignment requires a confirmed, active scheduled journey'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT "realm", "status" INTO actor_realm, actor_status
  FROM "auth_identity" WHERE "id" = NEW."assigned_by_identity_id";
  IF FOUND AND (
    actor_status <> 'ACTIVE'
    OR NOT (actor_realm = 'STAFF'
            OR (actor_realm = 'CUSTOMER' AND NEW."assigned_by_identity_id" = seat."customer_identity_id"))
  ) THEN
    RAISE EXCEPTION 'only the active booking customer or active STAFF may assign a seat'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW."assigned_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "booking_passenger_seat_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "booking_passenger_seat"
  FOR EACH ROW EXECUTE FUNCTION "booking_passenger_seat_guard"();

-- The check-in is append-only and pins the current seat assignment (FK with
-- ON UPDATE RESTRICT). PostgreSQL re-checks the hard gates it can know:
-- confirmed active booking, SCHEDULED trip, succeeded payment, unreleased
-- seat, the latest compliance evaluation of the same passenger with a PASS
-- result or a current COMPLIANT head review, and the actor.
CREATE FUNCTION "passenger_check_in_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  subject RECORD;
  evaluation RECORD;
  review RECORD;
  actor_realm "auth_realm";
  actor_status "auth_identity_status";
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'passenger check-ins are append-only'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT a."booking_seat_id", bs."released_at", b."confirmed_at", b."cancelled_at",
         b."customer_identity_id", t."status" AS trip_status
    INTO subject
  FROM "booking_passenger_seat" a
  JOIN "booking_seat" bs ON bs."id" = a."booking_seat_id"
  JOIN "booking" b ON b."id" = a."booking_id"
  JOIN "trip" t ON t."id" = b."trip_id"
  WHERE a."booking_id" = NEW."booking_id" AND a."passenger_id" = NEW."passenger_id"
  FOR SHARE OF a;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a check-in requires a seat assignment'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF subject."booking_seat_id" <> NEW."booking_seat_id" THEN
    RAISE EXCEPTION 'a check-in pins the current seat assignment'
      USING ERRCODE = 'check_violation';
  END IF;
  IF subject."released_at" IS NOT NULL THEN
    RAISE EXCEPTION 'a released seat cannot be checked in'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF subject."confirmed_at" IS NULL OR subject."cancelled_at" IS NOT NULL
     OR subject.trip_status <> 'SCHEDULED' THEN
    RAISE EXCEPTION 'check-in requires a confirmed, active scheduled journey'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "payment" p
    WHERE p."booking_id" = NEW."booking_id" AND p."status" = 'SUCCEEDED'
  ) THEN
    RAISE EXCEPTION 'check-in requires a succeeded payment'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT e."booking_id", e."passenger_id", e."result", e."evaluated_at", e."id"
    INTO evaluation
  FROM "compliance_evaluation" e WHERE e."id" = NEW."compliance_evaluation_id";
  IF FOUND THEN
    IF evaluation."booking_id" <> NEW."booking_id"
       OR evaluation."passenger_id" <> NEW."passenger_id" THEN
      RAISE EXCEPTION 'the compliance evaluation must belong to the checked-in passenger'
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "compliance_evaluation" later
      WHERE later."booking_id" = NEW."booking_id" AND later."passenger_id" = NEW."passenger_id"
        AND (later."evaluated_at", later."id") > (evaluation."evaluated_at", evaluation."id")
    ) THEN
      RAISE EXCEPTION 'check-in requires the latest compliance evaluation'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF NEW."compliance_review_id" IS NULL THEN
      IF evaluation."result" <> 'PASS' OR EXISTS (
        SELECT 1 FROM "compliance_review" r WHERE r."evaluation_id" = evaluation."id"
      ) THEN
        RAISE EXCEPTION 'check-in requires a compliance PASS or a current COMPLIANT review'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
    ELSE
      SELECT r."evaluation_id", r."decision" INTO review
      FROM "compliance_review" r WHERE r."id" = NEW."compliance_review_id";
      IF NOT FOUND OR review."evaluation_id" <> evaluation."id" OR review."decision" <> 'COMPLIANT'
         OR EXISTS (
           SELECT 1 FROM "compliance_review" later
           WHERE later."supersedes_review_id" = NEW."compliance_review_id"
         ) THEN
        RAISE EXCEPTION 'check-in requires a compliance PASS or a current COMPLIANT review'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
    END IF;
  END IF;

  SELECT "realm", "status" INTO actor_realm, actor_status
  FROM "auth_identity" WHERE "id" = NEW."checked_in_by_identity_id" FOR SHARE;
  IF FOUND AND (
    actor_status <> 'ACTIVE'
    OR NOT (actor_realm = 'STAFF'
            OR (actor_realm = 'CUSTOMER' AND NEW."checked_in_by_identity_id" = subject."customer_identity_id"))
  ) THEN
    RAISE EXCEPTION 'only the active booking customer or active STAFF may check in'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW."checked_in_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "passenger_check_in_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "passenger_check_in"
  FOR EACH ROW EXECUTE FUNCTION "passenger_check_in_guard"();

-- The boarding is append-only; the unique check_in_id makes a second boarding
-- of the same BookingPassenger impossible. Only ACTIVE STAFF board; the
-- operator time is bounded and the server time is authoritative.
CREATE FUNCTION "passenger_boarding_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  subject RECORD;
  actor_realm "auth_realm";
  actor_status "auth_identity_status";
  now_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'passenger boardings are append-only'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT c."checked_in_at", b."confirmed_at", b."cancelled_at", t."status" AS trip_status
    INTO subject
  FROM "passenger_check_in" c
  JOIN "booking" b ON b."id" = c."booking_id"
  JOIN "trip" t ON t."id" = b."trip_id"
  WHERE c."id" = NEW."check_in_id"
  FOR SHARE OF c;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports a missing check-in
  END IF;
  IF subject."confirmed_at" IS NULL OR subject."cancelled_at" IS NOT NULL
     OR subject.trip_status <> 'SCHEDULED' THEN
    RAISE EXCEPTION 'boarding requires a confirmed, active scheduled journey'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT "realm", "status" INTO actor_realm, actor_status
  FROM "auth_identity" WHERE "id" = NEW."boarded_by_identity_id" FOR SHARE;
  IF FOUND AND (actor_realm <> 'STAFF' OR actor_status <> 'ACTIVE') THEN
    RAISE EXCEPTION 'only active STAFF may board a passenger'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."occurred_at" < GREATEST(subject."checked_in_at" - interval '5 minutes',
                                  now_at - interval '30 days')
     OR NEW."occurred_at" > now_at + interval '5 minutes' THEN
    RAISE EXCEPTION 'boarding occurred_at is outside the accepted window'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW."boarded_at" := now_at;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "passenger_boarding_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "passenger_boarding"
  FOR EACH ROW EXECUTE FUNCTION "passenger_boarding_guard"();

CREATE FUNCTION "check_in_boarding_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'check-in and boarding history cannot be truncated (%)', TG_TABLE_NAME
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;

CREATE TRIGGER "booking_passenger_seat_no_truncate"
  BEFORE TRUNCATE ON "booking_passenger_seat"
  FOR EACH STATEMENT EXECUTE FUNCTION "check_in_boarding_no_truncate"();
CREATE TRIGGER "passenger_check_in_no_truncate"
  BEFORE TRUNCATE ON "passenger_check_in"
  FOR EACH STATEMENT EXECUTE FUNCTION "check_in_boarding_no_truncate"();
CREATE TRIGGER "passenger_boarding_no_truncate"
  BEFORE TRUNCATE ON "passenger_boarding"
  FOR EACH STATEMENT EXECUTE FUNCTION "check_in_boarding_no_truncate"();

-- Explicit least-privilege catalogue. Customer self check-in is
-- ownership-based; these permissions apply to authenticated STAFF only.
-- Counter check-in: BOOKING_AGENT and DISPATCHER; boarding: DISPATCHER.
-- CUSTOMER_SUPPORT reads check-in state to answer customers. AUDITOR,
-- FINANCE and COMPLIANCE_AGENT get none (operational passenger PII). CREW and
-- DRIVER get nothing until PR-18 provides a CREW route and device model.
INSERT INTO "authorization_permission" ("key", "description") VALUES
  ('checkin.read', 'Read passenger check-in readiness, seat assignments and check-ins'),
  ('checkin.manage', 'Assign booked seats and check in passengers whose gates all pass'),
  ('boarding.read', 'Resolve a boarding credential and read the boarding state'),
  ('boarding.scan', 'Board a checked-in passenger by scanning the boarding QR');

INSERT INTO "authorization_role_permission" ("role_key", "permission_key") VALUES
  ('SUPER_ADMIN', 'checkin.read'),
  ('SUPER_ADMIN', 'checkin.manage'),
  ('SUPER_ADMIN', 'boarding.read'),
  ('SUPER_ADMIN', 'boarding.scan'),
  ('DIRECTOR', 'checkin.read'),
  ('DIRECTOR', 'checkin.manage'),
  ('DIRECTOR', 'boarding.read'),
  ('DIRECTOR', 'boarding.scan'),
  ('OPS_MANAGER', 'checkin.read'),
  ('OPS_MANAGER', 'checkin.manage'),
  ('OPS_MANAGER', 'boarding.read'),
  ('OPS_MANAGER', 'boarding.scan'),
  ('DISPATCHER', 'checkin.read'),
  ('DISPATCHER', 'checkin.manage'),
  ('DISPATCHER', 'boarding.read'),
  ('DISPATCHER', 'boarding.scan'),
  ('BOOKING_AGENT', 'checkin.read'),
  ('BOOKING_AGENT', 'checkin.manage'),
  ('CUSTOMER_SUPPORT', 'checkin.read');
