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
