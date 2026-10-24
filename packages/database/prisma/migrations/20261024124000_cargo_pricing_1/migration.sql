-- CARGO-PRICING-1: versioned and fail-closed freight-pricing rules.
-- This migration deliberately seeds no commercial amount or active rule.

CREATE TYPE "cargo_pricing_audience" AS ENUM ('PUBLIC', 'PRO', 'NEGOTIATED');
CREATE TYPE "cargo_pricing_rule_version_status" AS ENUM ('DRAFT', 'ACTIVE', 'DISABLED');
CREATE TYPE "cargo_pricing_method" AS ENUM (
  'ACTUAL_WEIGHT',
  'VOLUMETRIC_WEIGHT',
  'VOLUME',
  'FLAT_RATE',
  'TIERED_WEIGHT',
  'CUSTOM_QUOTE'
);
CREATE TYPE "cargo_pricing_rounding_mode" AS ENUM ('UP', 'HALF_UP', 'DOWN');
CREATE TYPE "cargo_pricing_category" AS ENUM (
  'STANDARD_PARCEL',
  'PERSONAL_ITEMS',
  'CLOTHING',
  'DOCUMENTS',
  'ALLOWED_FOOD',
  'EQUIPMENT',
  'PROFESSIONAL_GOODS',
  'UNACCOMPANIED_BAGGAGE',
  'ACCOMPANIED_PARCEL',
  'SPECIAL_HANDLING',
  'OTHER'
);
CREATE TYPE "cargo_pricing_tier_method" AS ENUM (
  'UNIT_WEIGHT',
  'UNIT_VOLUME',
  'FLAT_RATE',
  'CUSTOM_QUOTE'
);
CREATE TYPE "cargo_pricing_option_kind" AS ENUM (
  'PICKUP',
  'DELIVERY',
  'FRAGILE_HANDLING',
  'PROFESSIONAL_HANDLING',
  'INSURANCE'
);
CREATE TYPE "cargo_pricing_option_mode" AS ENUM ('INCLUDED', 'FLAT_RATE', 'CUSTOM_QUOTE');

CREATE TABLE "cargo_pricing_rule" (
  "id" UUID NOT NULL,
  "code" VARCHAR(32) NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "direction" "road_freight_direction" NOT NULL,
  "audience" "cargo_pricing_audience" NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "cargo_pricing_rule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cargo_pricing_rule_code_key" UNIQUE ("code"),
  CONSTRAINT "cargo_pricing_rule_code_shape" CHECK (
    "code" ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'
  ),
  CONSTRAINT "cargo_pricing_rule_name_shape" CHECK (
    length("name") BETWEEN 1 AND 160 AND "name" = btrim("name")
  )
);

