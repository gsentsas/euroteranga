-- CARGO-PRICE-1: versioned, auditable commercial quotes for road freight.
-- No payment, FX, public calculator, Finance revenue or profitability side effect.

CREATE TYPE "road_freight_quote_status" AS ENUM (
  'DRAFT',
  'ISSUED',
  'ACCEPTED',
  'SUPERSEDED',
  'CANCELLED'
);

CREATE TYPE "road_freight_quote_line_kind" AS ENUM (
  'CHARGE',
  'DISCOUNT'
);

CREATE TABLE "road_freight_quote" (
  "id" UUID NOT NULL,
  "reference" VARCHAR(17) NOT NULL,
  "shipment_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "road_freight_quote_status" NOT NULL DEFAULT 'DRAFT',
  "currency_code" VARCHAR(3) NOT NULL,
  "currency_minor_unit" INTEGER NOT NULL,
  "snapshot_direction" "road_freight_direction" NOT NULL,
  "snapshot_weight_kg" DECIMAL(8,3) NOT NULL,
  "snapshot_volume_liters" INTEGER NOT NULL,
  "snapshot_package_count" INTEGER NOT NULL,
  "snapshot_fragile" BOOLEAN NOT NULL,
  "snapshot_professional" BOOLEAN NOT NULL,
  "snapshot_pickup_required" BOOLEAN NOT NULL,
  "snapshot_delivery_required" BOOLEAN NOT NULL,
  "shipment_updated_at" TIMESTAMPTZ(3) NOT NULL,
  "created_by_identity_id" UUID NOT NULL,
  "issued_by_identity_id" UUID,
  "accepted_by_identity_id" UUID,
  "cancelled_by_identity_id" UUID,
  "issued_at" TIMESTAMPTZ(3),
  "accepted_at" TIMESTAMPTZ(3),
  "cancelled_at" TIMESTAMPTZ(3),
  "superseded_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "road_freight_quote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "road_freight_quote_reference_key" UNIQUE ("reference"),
  CONSTRAINT "road_freight_quote_shipment_id_version_key" UNIQUE ("shipment_id", "version"),
  CONSTRAINT "road_freight_quote_reference_shape" CHECK (
    "reference" ~ '^ETCQ-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$'
  ),
  CONSTRAINT "road_freight_quote_version_range" CHECK ("version" BETWEEN 1 AND 1000000),
  CONSTRAINT "road_freight_quote_currency_shape" CHECK (
    "currency_code" ~ '^[A-Z]{3}$'
    AND "currency_minor_unit" BETWEEN 0 AND 3
  ),
  CONSTRAINT "road_freight_quote_snapshot_shape" CHECK (
    "snapshot_weight_kg" > 0
    AND "snapshot_volume_liters" BETWEEN 1 AND 1000000
    AND "snapshot_package_count" BETWEEN 1 AND 9999
  )
);

CREATE TABLE "road_freight_quote_line" (
  "id" UUID NOT NULL,
  "quote_id" UUID NOT NULL,
  "kind" "road_freight_quote_line_kind" NOT NULL,
  "label" VARCHAR(160) NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "notes" VARCHAR(500),
  "position" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "road_freight_quote_line_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "road_freight_quote_line_quote_id_position_key" UNIQUE ("quote_id", "position"),
  CONSTRAINT "road_freight_quote_line_amount_range" CHECK (
    "amount_minor" BETWEEN 1 AND 999999999999999999
  ),
  CONSTRAINT "road_freight_quote_line_position_range" CHECK ("position" BETWEEN 0 AND 99),
  CONSTRAINT "road_freight_quote_line_label_shape" CHECK (
    length("label") BETWEEN 1 AND 160 AND "label" = btrim("label")
  ),
  CONSTRAINT "road_freight_quote_line_notes_shape" CHECK (
    "notes" IS NULL
    OR (length("notes") BETWEEN 1 AND 500 AND "notes" = btrim("notes"))
  )
);

CREATE INDEX "road_freight_quote_shipment_id_status_version_idx"
  ON "road_freight_quote" ("shipment_id", "status", "version");
