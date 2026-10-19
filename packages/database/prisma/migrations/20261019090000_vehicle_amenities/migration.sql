-- UI-PUBLIC-2: on-board equipment of a vehicle, maintained by the fleet team
-- (fleet.manage, audited with the vehicle) and shown on the public website.
-- Nothing is assumed: an existing vehicle starts with no listed equipment.

-- CreateEnum
CREATE TYPE "vehicle_amenity" AS ENUM ('AIR_CONDITIONING', 'RECLINING_SEATS', 'USB_CHARGING', 'WIFI', 'TOILET', 'ENTERTAINMENT', 'WHEELCHAIR_ACCESS');

-- AlterTable
ALTER TABLE "vehicle" ADD COLUMN     "amenities" "vehicle_amenity"[] DEFAULT ARRAY[]::"vehicle_amenity"[];

-- A list, never null, each equipment at most once.
CREATE FUNCTION "vehicle_amenities_distinct"(list "vehicle_amenity"[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(list) = (SELECT count(DISTINCT item) FROM unnest(list) AS item)
$$;

ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_amenities_check"
  CHECK ("amenities" IS NOT NULL AND "vehicle_amenities_distinct"("amenities"));
