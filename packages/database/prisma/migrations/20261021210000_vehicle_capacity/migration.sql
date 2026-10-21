-- FLEET-CAPACITY-1: operational vehicle purpose and dual physical capacity.
--
-- Seat capacity remains authoritative in SeatMap and is not duplicated here.
-- Weight and volume are a pair: later baggage/cargo allocation must satisfy
-- BOTH remaining limits. Volume is stored as whole litres for exact arithmetic.

CREATE TYPE "vehicle_role" AS ENUM ('PASSENGER_COACH', 'CARGO_SUPPORT', 'MIXED');

ALTER TABLE "vehicle"
  ADD COLUMN "role" "vehicle_role" NOT NULL DEFAULT 'PASSENGER_COACH',
  ADD COLUMN "payload_capacity_kg" INTEGER,
  ADD COLUMN "cargo_volume_liters" INTEGER;

ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_load_capacity_pair"
  CHECK (
    (
      "payload_capacity_kg" IS NULL
      AND "cargo_volume_liters" IS NULL
    )
    OR (
      "payload_capacity_kg" IS NOT NULL
      AND "cargo_volume_liters" IS NOT NULL
      AND "payload_capacity_kg" > 0
      AND "cargo_volume_liters" > 0
    )
  );

COMMENT ON COLUMN "vehicle"."payload_capacity_kg" IS
  'Maximum useful baggage/freight load in whole kilograms; configured with cargo_volume_liters.';
COMMENT ON COLUMN "vehicle"."cargo_volume_liters" IS
  'Maximum useful baggage/freight volume in whole litres; 1000 litres = 1 cubic metre.';