CREATE INDEX "road_freight_quote_created_at_id_idx"
  ON "road_freight_quote" ("created_at", "id");
CREATE INDEX "road_freight_quote_line_quote_id_kind_idx"
  ON "road_freight_quote_line" ("quote_id", "kind");

CREATE UNIQUE INDEX "road_freight_quote_one_draft_per_shipment"
  ON "road_freight_quote" ("shipment_id")
  WHERE "status" = 'DRAFT';
CREATE UNIQUE INDEX "road_freight_quote_one_issued_per_shipment"
  ON "road_freight_quote" ("shipment_id")
  WHERE "status" = 'ISSUED';

ALTER TABLE "road_freight_quote"
  ADD CONSTRAINT "road_freight_quote_shipment_id_fkey"
  FOREIGN KEY ("shipment_id") REFERENCES "road_freight_shipment"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "road_freight_quote"
  ADD CONSTRAINT "road_freight_quote_created_by_identity_id_fkey"
  FOREIGN KEY ("created_by_identity_id") REFERENCES "auth_identity"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "road_freight_quote"
  ADD CONSTRAINT "road_freight_quote_issued_by_identity_id_fkey"
  FOREIGN KEY ("issued_by_identity_id") REFERENCES "auth_identity"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "road_freight_quote"
  ADD CONSTRAINT "road_freight_quote_accepted_by_identity_id_fkey"
  FOREIGN KEY ("accepted_by_identity_id") REFERENCES "auth_identity"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "road_freight_quote"
  ADD CONSTRAINT "road_freight_quote_cancelled_by_identity_id_fkey"
  FOREIGN KEY ("cancelled_by_identity_id") REFERENCES "auth_identity"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "road_freight_quote_line"
  ADD CONSTRAINT "road_freight_quote_line_quote_id_fkey"
  FOREIGN KEY ("quote_id") REFERENCES "road_freight_quote"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "road_freight_quote_staff_active"(actor_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $quote$
  SELECT EXISTS (
    SELECT 1
    FROM "auth_identity" a
    WHERE a."id" = actor_id
      AND a."realm" = 'STAFF'
      AND a."status" = 'ACTIVE'
  )
$quote$;

CREATE FUNCTION "road_freight_quote_guard"() RETURNS trigger
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
      IF NOT "road_freight_quote_staff_active"(NEW."accepted_by_identity_id")
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

CREATE TRIGGER "road_freight_quote_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "road_freight_quote"
  FOR EACH ROW EXECUTE FUNCTION "road_freight_quote_guard"();

CREATE FUNCTION "road_freight_quote_line_guard"() RETURNS trigger
LANGUAGE plpgsql AS $quote$
DECLARE
  target_quote_id UUID;
  quote_status "road_freight_quote_status";
BEGIN
  target_quote_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."quote_id" ELSE NEW."quote_id" END;

  SELECT q."status" INTO quote_status
  FROM "road_freight_quote" q
  WHERE q."id" = target_quote_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'road freight quote line quote not found'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF quote_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'road freight quote lines are frozen'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."quote_id" IS DISTINCT FROM OLD."quote_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
      RAISE EXCEPTION 'road freight quote line identity is immutable'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$quote$;

CREATE TRIGGER "road_freight_quote_line_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "road_freight_quote_line"
  FOR EACH ROW EXECUTE FUNCTION "road_freight_quote_line_guard"();

CREATE FUNCTION "road_freight_quote_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $quote$
BEGIN
  RAISE EXCEPTION 'road freight quote history cannot be truncated'
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$quote$;

CREATE TRIGGER "road_freight_quote_no_truncate"
  BEFORE TRUNCATE ON "road_freight_quote"
  FOR EACH STATEMENT EXECUTE FUNCTION "road_freight_quote_no_truncate"();

CREATE TRIGGER "road_freight_quote_line_no_truncate"
  BEFORE TRUNCATE ON "road_freight_quote_line"
  FOR EACH STATEMENT EXECUTE FUNCTION "road_freight_quote_no_truncate"();
