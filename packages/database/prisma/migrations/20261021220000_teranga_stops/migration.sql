-- TERANGA-STOPS-1: traveller-visible operational stop metadata on existing checkpoints.
--
-- No legal driving-time rule is encoded here. suggested_dwell_minutes is a
-- planning hint only; actual trip times remain in trip_waypoint_timing.

CREATE TYPE "teranga_stop_kind" AS ENUM (
  'BREAK',
  'MEAL',
  'SHOWER',
  'REST',
  'OVERNIGHT',
  'FUEL',
  'BORDER',
  'FERRY',
  'TECHNICAL'
);

CREATE TYPE "teranga_facility" AS ENUM (
  'RESTROOM',
  'SHOWER',
  'FOOD',
  'SECURE_PARKING',
  'FUEL'
);

ALTER TABLE "checkpoint"
  ADD COLUMN "teranga_kind" "teranga_stop_kind" NOT NULL DEFAULT 'TECHNICAL',
  ADD COLUMN "traveller_visible" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "suggested_dwell_minutes" INTEGER,
  ADD COLUMN "facilities" "teranga_facility"[] NOT NULL DEFAULT ARRAY[]::"teranga_facility"[];

-- Preserve the existing public behaviour for already configured crossings:
-- borders and ferry/port points were public, TECHNICAL points were hidden.
UPDATE "checkpoint"
SET
  "teranga_kind" = CASE
    WHEN "type" = 'BORDER' THEN 'BORDER'::"teranga_stop_kind"
    WHEN "type" IN ('FERRY_TERMINAL', 'PORT') THEN 'FERRY'::"teranga_stop_kind"
    ELSE 'TECHNICAL'::"teranga_stop_kind"
  END,
  "traveller_visible" = ("type" <> 'TECHNICAL');

CREATE FUNCTION "teranga_facilities_distinct"(list "teranga_facility"[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(list) = (SELECT count(DISTINCT item) FROM unnest(list) AS item)
$$;

ALTER TABLE "checkpoint" ADD CONSTRAINT "checkpoint_teranga_kind_compatible"
  CHECK (
    ("type" = 'BORDER' AND "teranga_kind" = 'BORDER')
    OR (
      "type" IN ('FERRY_TERMINAL', 'PORT')
      AND "teranga_kind" = 'FERRY'
    )
    OR (
      "type" = 'TECHNICAL'
      AND "teranga_kind" IN ('BREAK', 'MEAL', 'SHOWER', 'REST', 'OVERNIGHT', 'FUEL', 'TECHNICAL')
    )
  );

ALTER TABLE "checkpoint" ADD CONSTRAINT "checkpoint_suggested_dwell_range"
  CHECK (
    "suggested_dwell_minutes" IS NULL
    OR "suggested_dwell_minutes" BETWEEN 5 AND 1440
  );

ALTER TABLE "checkpoint" ADD CONSTRAINT "checkpoint_teranga_facilities_distinct"
  CHECK ("teranga_facilities_distinct"("facilities"));

CREATE INDEX "checkpoint_teranga_kind_idx" ON "checkpoint"("teranga_kind");
CREATE INDEX "checkpoint_traveller_visible_active_id_idx"
  ON "checkpoint"("traveller_visible", "active", "id");

COMMENT ON COLUMN "checkpoint"."suggested_dwell_minutes" IS
  'Non-binding planning hint only; does not encode a legal or driver-hours requirement.';
COMMENT ON COLUMN "checkpoint"."traveller_visible" IS
  'Explicit opt-in for traveller-facing itinerary display.';
