-- BAGGAGE-PLUS-1: versioned baggage allowance and configurable excess tiers.
-- No commercial amount is hard-coded. Published policy versions are historical.
-- A baggage snapshots its policy version and allowance ordinal at registration;
-- exact charge snapshots are server-derived only from an official STAFF weight.

CREATE TYPE "baggage_policy_version_status" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

CREATE TABLE "baggage_policy" (
  "id" UUID NOT NULL,
  "code" VARCHAR(32) NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "currency_code" VARCHAR(3) NOT NULL,
  "currency_minor_unit" INTEGER NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "baggage_policy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "baggage_policy_version" (
  "id" UUID NOT NULL,
  "baggage_policy_id" UUID NOT NULL,
  "fare_table_version_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "baggage_policy_version_status" NOT NULL DEFAULT 'DRAFT',
  "included_pieces" INTEGER NOT NULL,
  "included_weight_kg_per_piece" DECIMAL(6,3) NOT NULL,
  "published_at" TIMESTAMPTZ(3),
  "retired_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "baggage_policy_version_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "baggage_excess_tier" (
  "id" UUID NOT NULL,
  "baggage_policy_version_id" UUID NOT NULL,
  "code" VARCHAR(32) NOT NULL,
  "label" VARCHAR(160) NOT NULL,
  "max_excess_weight_kg" DECIMAL(6,3) NOT NULL,
  "charge_minor" BIGINT NOT NULL,
  "position" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "baggage_excess_tier_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "baggage"
  ADD COLUMN "baggage_policy_version_id" UUID,
  ADD COLUMN "allowance_piece_ordinal" INTEGER,
  ADD COLUMN "excess_charge_currency_minor_unit" INTEGER;

CREATE UNIQUE INDEX "baggage_policy_code_key" ON "baggage_policy"("code");
CREATE INDEX "baggage_policy_active_id_idx" ON "baggage_policy"("active", "id");

CREATE UNIQUE INDEX "baggage_policy_version_baggage_policy_id_version_key"
  ON "baggage_policy_version"("baggage_policy_id", "version");
CREATE UNIQUE INDEX "baggage_policy_version_fare_table_version_id_key"
  ON "baggage_policy_version"("fare_table_version_id");
CREATE INDEX "baggage_policy_version_status_idx" ON "baggage_policy_version"("status");
CREATE UNIQUE INDEX "baggage_policy_version_one_draft_per_policy"
  ON "baggage_policy_version"("baggage_policy_id") WHERE "status" = 'DRAFT';
CREATE UNIQUE INDEX "baggage_policy_version_one_published_per_policy"
  ON "baggage_policy_version"("baggage_policy_id") WHERE "status" = 'PUBLISHED';

CREATE UNIQUE INDEX "baggage_excess_tier_version_code_key"
  ON "baggage_excess_tier"("baggage_policy_version_id", "code");
CREATE UNIQUE INDEX "baggage_excess_tier_version_max_weight_key"
  ON "baggage_excess_tier"("baggage_policy_version_id", "max_excess_weight_kg");
CREATE UNIQUE INDEX "baggage_excess_tier_version_position_key"
  ON "baggage_excess_tier"("baggage_policy_version_id", "position");
CREATE INDEX "baggage_excess_tier_version_max_weight_idx"
  ON "baggage_excess_tier"("baggage_policy_version_id", "max_excess_weight_kg");

CREATE INDEX "baggage_baggage_policy_version_id_idx"
  ON "baggage"("baggage_policy_version_id");
CREATE UNIQUE INDEX "baggage_allowance_piece_ordinal_key"
  ON "baggage"("booking_id", "passenger_id", "allowance_piece_ordinal")
  WHERE "allowance_piece_ordinal" IS NOT NULL;

ALTER TABLE "baggage_policy"
  ADD CONSTRAINT "baggage_policy_code_format"
  CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  ADD CONSTRAINT "baggage_policy_name_normalized"
  CHECK ("name" = btrim("name") AND length("name") > 0),
  ADD CONSTRAINT "baggage_policy_currency_code_format"
  CHECK ("currency_code" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "baggage_policy_currency_minor_unit_range"
  CHECK ("currency_minor_unit" BETWEEN 0 AND 3);

ALTER TABLE "baggage_policy_version"
  ADD CONSTRAINT "baggage_policy_version_number_positive"
  CHECK ("version" > 0),
  ADD CONSTRAINT "baggage_policy_version_included_pieces_range"
  CHECK ("included_pieces" BETWEEN 0 AND 20),
  ADD CONSTRAINT "baggage_policy_version_included_weight_valid"
  CHECK ("included_weight_kg_per_piece" BETWEEN 0.001 AND 999.999),
  ADD CONSTRAINT "baggage_policy_version_status_timestamps"
  CHECK (
    ("status" = 'DRAFT' AND "published_at" IS NULL AND "retired_at" IS NULL)
    OR ("status" = 'PUBLISHED' AND "published_at" IS NOT NULL AND "retired_at" IS NULL)
    OR ("status" = 'RETIRED' AND "published_at" IS NOT NULL AND "retired_at" IS NOT NULL)
  );

ALTER TABLE "baggage_excess_tier"
  ADD CONSTRAINT "baggage_excess_tier_code_format"
  CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  ADD CONSTRAINT "baggage_excess_tier_label_normalized"
  CHECK ("label" = btrim("label") AND length("label") > 0),
  ADD CONSTRAINT "baggage_excess_tier_max_weight_valid"
  CHECK ("max_excess_weight_kg" BETWEEN 0.001 AND 999.999),
  ADD CONSTRAINT "baggage_excess_tier_charge_nonnegative"
  CHECK ("charge_minor" >= 0),
  ADD CONSTRAINT "baggage_excess_tier_position_nonnegative"
  CHECK ("position" >= 0);

ALTER TABLE "baggage"
  ADD CONSTRAINT "baggage_policy_snapshot_pair"
  CHECK (
    ("baggage_policy_version_id" IS NULL AND "allowance_piece_ordinal" IS NULL)
    OR ("baggage_policy_version_id" IS NOT NULL AND "allowance_piece_ordinal" > 0)
  ),
  ADD CONSTRAINT "baggage_excess_charge_minor_unit_range"
  CHECK (
    "excess_charge_currency_minor_unit" IS NULL
    OR "excess_charge_currency_minor_unit" BETWEEN 0 AND 3
  );

ALTER TABLE "baggage" DROP CONSTRAINT "baggage_excess_charge_pair";
ALTER TABLE "baggage"
  ADD CONSTRAINT "baggage_excess_charge_pair"
  CHECK (
    (
      "excess_charge_minor" IS NULL
      AND "excess_charge_currency_code" IS NULL
      AND "excess_charge_currency_minor_unit" IS NULL
    )
    OR (
      "excess_charge_minor" >= 0
      AND "excess_charge_currency_code" ~ '^[A-Z]{3}$'
      AND "excess_charge_currency_minor_unit" BETWEEN 0 AND 3
    )
  );

ALTER TABLE "baggage_policy_version"
  ADD CONSTRAINT "baggage_policy_version_policy_fkey"
  FOREIGN KEY ("baggage_policy_id") REFERENCES "baggage_policy"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "baggage_policy_version_fare_table_version_fkey"
  FOREIGN KEY ("fare_table_version_id") REFERENCES "fare_table_version"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "baggage_excess_tier"
  ADD CONSTRAINT "baggage_excess_tier_version_fkey"
  FOREIGN KEY ("baggage_policy_version_id") REFERENCES "baggage_policy_version"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "baggage"
  ADD CONSTRAINT "baggage_policy_version_fkey"
  FOREIGN KEY ("baggage_policy_version_id") REFERENCES "baggage_policy_version"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "baggage_policy_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'baggage policy is historical and cannot be deleted'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."code" IS DISTINCT FROM OLD."code"
    OR NEW."currency_code" IS DISTINCT FROM OLD."currency_code"
    OR NEW."currency_minor_unit" IS DISTINCT FROM OLD."currency_minor_unit"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'baggage policy identity and currency are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "baggage_policy_guard"
  BEFORE UPDATE OR DELETE ON "baggage_policy"
  FOR EACH ROW EXECUTE FUNCTION "baggage_policy_guard"();

CREATE FUNCTION "baggage_policy_version_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  policy RECORD;
  fare RECORD;
  has_tier BOOLEAN;
  booking_count BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'baggage policy versions are historical and cannot be deleted'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT p."active", p."currency_code", p."currency_minor_unit"
    INTO policy
  FROM "baggage_policy" p
  WHERE p."id" = NEW."baggage_policy_id"
  FOR SHARE;

  SELECT ftv."status", ft."currency_code", ft."currency_minor_unit"
    INTO fare
  FROM "fare_table_version" ftv
  JOIN "fare_table" ft ON ft."id" = ftv."fare_table_id"
  WHERE ftv."id" = NEW."fare_table_version_id"
  FOR SHARE OF ftv, ft;

  IF FOUND AND (
    fare."currency_code" IS DISTINCT FROM policy."currency_code"
    OR fare."currency_minor_unit" IS DISTINCT FROM policy."currency_minor_unit"
  ) THEN
    RAISE EXCEPTION 'baggage policy currency must match its fare table'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."published_at" IS NOT NULL OR NEW."retired_at" IS NOT NULL THEN
      RAISE EXCEPTION 'baggage policy version must be created as DRAFT'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."baggage_policy_id" IS DISTINCT FROM OLD."baggage_policy_id"
     OR NEW."fare_table_version_id" IS DISTINCT FROM OLD."fare_table_version_id"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'baggage policy version identity is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" = 'DRAFT' AND NEW."status" = 'DRAFT' THEN
    RETURN NEW;
  END IF;

  IF OLD."status" = 'DRAFT' AND NEW."status" = 'PUBLISHED' THEN
    IF NOT policy."active" OR fare."status" <> 'PUBLISHED'
       OR NEW."published_at" IS NULL OR NEW."retired_at" IS NOT NULL THEN
      RAISE EXCEPTION 'baggage policy version is not publishable'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM "baggage_excess_tier" t
      WHERE t."baggage_policy_version_id" = OLD."id"
    ) INTO has_tier;
    IF NOT has_tier THEN
      RAISE EXCEPTION 'baggage policy version requires at least one excess tier'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    SELECT count(*) INTO booking_count
    FROM "booking" b
    JOIN "fare_entry" fe ON fe."id" = b."fare_entry_id"
    WHERE fe."fare_table_version_id" = OLD."fare_table_version_id";
    IF booking_count > 0 THEN
      RAISE EXCEPTION 'baggage policy must be published before the fare version is booked'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'PUBLISHED' AND NEW."status" = 'RETIRED' THEN
    IF NEW."published_at" IS DISTINCT FROM OLD."published_at"
       OR NEW."retired_at" IS NULL THEN
      RAISE EXCEPTION 'baggage policy retirement timestamps are invalid'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid baggage policy version transition'
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;

CREATE TRIGGER "baggage_policy_version_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "baggage_policy_version"
  FOR EACH ROW EXECUTE FUNCTION "baggage_policy_version_guard"();

CREATE FUNCTION "baggage_excess_tier_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  version_status "baggage_policy_version_status";
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT "status" INTO version_status
    FROM "baggage_policy_version"
    WHERE "id" = OLD."baggage_policy_version_id"
    FOR UPDATE;
    IF version_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'published baggage excess tiers are immutable'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN OLD;
  END IF;

  SELECT "status" INTO version_status
  FROM "baggage_policy_version"
  WHERE "id" = NEW."baggage_policy_version_id"
  FOR UPDATE;
  IF FOUND AND version_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'baggage excess tiers are editable only on a DRAFT policy version'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."baggage_policy_version_id" IS DISTINCT FROM OLD."baggage_policy_version_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'baggage excess tier identity is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "baggage_excess_tier_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "baggage_excess_tier"
  FOR EACH ROW EXECUTE FUNCTION "baggage_excess_tier_guard"();

CREATE FUNCTION "baggage_plus_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'baggage commercial history cannot be truncated'
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;

CREATE TRIGGER "baggage_policy_no_truncate"
  BEFORE TRUNCATE ON "baggage_policy"
  FOR EACH STATEMENT EXECUTE FUNCTION "baggage_plus_no_truncate"();
CREATE TRIGGER "baggage_policy_version_no_truncate"
  BEFORE TRUNCATE ON "baggage_policy_version"
  FOR EACH STATEMENT EXECUTE FUNCTION "baggage_plus_no_truncate"();
CREATE TRIGGER "baggage_excess_tier_no_truncate"
  BEFORE TRUNCATE ON "baggage_excess_tier"
  FOR EACH STATEMENT EXECUTE FUNCTION "baggage_plus_no_truncate"();

CREATE OR REPLACE FUNCTION "baggage_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  subject RECORD;
  latest RECORD;
  policy RECORD;
  expected_policy_id UUID;
  expected_ordinal INTEGER;
  expected_included DECIMAL(6,3);
  expected_excess DECIMAL(6,3);
  expected_charge BIGINT;
  expected_currency VARCHAR(3);
  expected_minor_unit INTEGER;
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
       OR NEW."excess_charge_currency_code" IS NOT NULL
       OR NEW."excess_charge_currency_minor_unit" IS NOT NULL THEN
      RAISE EXCEPTION 'baggage must be registered without measured pricing projections'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT b."confirmed_at", b."cancelled_at", b."customer_identity_id",
           p."owner_customer_identity_id", t."status" AS trip_status,
           fe."fare_table_version_id"
      INTO subject
    FROM "booking_passenger" bp
    JOIN "booking" b ON b."id" = bp."booking_id"
    JOIN "passenger" p ON p."id" = bp."passenger_id"
    JOIN "trip" t ON t."id" = b."trip_id"
    JOIN "fare_entry" fe ON fe."id" = b."fare_entry_id"
    WHERE bp."booking_id" = NEW."booking_id" AND bp."passenger_id" = NEW."passenger_id"
    FOR UPDATE OF bp, b;
    IF NOT FOUND THEN
      RETURN NEW;
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

    SELECT pv."id" INTO expected_policy_id
    FROM "baggage_policy_version" pv
    WHERE pv."fare_table_version_id" = subject."fare_table_version_id"
      AND pv."status" = 'PUBLISHED';

    IF expected_policy_id IS NULL THEN
      IF NEW."baggage_policy_version_id" IS NOT NULL
         OR NEW."allowance_piece_ordinal" IS NOT NULL THEN
        RAISE EXCEPTION 'baggage cannot snapshot an unavailable allowance policy'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      SELECT COALESCE(max(bg."allowance_piece_ordinal"), 0) + 1
        INTO expected_ordinal
      FROM "baggage" bg
      WHERE bg."booking_id" = NEW."booking_id"
        AND bg."passenger_id" = NEW."passenger_id";
      IF NEW."baggage_policy_version_id" IS DISTINCT FROM expected_policy_id
         OR NEW."allowance_piece_ordinal" IS DISTINCT FROM expected_ordinal THEN
        RAISE EXCEPTION 'baggage allowance policy snapshot or ordinal is invalid'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."reference" IS DISTINCT FROM OLD."reference"
     OR NEW."booking_id" IS DISTINCT FROM OLD."booking_id"
     OR NEW."passenger_id" IS DISTINCT FROM OLD."passenger_id"
     OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."baggage_policy_version_id" IS DISTINCT FROM OLD."baggage_policy_version_id"
     OR NEW."allowance_piece_ordinal" IS DISTINCT FROM OLD."allowance_piece_ordinal"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'baggage identity, subject, type and policy snapshot are immutable'
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

  IF NEW."measured_weight_kg" IS NOT DISTINCT FROM OLD."measured_weight_kg" THEN
    IF NEW."included_weight_kg" IS DISTINCT FROM OLD."included_weight_kg"
       OR NEW."excess_weight_kg" IS DISTINCT FROM OLD."excess_weight_kg"
       OR NEW."excess_charge_minor" IS DISTINCT FROM OLD."excess_charge_minor"
       OR NEW."excess_charge_currency_code" IS DISTINCT FROM OLD."excess_charge_currency_code"
       OR NEW."excess_charge_currency_minor_unit" IS DISTINCT FROM OLD."excess_charge_currency_minor_unit" THEN
      RAISE EXCEPTION 'baggage commercial snapshots change only with an official weight'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."baggage_policy_version_id" IS NULL OR NEW."measured_weight_kg" IS NULL THEN
    IF NEW."included_weight_kg" IS NOT NULL
       OR NEW."excess_weight_kg" IS NOT NULL
       OR NEW."excess_charge_minor" IS NOT NULL
       OR NEW."excess_charge_currency_code" IS NOT NULL
       OR NEW."excess_charge_currency_minor_unit" IS NOT NULL THEN
      RAISE EXCEPTION 'baggage without a published policy has no commercial snapshot'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT pv."included_pieces", pv."included_weight_kg_per_piece",
         p."currency_code", p."currency_minor_unit"
    INTO policy
  FROM "baggage_policy_version" pv
  JOIN "baggage_policy" p ON p."id" = pv."baggage_policy_id"
  WHERE pv."id" = NEW."baggage_policy_version_id"
    AND pv."status" IN ('PUBLISHED', 'RETIRED');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'baggage allowance policy snapshot is not historical'
      USING ERRCODE = 'check_violation';
  END IF;

  expected_included := CASE
    WHEN NEW."allowance_piece_ordinal" <= policy."included_pieces"
      THEN policy."included_weight_kg_per_piece"
    ELSE 0.000
  END;
  expected_excess := GREATEST(NEW."measured_weight_kg" - expected_included, 0.000);

  IF expected_excess = 0.000 THEN
    expected_charge := 0;
    expected_currency := policy."currency_code";
    expected_minor_unit := policy."currency_minor_unit";
  ELSE
    SELECT t."charge_minor" INTO expected_charge
    FROM "baggage_excess_tier" t
    WHERE t."baggage_policy_version_id" = NEW."baggage_policy_version_id"
      AND t."max_excess_weight_kg" >= expected_excess
    ORDER BY t."max_excess_weight_kg" ASC
    LIMIT 1;
    IF FOUND THEN
      expected_currency := policy."currency_code";
      expected_minor_unit := policy."currency_minor_unit";
    ELSE
      expected_charge := NULL;
      expected_currency := NULL;
      expected_minor_unit := NULL;
    END IF;
  END IF;

  IF NEW."included_weight_kg" IS DISTINCT FROM expected_included
     OR NEW."excess_weight_kg" IS DISTINCT FROM expected_excess
     OR NEW."excess_charge_minor" IS DISTINCT FROM expected_charge
     OR NEW."excess_charge_currency_code" IS DISTINCT FROM expected_currency
     OR NEW."excess_charge_currency_minor_unit" IS DISTINCT FROM expected_minor_unit THEN
    RAISE EXCEPTION 'baggage commercial snapshots do not match the published policy'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