CREATE TABLE "cargo_pricing_rule_version" (
  "id" UUID NOT NULL,
  "rule_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "cargo_pricing_rule_version_status" NOT NULL DEFAULT 'DRAFT',
  "method" "cargo_pricing_method" NOT NULL,
  "currency_code" VARCHAR(3) NOT NULL,
  "currency_minor_unit" INTEGER NOT NULL,
  "rounding_mode" "cargo_pricing_rounding_mode",
  "unit_price_minor" BIGINT,
  "flat_price_minor" BIGINT,
  "minimum_charge_minor" BIGINT,
  "volumetric_divisor_cm3_per_kg" INTEGER,
  "quote_above_weight_kg" DECIMAL(8,3),
  "quote_above_volume_liters" INTEGER,
  "effective_from" TIMESTAMPTZ(3) NOT NULL,
  "effective_to" TIMESTAMPTZ(3),
  "activated_at" TIMESTAMPTZ(3),
  "disabled_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "cargo_pricing_rule_version_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cargo_pricing_rule_version_rule_id_version_key" UNIQUE ("rule_id", "version"),
  CONSTRAINT "cargo_pricing_rule_version_number_range" CHECK ("version" BETWEEN 1 AND 1000000),
  CONSTRAINT "cargo_pricing_rule_version_currency_shape" CHECK (
    "currency_code" ~ '^[A-Z]{3}$' AND "currency_minor_unit" BETWEEN 0 AND 3
  ),
  CONSTRAINT "cargo_pricing_rule_version_amount_range" CHECK (
    ("unit_price_minor" IS NULL OR "unit_price_minor" BETWEEN 1 AND 999999999999999999)
    AND ("flat_price_minor" IS NULL OR "flat_price_minor" BETWEEN 1 AND 999999999999999999)
    AND ("minimum_charge_minor" IS NULL OR "minimum_charge_minor" BETWEEN 1 AND 999999999999999999)
  ),
  CONSTRAINT "cargo_pricing_rule_version_threshold_range" CHECK (
    ("volumetric_divisor_cm3_per_kg" IS NULL OR "volumetric_divisor_cm3_per_kg" BETWEEN 1 AND 1000000000)
    AND ("quote_above_weight_kg" IS NULL OR "quote_above_weight_kg" > 0)
    AND ("quote_above_volume_liters" IS NULL OR "quote_above_volume_liters" BETWEEN 1 AND 2147483647)
    AND ("effective_to" IS NULL OR "effective_to" > "effective_from")
  ),
  CONSTRAINT "cargo_pricing_rule_version_method_shape" CHECK (
    (
      "method" = 'ACTUAL_WEIGHT'
      AND "unit_price_minor" IS NOT NULL
      AND "flat_price_minor" IS NULL
      AND "rounding_mode" IS NOT NULL
      AND "volumetric_divisor_cm3_per_kg" IS NULL
    ) OR (
      "method" = 'VOLUMETRIC_WEIGHT'
      AND "unit_price_minor" IS NOT NULL
      AND "flat_price_minor" IS NULL
      AND "rounding_mode" IS NOT NULL
      AND "volumetric_divisor_cm3_per_kg" IS NOT NULL
    ) OR (
      "method" = 'VOLUME'
      AND "unit_price_minor" IS NOT NULL
      AND "flat_price_minor" IS NULL
      AND "rounding_mode" IS NOT NULL
      AND "volumetric_divisor_cm3_per_kg" IS NULL
    ) OR (
      "method" = 'FLAT_RATE'
      AND "unit_price_minor" IS NULL
      AND "flat_price_minor" IS NOT NULL
      AND "rounding_mode" IS NULL
      AND "volumetric_divisor_cm3_per_kg" IS NULL
    ) OR (
      "method" = 'TIERED_WEIGHT'
      AND "unit_price_minor" IS NULL
      AND "flat_price_minor" IS NULL
      AND "rounding_mode" IS NOT NULL
    ) OR (
      "method" = 'CUSTOM_QUOTE'
      AND "unit_price_minor" IS NULL
      AND "flat_price_minor" IS NULL
      AND "minimum_charge_minor" IS NULL
      AND "rounding_mode" IS NULL
      AND "volumetric_divisor_cm3_per_kg" IS NULL
    )
  ),
  CONSTRAINT "cargo_pricing_rule_version_status_shape" CHECK (
    ("status" = 'DRAFT' AND "activated_at" IS NULL AND "disabled_at" IS NULL)
    OR ("status" = 'ACTIVE' AND "activated_at" IS NOT NULL AND "disabled_at" IS NULL)
    OR ("status" = 'DISABLED' AND "activated_at" IS NOT NULL AND "disabled_at" IS NOT NULL)
  )
);

CREATE TABLE "cargo_pricing_rule_category" (
  "rule_version_id" UUID NOT NULL,
  "category" "cargo_pricing_category" NOT NULL,

  CONSTRAINT "cargo_pricing_rule_category_pkey" PRIMARY KEY ("rule_version_id", "category")
);

