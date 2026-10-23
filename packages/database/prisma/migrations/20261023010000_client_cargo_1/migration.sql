-- CLIENT-CARGO-1: allow the authenticated owner to accept an ISSUED cargo quote.
-- Quote creation, issuance and cancellation remain STAFF-only. Direct SQL is
-- still constrained: a CUSTOMER acceptor must be ACTIVE and own the shipment.

CREATE FUNCTION "road_freight_quote_acceptor_active"(
  actor_id UUID,
  shipment_id UUID
) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $acceptor$
  SELECT EXISTS (
    SELECT 1
    FROM "auth_identity" a
    WHERE a."id" = actor_id
      AND a."status" = 'ACTIVE'
      AND (
        a."realm" = 'STAFF'
        OR (
          a."realm" = 'CUSTOMER'
          AND EXISTS (
            SELECT 1
            FROM "road_freight_shipment" s
            WHERE s."id" = shipment_id
              AND s."customer_identity_id" = actor_id
          )
        )
      )
  )
$acceptor$;

CREATE OR REPLACE FUNCTION "road_freight_quote_guard"() RETURNS trigger
LANGUAGE plpgsql AS $quote$
DECLARE
  expected_version INTEGER;
  source_direction "road_freight_direction";
  source_weight DECIMAL(8,3);
  source_volume INTEGER;
  source_packages INTEGER;
  source_fragile BOOLEAN;
  source_professional BOOLEAN;
  source_pickup BOOLEAN;
  source_delivery BOOLEAN;
  source_updated_at TIMESTAMPTZ(3);
  line_count INTEGER;
  min_position INTEGER;
  max_position INTEGER;
  charge_total NUMERIC(30,0);
  discount_total NUMERIC(30,0);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'road freight quotes cannot be deleted'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT
    s."direction",
    s."weight_kg",
    s."volume_liters",
    s."package_count",
    s."fragile",
    s."professional",
    s."pickup_required",
    s."delivery_required",
    s."updated_at"
  INTO
    source_direction,
    source_weight,
    source_volume,
    source_packages,
    source_fragile,
    source_professional,
    source_pickup,
    source_delivery,
    source_updated_at
  FROM "road_freight_shipment" s
  WHERE s."id" = NEW."shipment_id"
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'road freight quote shipment not found'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'road freight quote must start DRAFT'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT "road_freight_quote_staff_active"(NEW."created_by_identity_id") THEN
      RAISE EXCEPTION 'road freight quote actor must be active STAFF'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT COALESCE(max(q."version"), 0) + 1
      INTO expected_version
    FROM "road_freight_quote" q
    WHERE q."shipment_id" = NEW."shipment_id";

    IF NEW."version" <> expected_version THEN
      RAISE EXCEPTION 'road freight quote version is not next'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."snapshot_direction" IS DISTINCT FROM source_direction
       OR NEW."snapshot_weight_kg" IS DISTINCT FROM source_weight
       OR NEW."snapshot_volume_liters" IS DISTINCT FROM source_volume
       OR NEW."snapshot_package_count" IS DISTINCT FROM source_packages
       OR NEW."snapshot_fragile" IS DISTINCT FROM source_fragile
       OR NEW."snapshot_professional" IS DISTINCT FROM source_professional
       OR NEW."snapshot_pickup_required" IS DISTINCT FROM source_pickup
       OR NEW."snapshot_delivery_required" IS DISTINCT FROM source_delivery
       OR NEW."shipment_updated_at" IS DISTINCT FROM source_updated_at THEN
      RAISE EXCEPTION 'road freight quote snapshot mismatch'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."issued_by_identity_id" IS NOT NULL
       OR NEW."accepted_by_identity_id" IS NOT NULL
       OR NEW."cancelled_by_identity_id" IS NOT NULL
       OR NEW."issued_at" IS NOT NULL
       OR NEW."accepted_at" IS NOT NULL
       OR NEW."cancelled_at" IS NOT NULL
       OR NEW."superseded_at" IS NOT NULL THEN
      RAISE EXCEPTION 'road freight quote initial state invalid'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."reference" IS DISTINCT FROM OLD."reference"
     OR NEW."shipment_id" IS DISTINCT FROM OLD."shipment_id"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."currency_code" IS DISTINCT FROM OLD."currency_code"
     OR NEW."currency_minor_unit" IS DISTINCT FROM OLD."currency_minor_unit"
     OR NEW."snapshot_direction" IS DISTINCT FROM OLD."snapshot_direction"
     OR NEW."snapshot_weight_kg" IS DISTINCT FROM OLD."snapshot_weight_kg"
     OR NEW."snapshot_volume_liters" IS DISTINCT FROM OLD."snapshot_volume_liters"
     OR NEW."snapshot_package_count" IS DISTINCT FROM OLD."snapshot_package_count"
     OR NEW."snapshot_fragile" IS DISTINCT FROM OLD."snapshot_fragile"
     OR NEW."snapshot_professional" IS DISTINCT FROM OLD."snapshot_professional"
     OR NEW."snapshot_pickup_required" IS DISTINCT FROM OLD."snapshot_pickup_required"
     OR NEW."snapshot_delivery_required" IS DISTINCT FROM OLD."snapshot_delivery_required"
     OR NEW."shipment_updated_at" IS DISTINCT FROM OLD."shipment_updated_at"
     OR NEW."created_by_identity_id" IS DISTINCT FROM OLD."created_by_identity_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'road freight quote identity or snapshot is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" IN ('ACCEPTED', 'SUPERSEDED', 'CANCELLED') THEN
    IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
      RAISE EXCEPTION 'terminal road freight quote is immutable'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status" = 'ISSUED' THEN
    IF NEW."status" = 'ISSUED' THEN
      RAISE EXCEPTION 'issued road freight quote is immutable'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF NEW."issued_by_identity_id" IS DISTINCT FROM OLD."issued_by_identity_id"
       OR NEW."issued_at" IS DISTINCT FROM OLD."issued_at" THEN
      RAISE EXCEPTION 'issued road freight quote issuance metadata is immutable'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF OLD."status" = 'DRAFT' AND NEW."status" = 'ISSUED' THEN
      IF NOT "road_freight_quote_staff_active"(NEW."issued_by_identity_id") THEN
        RAISE EXCEPTION 'road freight quote actor must be active STAFF'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."issued_at" IS NULL THEN
        RAISE EXCEPTION 'road freight quote issued timestamp required'
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (
        SELECT 1 FROM "road_freight_quote" q
        WHERE q."shipment_id" = NEW."shipment_id"
          AND q."status" = 'ACCEPTED'
          AND q."id" <> NEW."id"
      ) THEN
        RAISE EXCEPTION 'accepted road freight quote blocks new issue'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;

      SELECT
        count(*),
        min(l."position"),
        max(l."position"),
        COALESCE(sum(l."amount_minor") FILTER (WHERE l."kind" = 'CHARGE'), 0),
        COALESCE(sum(l."amount_minor") FILTER (WHERE l."kind" = 'DISCOUNT'), 0)
      INTO line_count, min_position, max_position, charge_total, discount_total
      FROM "road_freight_quote_line" l
      WHERE l."quote_id" = NEW."id";

      IF line_count < 1
         OR min_position <> 0
         OR max_position <> line_count - 1 THEN
        RAISE EXCEPTION 'road freight quote lines must be contiguous and non-empty'
          USING ERRCODE = 'check_violation';
      END IF;
      IF discount_total > charge_total THEN
        RAISE EXCEPTION 'road freight quote total cannot be negative'
          USING ERRCODE = 'check_violation';
      END IF;

      UPDATE "road_freight_quote"
      SET
        "status" = 'SUPERSEDED',
        "superseded_at" = clock_timestamp(),
        "updated_at" = clock_timestamp()
      WHERE "shipment_id" = NEW."shipment_id"
        AND "status" = 'ISSUED'
        AND "id" <> NEW."id";

    ELSIF OLD."status" = 'DRAFT' AND NEW."status" = 'CANCELLED' THEN
      IF NOT "road_freight_quote_staff_active"(NEW."cancelled_by_identity_id")
         OR NEW."cancelled_at" IS NULL THEN
        RAISE EXCEPTION 'road freight quote cancellation actor and time required'
          USING ERRCODE = 'check_violation';
      END IF;

    ELSIF OLD."status" = 'ISSUED' AND NEW."status" = 'ACCEPTED' THEN
      IF NOT "road_freight_quote_acceptor_active"(
        NEW."accepted_by_identity_id",
        NEW."shipment_id"
      )
         OR NEW."accepted_at" IS NULL THEN
        RAISE EXCEPTION 'road freight quote acceptance actor and time required'
          USING ERRCODE = 'check_violation';
      END IF;

    ELSIF OLD."status" = 'ISSUED' AND NEW."status" = 'CANCELLED' THEN
      IF NOT "road_freight_quote_staff_active"(NEW."cancelled_by_identity_id")
         OR NEW."cancelled_at" IS NULL THEN
        RAISE EXCEPTION 'road freight quote cancellation actor and time required'
          USING ERRCODE = 'check_violation';
      END IF;

    ELSIF OLD."status" = 'ISSUED' AND NEW."status" = 'SUPERSEDED' THEN
      IF NEW."superseded_at" IS NULL THEN
        RAISE EXCEPTION 'road freight quote superseded timestamp required'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      RAISE EXCEPTION 'invalid road freight quote transition'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."status" = 'DRAFT' THEN
    IF NEW."issued_by_identity_id" IS NOT NULL
       OR NEW."accepted_by_identity_id" IS NOT NULL
       OR NEW."cancelled_by_identity_id" IS NOT NULL
       OR NEW."issued_at" IS NOT NULL
       OR NEW."accepted_at" IS NOT NULL
       OR NEW."cancelled_at" IS NOT NULL
       OR NEW."superseded_at" IS NOT NULL THEN
      RAISE EXCEPTION 'road freight quote DRAFT timestamps invalid'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" = 'ISSUED' THEN
    IF NEW."issued_by_identity_id" IS NULL
       OR NEW."issued_at" IS NULL
       OR NEW."accepted_by_identity_id" IS NOT NULL
       OR NEW."accepted_at" IS NOT NULL
       OR NEW."cancelled_by_identity_id" IS NOT NULL
       OR NEW."cancelled_at" IS NOT NULL
       OR NEW."superseded_at" IS NOT NULL THEN
      RAISE EXCEPTION 'road freight quote ISSUED timestamps invalid'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" = 'ACCEPTED' THEN
    IF NEW."issued_by_identity_id" IS NULL
       OR NEW."issued_at" IS NULL
       OR NEW."accepted_by_identity_id" IS NULL
       OR NEW."accepted_at" IS NULL
       OR NEW."cancelled_by_identity_id" IS NOT NULL
       OR NEW."cancelled_at" IS NOT NULL
       OR NEW."superseded_at" IS NOT NULL THEN
      RAISE EXCEPTION 'road freight quote ACCEPTED timestamps invalid'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" = 'SUPERSEDED' THEN
    IF NEW."issued_by_identity_id" IS NULL
       OR NEW."issued_at" IS NULL
       OR NEW."superseded_at" IS NULL
       OR NEW."accepted_by_identity_id" IS NOT NULL
       OR NEW."accepted_at" IS NOT NULL
       OR NEW."cancelled_by_identity_id" IS NOT NULL
       OR NEW."cancelled_at" IS NOT NULL THEN
      RAISE EXCEPTION 'road freight quote SUPERSEDED timestamps invalid'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" = 'CANCELLED' THEN
    IF NEW."cancelled_by_identity_id" IS NULL
       OR NEW."cancelled_at" IS NULL
       OR NEW."accepted_by_identity_id" IS NOT NULL
       OR NEW."accepted_at" IS NOT NULL
       OR NEW."superseded_at" IS NOT NULL THEN
      RAISE EXCEPTION 'road freight quote CANCELLED timestamps invalid'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  NEW."updated_at" := clock_timestamp();
  RETURN NEW;
END;
$quote$;


-- The owner may create the immutable initial QUOTE event together with their
-- request. Every later lifecycle/exception/assignment event remains STAFF-only.

CREATE OR REPLACE FUNCTION "road_freight_event_guard"() RETURNS trigger
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
  IF NOT FOUND
     OR actor_status <> 'ACTIVE'
     OR (
       actor_realm <> 'STAFF'
       AND NOT (
         actor_realm = 'CUSTOMER'
         AND current."customer_identity_id" = NEW."actor_identity_id"
         AND NEW."type" = 'QUOTE'
         AND NOT EXISTS (
           SELECT 1
           FROM "road_freight_shipment_event" existing
           WHERE existing."shipment_id" = NEW."shipment_id"
         )
       )
     ) THEN
    RAISE EXCEPTION 'only active STAFF may record road freight events after customer creation'
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
