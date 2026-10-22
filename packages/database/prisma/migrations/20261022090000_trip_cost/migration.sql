-- TRIP-COST-1: one internal operational cost plan and ordered cost lines per trip.
-- No amount is seeded; ticket pricing, revenue, FX and profitability stay out of scope.

CREATE TYPE "trip_cost_status" AS ENUM ('DRAFT', 'ESTIMATED', 'LOCKED');

CREATE TYPE "trip_cost_category" AS ENUM (
  'FUEL',
  'TOLLS',
  'FERRY',
  'BORDER_FEES',
  'PERMITS',
  'DRIVERS',
  'ACCOMMODATION',
  'MEALS_ALLOWANCES',
  'MAINTENANCE',
  'INSURANCE',
  'CLEANING_PREPARATION',
  'PARKING',
  'STOP_COST',
  'SUPPORT_VEHICLE',
  'CONTINGENCY',
  'OTHER'
);

CREATE TABLE "trip_cost_plan" (
  "id" UUID NOT NULL,
  "trip_id" UUID NOT NULL,
  "status" "trip_cost_status" NOT NULL DEFAULT 'DRAFT',
  "currency_code" VARCHAR(3) NOT NULL DEFAULT 'EUR',
  "currency_minor_unit" INTEGER NOT NULL DEFAULT 2,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "trip_cost_plan_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "trip_cost_plan_trip_id_key" UNIQUE ("trip_id"),
  CONSTRAINT "trip_cost_plan_currency_shape" CHECK (
    "currency_code" = 'EUR'
    AND "currency_minor_unit" = 2
  )
);

CREATE TABLE "trip_cost_item" (
  "id" UUID NOT NULL,
  "plan_id" UUID NOT NULL,
  "category" "trip_cost_category" NOT NULL,
  "label" VARCHAR(160) NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "notes" VARCHAR(500),
  "position" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "trip_cost_item_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "trip_cost_item_plan_id_position_key" UNIQUE ("plan_id", "position"),
  CONSTRAINT "trip_cost_item_amount_range" CHECK (
    "amount_minor" BETWEEN 0 AND 9999999999999999
  ),
  CONSTRAINT "trip_cost_item_position_range" CHECK ("position" BETWEEN 0 AND 99),
  CONSTRAINT "trip_cost_item_label_shape" CHECK (
    length("label") BETWEEN 1 AND 160 AND "label" = btrim("label")
  ),
  CONSTRAINT "trip_cost_item_notes_shape" CHECK (
    "notes" IS NULL
    OR (length("notes") BETWEEN 1 AND 500 AND "notes" = btrim("notes"))
  )
);

CREATE INDEX "trip_cost_plan_status_updated_at_idx"
  ON "trip_cost_plan" ("status", "updated_at");
CREATE INDEX "trip_cost_item_plan_id_category_idx"
  ON "trip_cost_item" ("plan_id", "category");

ALTER TABLE "trip_cost_plan"
  ADD CONSTRAINT "trip_cost_plan_trip_id_fkey"
  FOREIGN KEY ("trip_id") REFERENCES "trip"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "trip_cost_item"
  ADD CONSTRAINT "trip_cost_item_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "trip_cost_plan"("id")
  ON DELETE CASCADE ON UPDATE RESTRICT;

-- A locked plan is a terminal snapshot. Identity and creation time never move;
-- direct SQL receives the same protection as the API.
CREATE FUNCTION "trip_cost_plan_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'trip cost plans cannot be deleted'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."trip_id" IS DISTINCT FROM OLD."trip_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'trip cost plan identity is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'LOCKED' THEN
    IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
      RAISE EXCEPTION 'locked trip cost plan is immutable'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN OLD;
  END IF;
  NEW."updated_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trip_cost_plan_guard"
  BEFORE UPDATE OR DELETE ON "trip_cost_plan"
  FOR EACH ROW EXECUTE FUNCTION "trip_cost_plan_guard"();

CREATE FUNCTION "trip_cost_item_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_plan_id UUID;
  target_status "trip_cost_status";
BEGIN
  target_plan_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."plan_id" ELSE NEW."plan_id" END;
  SELECT "status" INTO target_status FROM "trip_cost_plan" WHERE "id" = target_plan_id;
  IF target_status = 'LOCKED' THEN
    RAISE EXCEPTION 'locked trip cost plan items are immutable'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."plan_id" IS DISTINCT FROM OLD."plan_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
      RAISE EXCEPTION 'trip cost item identity is immutable'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW."updated_at" := clock_timestamp();
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trip_cost_item_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "trip_cost_item"
  FOR EACH ROW EXECUTE FUNCTION "trip_cost_item_guard"();

CREATE FUNCTION "trip_cost_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'trip cost history cannot be truncated'
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;

CREATE TRIGGER "trip_cost_plan_no_truncate"
  BEFORE TRUNCATE ON "trip_cost_plan"
  FOR EACH STATEMENT EXECUTE FUNCTION "trip_cost_no_truncate"();
CREATE TRIGGER "trip_cost_item_no_truncate"
  BEFORE TRUNCATE ON "trip_cost_item"
  FOR EACH STATEMENT EXECUTE FUNCTION "trip_cost_no_truncate"();