CREATE TABLE "cargo_pricing_tier" (
  "id" UUID NOT NULL,
  "rule_version_id" UUID NOT NULL,
  "position" INTEGER NOT NULL,
  "min_weight_kg" DECIMAL(8,3) NOT NULL,
  "max_weight_kg" DECIMAL(8,3),
  "method" "cargo_pricing_tier_method" NOT NULL,
  "unit_price_minor" BIGINT,
  "flat_price_minor" BIGINT,
  "minimum_charge_minor" BIGINT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "cargo_pricing_tier_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cargo_pricing_tier_rule_version_id_position_key" UNIQUE ("rule_version_id", "position"),
  CONSTRAINT "cargo_pricing_tier_rule_version_id_min_weight_kg_key" UNIQUE ("rule_version_id", "min_weight_kg"),
  CONSTRAINT "cargo_pricing_tier_position_range" CHECK ("position" BETWEEN 0 AND 999),
  CONSTRAINT "cargo_pricing_tier_weight_range" CHECK (
    "min_weight_kg" >= 0 AND ("max_weight_kg" IS NULL OR "max_weight_kg" > "min_weight_kg")
  ),
  CONSTRAINT "cargo_pricing_tier_amount_range" CHECK (
    ("unit_price_minor" IS NULL OR "unit_price_minor" BETWEEN 1 AND 999999999999999999)
    AND ("flat_price_minor" IS NULL OR "flat_price_minor" BETWEEN 1 AND 999999999999999999)
    AND ("minimum_charge_minor" IS NULL OR "minimum_charge_minor" BETWEEN 1 AND 999999999999999999)
  ),
  CONSTRAINT "cargo_pricing_tier_method_shape" CHECK (
    (
      "method" IN ('UNIT_WEIGHT', 'UNIT_VOLUME')
      AND "unit_price_minor" IS NOT NULL
      AND "flat_price_minor" IS NULL
    ) OR (
      "method" = 'FLAT_RATE'
      AND "unit_price_minor" IS NULL
      AND "flat_price_minor" IS NOT NULL
    ) OR (
      "method" = 'CUSTOM_QUOTE'
      AND "unit_price_minor" IS NULL
      AND "flat_price_minor" IS NULL
      AND "minimum_charge_minor" IS NULL
    )
  )
);

CREATE TABLE "cargo_pricing_option" (
  "id" UUID NOT NULL,
  "rule_version_id" UUID NOT NULL,
  "kind" "cargo_pricing_option_kind" NOT NULL,
  "mode" "cargo_pricing_option_mode" NOT NULL,
  "amount_minor" BIGINT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "cargo_pricing_option_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cargo_pricing_option_rule_version_id_kind_key" UNIQUE ("rule_version_id", "kind"),
  CONSTRAINT "cargo_pricing_option_amount_range" CHECK (
    "amount_minor" IS NULL OR "amount_minor" BETWEEN 1 AND 999999999999999999
  ),
  CONSTRAINT "cargo_pricing_option_mode_shape" CHECK (
    ("mode" = 'FLAT_RATE' AND "amount_minor" IS NOT NULL)
    OR ("mode" IN ('INCLUDED', 'CUSTOM_QUOTE') AND "amount_minor" IS NULL)
  )
);

CREATE INDEX "cargo_pricing_rule_direction_audience_id_idx"
  ON "cargo_pricing_rule" ("direction", "audience", "id");
CREATE INDEX "cargo_pricing_rule_version_status_effective_idx"
  ON "cargo_pricing_rule_version" ("status", "effective_from", "effective_to");
CREATE INDEX "cargo_pricing_rule_category_category_version_idx"
  ON "cargo_pricing_rule_category" ("category", "rule_version_id");
CREATE INDEX "cargo_pricing_tier_version_weight_idx"
  ON "cargo_pricing_tier" ("rule_version_id", "min_weight_kg", "max_weight_kg");
CREATE INDEX "cargo_pricing_option_version_kind_idx"
  ON "cargo_pricing_option" ("rule_version_id", "kind");

CREATE UNIQUE INDEX "cargo_pricing_rule_one_draft_version"
  ON "cargo_pricing_rule_version" ("rule_id") WHERE "status" = 'DRAFT';
CREATE UNIQUE INDEX "cargo_pricing_rule_one_active_version"
  ON "cargo_pricing_rule_version" ("rule_id") WHERE "status" = 'ACTIVE';

ALTER TABLE "cargo_pricing_rule_version"
  ADD CONSTRAINT "cargo_pricing_rule_version_rule_id_fkey"
  FOREIGN KEY ("rule_id") REFERENCES "cargo_pricing_rule"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "cargo_pricing_rule_category"
  ADD CONSTRAINT "cargo_pricing_rule_category_version_id_fkey"
  FOREIGN KEY ("rule_version_id") REFERENCES "cargo_pricing_rule_version"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "cargo_pricing_tier"
  ADD CONSTRAINT "cargo_pricing_tier_version_id_fkey"
  FOREIGN KEY ("rule_version_id") REFERENCES "cargo_pricing_rule_version"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "cargo_pricing_option"
  ADD CONSTRAINT "cargo_pricing_option_version_id_fkey"
  FOREIGN KEY ("rule_version_id") REFERENCES "cargo_pricing_rule_version"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "cargo_pricing_rule_guard"() RETURNS trigger
