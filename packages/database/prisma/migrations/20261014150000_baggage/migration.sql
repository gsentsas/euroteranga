-- PR-13 Baggage: one immutable public identity per bag, exact weight
-- projection and a serialized, append-only business event stream.

CREATE TYPE "baggage_type" AS ENUM ('SUITCASE', 'TRAVEL_BAG', 'BOX', 'OTHER');
CREATE TYPE "baggage_lifecycle_status" AS ENUM (
  'REGISTERED', 'CHECKED_IN', 'LOADED', 'IN_TRANSIT', 'ARRIVED', 'DELIVERED', 'REMOVED'
);
CREATE TYPE "baggage_exception_status" AS ENUM ('MISSING', 'DAMAGED', 'HELD_BY_CUSTOMS');
CREATE TYPE "baggage_event_type" AS ENUM (
  'REGISTERED', 'WEIGHT_UPDATED', 'CHECKED_IN', 'LOADED', 'IN_TRANSIT',
  'ARRIVED', 'DELIVERED', 'MISSING', 'DAMAGED', 'HELD_BY_CUSTOMS',
  'EXCEPTION_RESOLVED', 'REMOVED'
);

CREATE TABLE "baggage" (
  "id" UUID NOT NULL,
  "reference" VARCHAR(16) NOT NULL,
  "booking_id" UUID NOT NULL,
  "passenger_id" UUID NOT NULL,
  "type" "baggage_type" NOT NULL,
  "lifecycle_status" "baggage_lifecycle_status" NOT NULL DEFAULT 'REGISTERED',
  "exception_status" "baggage_exception_status",
  "measured_weight_kg" DECIMAL(6,3),
  "included_weight_kg" DECIMAL(6,3),
  "excess_weight_kg" DECIMAL(6,3),
  "excess_charge_minor" BIGINT,
  "excess_charge_currency_code" VARCHAR(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "baggage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "baggage_event" (
  "id" UUID NOT NULL,
  "baggage_id" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "type" "baggage_event_type" NOT NULL,
  "lifecycle_status" "baggage_lifecycle_status" NOT NULL,
  "exception_status" "baggage_exception_status",
  "measured_weight_kg" DECIMAL(6,3),
  "occurred_at" TIMESTAMPTZ(3) NOT NULL,
  "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actor_identity_id" UUID NOT NULL,
  "route_waypoint_id" UUID,
  "client_event_id" VARCHAR(64),
  "payload_fingerprint" CHAR(64) NOT NULL,
  CONSTRAINT "baggage_event_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "baggage_reference_key" ON "baggage"("reference");
CREATE INDEX "baggage_booking_id_passenger_id_id_idx"
  ON "baggage"("booking_id", "passenger_id", "id");
CREATE INDEX "baggage_lifecycle_status_id_idx" ON "baggage"("lifecycle_status", "id");
CREATE INDEX "baggage_exception_status_id_idx" ON "baggage"("exception_status", "id");
CREATE INDEX "baggage_created_at_id_idx" ON "baggage"("created_at", "id");

CREATE UNIQUE INDEX "baggage_event_baggage_id_sequence_key"
  ON "baggage_event"("baggage_id", "sequence");
CREATE UNIQUE INDEX "baggage_event_baggage_id_client_event_id_key"
  ON "baggage_event"("baggage_id", "client_event_id");
CREATE INDEX "baggage_event_actor_identity_id_recorded_at_idx"
  ON "baggage_event"("actor_identity_id", "recorded_at");
CREATE INDEX "baggage_event_route_waypoint_id_idx" ON "baggage_event"("route_waypoint_id");
CREATE INDEX "baggage_event_type_recorded_at_idx" ON "baggage_event"("type", "recorded_at");

ALTER TABLE "baggage" ADD CONSTRAINT "baggage_booking_passenger_fkey"
  FOREIGN KEY ("booking_id", "passenger_id")
  REFERENCES "booking_passenger"("booking_id", "passenger_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "baggage_event" ADD CONSTRAINT "baggage_event_baggage_id_fkey"
  FOREIGN KEY ("baggage_id") REFERENCES "baggage"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "baggage_event" ADD CONSTRAINT "baggage_event_actor_identity_id_fkey"
  FOREIGN KEY ("actor_identity_id") REFERENCES "auth_identity"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "baggage_event" ADD CONSTRAINT "baggage_event_route_waypoint_id_fkey"
  FOREIGN KEY ("route_waypoint_id") REFERENCES "route_waypoint"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "baggage" ADD CONSTRAINT "baggage_reference_format"
  CHECK ("reference" ~ '^ETG-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$');
ALTER TABLE "baggage" ADD CONSTRAINT "baggage_measured_weight_valid"
  CHECK ("measured_weight_kg" IS NULL OR "measured_weight_kg" BETWEEN 0.001 AND 999.999);
ALTER TABLE "baggage" ADD CONSTRAINT "baggage_allowance_weight_valid"
  CHECK (
    ("included_weight_kg" IS NULL AND "excess_weight_kg" IS NULL)
    OR (
      "measured_weight_kg" IS NOT NULL
      AND "included_weight_kg" BETWEEN 0.000 AND 999.999
      AND "excess_weight_kg" = GREATEST("measured_weight_kg" - "included_weight_kg", 0.000)
    )
  );
ALTER TABLE "baggage" ADD CONSTRAINT "baggage_excess_charge_pair"
  CHECK (
    ("excess_charge_minor" IS NULL AND "excess_charge_currency_code" IS NULL)
    OR (
      "excess_charge_minor" >= 0
      AND "excess_charge_currency_code" ~ '^[A-Z]{3}$'
    )
  );
ALTER TABLE "baggage_event" ADD CONSTRAINT "baggage_event_sequence_positive"
  CHECK ("sequence" > 0);
ALTER TABLE "baggage_event" ADD CONSTRAINT "baggage_event_weight_valid"
  CHECK ("measured_weight_kg" IS NULL OR "measured_weight_kg" BETWEEN 0.001 AND 999.999);
ALTER TABLE "baggage_event" ADD CONSTRAINT "baggage_event_client_id_format"
  CHECK (
    "client_event_id" IS NULL
    OR "client_event_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$'
  );
ALTER TABLE "baggage_event" ADD CONSTRAINT "baggage_event_fingerprint_format"
  CHECK ("payload_fingerprint" ~ '^[0-9a-f]{64}$');

-- Baggage identity is immutable. A row is born REGISTERED and is accepted
-- only for a confirmed, non-cancelled booking/passenger pair owned by the
-- same CUSTOMER. Projection updates must already have a matching latest event.
CREATE FUNCTION "baggage_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  subject RECORD;
  latest RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'baggage is historical and cannot be deleted'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."lifecycle_status" <> 'REGISTERED'
       OR NEW."exception_status" IS NOT NULL
       OR NEW."measured_weight_kg" IS NOT NULL
       OR NEW."included_weight_kg" IS NOT NULL
       OR NEW."excess_weight_kg" IS NOT NULL
       OR NEW."excess_charge_minor" IS NOT NULL
       OR NEW."excess_charge_currency_code" IS NOT NULL THEN
      RAISE EXCEPTION 'baggage must be registered without operational or pricing projections'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT b."confirmed_at", b."cancelled_at", b."customer_identity_id",
           p."owner_customer_identity_id", t."status" AS trip_status
      INTO subject
    FROM "booking_passenger" bp
    JOIN "booking" b ON b."id" = bp."booking_id"
    JOIN "passenger" p ON p."id" = bp."passenger_id"
    JOIN "trip" t ON t."id" = b."trip_id"
    WHERE bp."booking_id" = NEW."booking_id" AND bp."passenger_id" = NEW."passenger_id"
    FOR SHARE OF bp, b;
    IF NOT FOUND THEN
      RETURN NEW; -- the composite foreign key reports the missing subject
    END IF;
    IF subject."confirmed_at" IS NULL OR subject."cancelled_at" IS NOT NULL
       OR subject.trip_status <> 'SCHEDULED' THEN
      RAISE EXCEPTION 'baggage requires a confirmed, active scheduled journey'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF subject."customer_identity_id" <> subject."owner_customer_identity_id" THEN
      RAISE EXCEPTION 'baggage booking and passenger ownership must match'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."reference" IS DISTINCT FROM OLD."reference"
     OR NEW."booking_id" IS DISTINCT FROM OLD."booking_id"
     OR NEW."passenger_id" IS DISTINCT FROM OLD."passenger_id"
     OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'baggage identity, subject, type and reference are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."included_weight_kg" IS DISTINCT FROM OLD."included_weight_kg"
     OR NEW."excess_weight_kg" IS DISTINCT FROM OLD."excess_weight_kg"
     OR NEW."excess_charge_minor" IS DISTINCT FROM OLD."excess_charge_minor"
     OR NEW."excess_charge_currency_code" IS DISTINCT FROM OLD."excess_charge_currency_code" THEN
    RAISE EXCEPTION 'baggage allowance and charge snapshots have no PR-13 policy'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT e."lifecycle_status", e."exception_status", e."measured_weight_kg"
    INTO latest
  FROM "baggage_event" e
  WHERE e."baggage_id" = OLD."id"
  ORDER BY e."sequence" DESC
  LIMIT 1;
  IF NOT FOUND
     OR NEW."lifecycle_status" IS DISTINCT FROM latest."lifecycle_status"
     OR NEW."exception_status" IS DISTINCT FROM latest."exception_status"
     OR NEW."measured_weight_kg" IS DISTINCT FROM latest."measured_weight_kg" THEN
    RAISE EXCEPTION 'baggage projection changes require a matching event'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "baggage_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "baggage"
  FOR EACH ROW EXECUTE FUNCTION "baggage_guard"();

-- Every event locks its Baggage row. The lock makes sequence allocation and
-- transition validation deterministic across API processes.
CREATE FUNCTION "baggage_event_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bag RECORD;
  prior RECORD;
  actor_realm "auth_realm";
  actor_status "auth_identity_status";
  expected_lifecycle "baggage_lifecycle_status";
  expected_exception "baggage_exception_status";
  expected_sequence INTEGER;
  waypoint_route UUID;
  now_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'baggage events are append-only'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT bg."lifecycle_status", bg."exception_status", bg."measured_weight_kg",
         bk."created_at" AS booking_created_at, bk."customer_identity_id",
         t."route_version_id"
    INTO bag
  FROM "baggage" bg
  JOIN "booking" bk ON bk."id" = bg."booking_id"
  JOIN "trip" t ON t."id" = bk."trip_id"
  WHERE bg."id" = NEW."baggage_id"
  FOR UPDATE OF bg;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports the missing baggage row
  END IF;

  SELECT e."sequence", e."type", e."lifecycle_status", e."exception_status",
         e."measured_weight_kg" INTO prior
  FROM "baggage_event" e
  WHERE e."baggage_id" = NEW."baggage_id"
  ORDER BY e."sequence" DESC
  LIMIT 1;
  expected_sequence := COALESCE(prior."sequence", 0) + 1;
  IF NEW."sequence" <> expected_sequence THEN
    RAISE EXCEPTION 'baggage event sequence must be %', expected_sequence
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT "realm", "status" INTO actor_realm, actor_status
  FROM "auth_identity" WHERE "id" = NEW."actor_identity_id" FOR SHARE;
  IF FOUND AND actor_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'baggage event actor must be active'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."occurred_at" < GREATEST(bag.booking_created_at, now_at - interval '30 days')
     OR NEW."occurred_at" > now_at + interval '5 minutes' THEN
    RAISE EXCEPTION 'baggage event occurred_at is outside the accepted window'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW."recorded_at" := now_at;

  IF NEW."route_waypoint_id" IS NOT NULL THEN
    SELECT "route_version_id" INTO waypoint_route
    FROM "route_waypoint" WHERE "id" = NEW."route_waypoint_id";
    IF waypoint_route IS DISTINCT FROM bag."route_version_id" THEN
      RAISE EXCEPTION 'baggage event waypoint must belong to the baggage trip route'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF prior."sequence" IS NULL THEN
    IF NEW."sequence" <> 1 OR NEW."type" <> 'REGISTERED'
       OR NEW."lifecycle_status" <> 'REGISTERED'
       OR NEW."exception_status" IS NOT NULL
       OR NEW."measured_weight_kg" IS NOT NULL THEN
      RAISE EXCEPTION 'the first baggage event must be REGISTERED with the initial projection'
        USING ERRCODE = 'check_violation';
    END IF;
    IF actor_realm <> 'STAFF'
       AND NOT (actor_realm = 'CUSTOMER' AND NEW."actor_identity_id" = bag."customer_identity_id") THEN
      RAISE EXCEPTION 'only the booking customer or STAFF may register baggage'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- One accepted event must be projected before another can be appended.
  -- This closes the direct-SQL batch-insert gap while preserving the normal
  -- event-then-projection transaction used by the service.
  IF bag."lifecycle_status" IS DISTINCT FROM prior."lifecycle_status"
     OR bag."exception_status" IS DISTINCT FROM prior."exception_status"
     OR bag."measured_weight_kg" IS DISTINCT FROM prior."measured_weight_kg" THEN
    RAISE EXCEPTION 'baggage projection must be updated before the next event'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF actor_realm <> 'STAFF' OR actor_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'only active STAFF may record operational baggage events'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."type" = 'REGISTERED' THEN
    RAISE EXCEPTION 'REGISTERED is only valid as the first baggage event'
      USING ERRCODE = 'check_violation';
  END IF;
  IF bag."lifecycle_status" = 'REMOVED' THEN
    RAISE EXCEPTION 'REMOVED is terminal for baggage events'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF NEW."type" = 'WEIGHT_UPDATED' THEN
    IF NEW."lifecycle_status" IS DISTINCT FROM bag."lifecycle_status"
       OR NEW."exception_status" IS DISTINCT FROM bag."exception_status"
       OR NEW."measured_weight_kg" IS NULL
       OR NEW."measured_weight_kg" IS NOT DISTINCT FROM bag."measured_weight_kg" THEN
      RAISE EXCEPTION 'WEIGHT_UPDATED must change only the exact measured weight'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."type" IN ('CHECKED_IN', 'LOADED', 'IN_TRANSIT', 'ARRIVED', 'DELIVERED', 'REMOVED') THEN
    expected_lifecycle := CASE NEW."type"
      WHEN 'CHECKED_IN' THEN 'CHECKED_IN'
      WHEN 'LOADED' THEN 'LOADED'
      WHEN 'IN_TRANSIT' THEN 'IN_TRANSIT'
      WHEN 'ARRIVED' THEN 'ARRIVED'
      WHEN 'DELIVERED' THEN 'DELIVERED'
      WHEN 'REMOVED' THEN 'REMOVED'
    END;
    IF NEW."type" = 'REMOVED' THEN
      IF bag."lifecycle_status" IN ('DELIVERED', 'REMOVED') THEN
        RAISE EXCEPTION 'invalid baggage removal transition from %', bag."lifecycle_status"
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
    ELSE
      IF bag."exception_status" IS NOT NULL THEN
        RAISE EXCEPTION 'resolve the active baggage exception before normal progression'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
      IF NOT (
        (bag."lifecycle_status" = 'REGISTERED' AND NEW."type" = 'CHECKED_IN')
        OR (bag."lifecycle_status" = 'CHECKED_IN' AND NEW."type" = 'LOADED')
        OR (bag."lifecycle_status" = 'LOADED' AND NEW."type" = 'IN_TRANSIT')
        OR (bag."lifecycle_status" = 'IN_TRANSIT' AND NEW."type" = 'ARRIVED')
        OR (bag."lifecycle_status" = 'ARRIVED' AND NEW."type" = 'DELIVERED')
      ) THEN
        RAISE EXCEPTION 'invalid baggage lifecycle transition from % to %',
          bag."lifecycle_status", NEW."type"
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
    END IF;
    IF NEW."lifecycle_status" IS DISTINCT FROM expected_lifecycle
       OR NEW."exception_status" IS DISTINCT FROM bag."exception_status"
       OR NEW."measured_weight_kg" IS DISTINCT FROM bag."measured_weight_kg" THEN
      RAISE EXCEPTION 'baggage lifecycle event projection is inconsistent'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."type" IN ('MISSING', 'DAMAGED', 'HELD_BY_CUSTOMS') THEN
    expected_exception := CASE NEW."type"
      WHEN 'MISSING' THEN 'MISSING'
      WHEN 'DAMAGED' THEN 'DAMAGED'
      WHEN 'HELD_BY_CUSTOMS' THEN 'HELD_BY_CUSTOMS'
    END;
    IF bag."lifecycle_status" = 'REMOVED' OR bag."exception_status" IS NOT NULL THEN
      RAISE EXCEPTION 'baggage cannot open this exception from its current projection'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF NEW."lifecycle_status" IS DISTINCT FROM bag."lifecycle_status"
       OR NEW."exception_status" IS DISTINCT FROM expected_exception
       OR NEW."measured_weight_kg" IS DISTINCT FROM bag."measured_weight_kg" THEN
      RAISE EXCEPTION 'baggage exception event projection is inconsistent'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."type" = 'EXCEPTION_RESOLVED' THEN
    IF bag."exception_status" IS NULL
       OR NEW."lifecycle_status" IS DISTINCT FROM bag."lifecycle_status"
       OR NEW."exception_status" IS NOT NULL
       OR NEW."measured_weight_kg" IS DISTINCT FROM bag."measured_weight_kg" THEN
      RAISE EXCEPTION 'EXCEPTION_RESOLVED requires and clears one active exception'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'unsupported baggage event type'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "baggage_event_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "baggage_event"
  FOR EACH ROW EXECUTE FUNCTION "baggage_event_guard"();

-- Deferred cross-table assertion: every Baggage has an initial event and its
-- current lifecycle, exception and measured weight equal the latest event.
CREATE FUNCTION "baggage_projection_consistency"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_id UUID;
  bag RECORD;
  latest RECORD;
BEGIN
  -- NEW is a polymorphic trigger record. Keep field access inside its table
  -- branch so PostgreSQL never resolves baggage_id on a baggage row.
  IF TG_TABLE_NAME = 'baggage' THEN
    target_id := NEW."id";
  ELSE
    target_id := NEW."baggage_id";
  END IF;
  SELECT "lifecycle_status", "exception_status", "measured_weight_kg"
    INTO bag FROM "baggage" WHERE "id" = target_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT "sequence", "type", "lifecycle_status", "exception_status", "measured_weight_kg"
    INTO latest
  FROM "baggage_event" WHERE "baggage_id" = target_id
  ORDER BY "sequence" DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'baggage requires an initial REGISTERED event'
      USING ERRCODE = 'check_violation';
  END IF;
  IF bag."lifecycle_status" IS DISTINCT FROM latest."lifecycle_status"
     OR bag."exception_status" IS DISTINCT FROM latest."exception_status"
     OR bag."measured_weight_kg" IS DISTINCT FROM latest."measured_weight_kg" THEN
    RAISE EXCEPTION 'baggage projection must equal its latest event'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "baggage_projection_consistency_on_baggage"
  AFTER INSERT OR UPDATE ON "baggage"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "baggage_projection_consistency"();
CREATE CONSTRAINT TRIGGER "baggage_projection_consistency_on_event"
  AFTER INSERT ON "baggage_event"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "baggage_projection_consistency"();

CREATE FUNCTION "baggage_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'baggage history cannot be truncated'
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;

CREATE TRIGGER "baggage_no_truncate"
  BEFORE TRUNCATE ON "baggage"
  FOR EACH STATEMENT EXECUTE FUNCTION "baggage_no_truncate"();
CREATE TRIGGER "baggage_event_no_truncate"
  BEFORE TRUNCATE ON "baggage_event"
  FOR EACH STATEMENT EXECUTE FUNCTION "baggage_no_truncate"();

-- Explicit least-privilege catalogue. Customer access is ownership-based;
-- these permissions apply only to authenticated STAFF in the OPS app.
-- Baggage views name the passenger, so only roles that handle travellers read
-- them: AUDITOR (no passenger PII grant since PR-11), FINANCE and
-- COMPLIANCE_AGENT receive none. CUSTOMER_SUPPORT reads to answer customers.
INSERT INTO "authorization_permission" ("key", "description") VALUES
  ('baggage.read', 'Read baggage identity, projections, QR payload and event history'),
  ('baggage.manage', 'Register baggage and record weight, lifecycle and exception events');

INSERT INTO "authorization_role_permission" ("role_key", "permission_key") VALUES
  ('SUPER_ADMIN', 'baggage.read'),
  ('SUPER_ADMIN', 'baggage.manage'),
  ('DIRECTOR', 'baggage.read'),
  ('DIRECTOR', 'baggage.manage'),
  ('OPS_MANAGER', 'baggage.read'),
  ('OPS_MANAGER', 'baggage.manage'),
  ('DISPATCHER', 'baggage.read'),
  ('DISPATCHER', 'baggage.manage'),
  ('BOOKING_AGENT', 'baggage.read'),
  ('BOOKING_AGENT', 'baggage.manage'),
  ('CUSTOMER_SUPPORT', 'baggage.read');