LANGUAGE plpgsql AS $pricing$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cargo pricing rules cannot be deleted'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."code" IS DISTINCT FROM OLD."code"
     OR NEW."direction" IS DISTINCT FROM OLD."direction"
     OR NEW."audience" IS DISTINCT FROM OLD."audience"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'cargo pricing rule identity is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$pricing$;

CREATE TRIGGER "cargo_pricing_rule_guard"
  BEFORE UPDATE OR DELETE ON "cargo_pricing_rule"
  FOR EACH ROW EXECUTE FUNCTION "cargo_pricing_rule_guard"();

CREATE FUNCTION "cargo_pricing_version_publishable"(target_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $pricing$
DECLARE
  target_method "cargo_pricing_method";
  category_count INTEGER;
  tier_count INTEGER;
  bad_tier_count INTEGER;
BEGIN
  SELECT "method" INTO target_method
  FROM "cargo_pricing_rule_version"
  WHERE "id" = target_id;

  SELECT count(*) INTO category_count
  FROM "cargo_pricing_rule_category"
  WHERE "rule_version_id" = target_id;
  IF category_count < 1 THEN RETURN FALSE; END IF;

  SELECT count(*) INTO tier_count
  FROM "cargo_pricing_tier"
  WHERE "rule_version_id" = target_id;
  IF target_method <> 'TIERED_WEIGHT' THEN RETURN tier_count = 0; END IF;
  IF tier_count < 1 THEN RETURN FALSE; END IF;

  SELECT count(*) INTO bad_tier_count
  FROM (
    SELECT
      "position",
      "min_weight_kg",
      "max_weight_kg",
      lead("min_weight_kg") OVER (ORDER BY "position") AS next_min,
      lead("position") OVER (ORDER BY "position") AS next_position
    FROM "cargo_pricing_tier"
    WHERE "rule_version_id" = target_id
  ) tiers
  WHERE ("position" = 0 AND "min_weight_kg" <> 0)
     OR ("next_position" IS NOT NULL AND "next_position" <> "position" + 1)
     OR ("next_min" IS NOT NULL AND "max_weight_kg" IS DISTINCT FROM "next_min")
     OR ("next_min" IS NULL AND "max_weight_kg" IS NOT NULL);

  RETURN bad_tier_count = 0;
END;
$pricing$;

CREATE FUNCTION "cargo_pricing_rule_version_guard"() RETURNS trigger
LANGUAGE plpgsql AS $pricing$
DECLARE
  expected_version INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cargo pricing rule versions cannot be deleted'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  PERFORM 1 FROM "cargo_pricing_rule" WHERE "id" = NEW."rule_id" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cargo pricing rule not found'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."activated_at" IS NOT NULL OR NEW."disabled_at" IS NOT NULL THEN
      RAISE EXCEPTION 'cargo pricing rule version must start DRAFT'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT COALESCE(max("version"), 0) + 1 INTO expected_version
    FROM "cargo_pricing_rule_version" WHERE "rule_id" = NEW."rule_id";
    IF NEW."version" <> expected_version THEN
      RAISE EXCEPTION 'cargo pricing rule version is not next'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."rule_id" IS DISTINCT FROM OLD."rule_id"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'cargo pricing rule version identity is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" = 'DRAFT' AND NEW."status" = 'DRAFT' THEN
    RETURN NEW;
  END IF;

  IF OLD."status" = 'DRAFT' AND NEW."status" = 'ACTIVE' THEN
    IF NEW."activated_at" IS NULL OR NEW."disabled_at" IS NOT NULL
       OR (NEW."effective_to" IS NOT NULL AND NEW."effective_to" <= NEW."activated_at")
       OR NOT "cargo_pricing_version_publishable"(OLD."id") THEN
      RAISE EXCEPTION 'cargo pricing rule version is not activatable'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'ACTIVE' AND NEW."status" = 'DISABLED' THEN
    IF NEW."disabled_at" IS NULL
       OR NEW."activated_at" IS DISTINCT FROM OLD."activated_at"
       OR NEW."method" IS DISTINCT FROM OLD."method"
       OR NEW."currency_code" IS DISTINCT FROM OLD."currency_code"
       OR NEW."currency_minor_unit" IS DISTINCT FROM OLD."currency_minor_unit"
       OR NEW."rounding_mode" IS DISTINCT FROM OLD."rounding_mode"
       OR NEW."unit_price_minor" IS DISTINCT FROM OLD."unit_price_minor"
       OR NEW."flat_price_minor" IS DISTINCT FROM OLD."flat_price_minor"
       OR NEW."minimum_charge_minor" IS DISTINCT FROM OLD."minimum_charge_minor"
       OR NEW."volumetric_divisor_cm3_per_kg" IS DISTINCT FROM OLD."volumetric_divisor_cm3_per_kg"
       OR NEW."quote_above_weight_kg" IS DISTINCT FROM OLD."quote_above_weight_kg"
       OR NEW."quote_above_volume_liters" IS DISTINCT FROM OLD."quote_above_volume_liters"
       OR NEW."effective_from" IS DISTINCT FROM OLD."effective_from"
       OR NEW."effective_to" IS DISTINCT FROM OLD."effective_to" THEN
      RAISE EXCEPTION 'active cargo pricing rule configuration is immutable'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid cargo pricing rule version transition'
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$pricing$;

CREATE TRIGGER "cargo_pricing_rule_version_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "cargo_pricing_rule_version"
  FOR EACH ROW EXECUTE FUNCTION "cargo_pricing_rule_version_guard"();

CREATE FUNCTION "cargo_pricing_version_child_guard"() RETURNS trigger
LANGUAGE plpgsql AS $pricing$
DECLARE
  target_version_id UUID;
  target_status "cargo_pricing_rule_version_status";
BEGIN
  target_version_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."rule_version_id" ELSE NEW."rule_version_id" END;
  SELECT "status" INTO target_status
  FROM "cargo_pricing_rule_version"
  WHERE "id" = target_version_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cargo pricing rule version not found'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF target_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'active cargo pricing rule children are immutable'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pricing$;

CREATE TRIGGER "cargo_pricing_rule_category_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "cargo_pricing_rule_category"
  FOR EACH ROW EXECUTE FUNCTION "cargo_pricing_version_child_guard"();
CREATE TRIGGER "cargo_pricing_tier_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "cargo_pricing_tier"
  FOR EACH ROW EXECUTE FUNCTION "cargo_pricing_version_child_guard"();
CREATE TRIGGER "cargo_pricing_option_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "cargo_pricing_option"
  FOR EACH ROW EXECUTE FUNCTION "cargo_pricing_version_child_guard"();

CREATE FUNCTION "cargo_pricing_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $pricing$
BEGIN
  RAISE EXCEPTION 'cargo pricing history cannot be truncated'
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$pricing$;

CREATE TRIGGER "cargo_pricing_rule_no_truncate"
  BEFORE TRUNCATE ON "cargo_pricing_rule"
  FOR EACH STATEMENT EXECUTE FUNCTION "cargo_pricing_no_truncate"();
CREATE TRIGGER "cargo_pricing_rule_version_no_truncate"
  BEFORE TRUNCATE ON "cargo_pricing_rule_version"
  FOR EACH STATEMENT EXECUTE FUNCTION "cargo_pricing_no_truncate"();
CREATE TRIGGER "cargo_pricing_rule_category_no_truncate"
  BEFORE TRUNCATE ON "cargo_pricing_rule_category"
  FOR EACH STATEMENT EXECUTE FUNCTION "cargo_pricing_no_truncate"();
CREATE TRIGGER "cargo_pricing_tier_no_truncate"
  BEFORE TRUNCATE ON "cargo_pricing_tier"
  FOR EACH STATEMENT EXECUTE FUNCTION "cargo_pricing_no_truncate"();
CREATE TRIGGER "cargo_pricing_option_no_truncate"
  BEFORE TRUNCATE ON "cargo_pricing_option"
  FOR EACH STATEMENT EXECUTE FUNCTION "cargo_pricing_no_truncate"();
