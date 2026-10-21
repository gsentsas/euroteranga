-- FLEET-MEDIA-1: public photographs attached directly to vehicles. Images
-- remain owned and served by MEDIA-1; no URL or duplicate upload is stored.

-- CreateEnum
CREATE TYPE "vehicle_media_kind" AS ENUM (
  'EXTERIOR', 'INTERIOR', 'SEATS', 'LUGGAGE_HOLD', 'EQUIPMENT', 'CABIN', 'OTHER'
);

-- AlterTable (nullable: every existing vehicle remains valid).
ALTER TABLE "vehicle" ADD COLUMN "primary_media_id" UUID;

-- CreateTable
CREATE TABLE "vehicle_media" (
  "id" UUID NOT NULL,
  "vehicle_id" UUID NOT NULL,
  "media_id" UUID NOT NULL,
  "kind" "vehicle_media_kind",
  "position" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "vehicle_media_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "vehicle_primary_media_id_idx" ON "vehicle"("primary_media_id");
CREATE INDEX "vehicle_media_media_id_idx" ON "vehicle_media"("media_id");
CREATE UNIQUE INDEX "vehicle_media_vehicle_id_media_id_key"
  ON "vehicle_media"("vehicle_id", "media_id");
CREATE UNIQUE INDEX "vehicle_media_vehicle_id_position_key"
  ON "vehicle_media"("vehicle_id", "position");

ALTER TABLE "vehicle_media" ADD CONSTRAINT "vehicle_media_position_check"
  CHECK ("position" BETWEEN 0 AND 5);

ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_primary_media_id_fkey"
  FOREIGN KEY ("primary_media_id") REFERENCES "public_media_asset"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_media" ADD CONSTRAINT "vehicle_media_vehicle_id_fkey"
  FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_media" ADD CONSTRAINT "vehicle_media_media_id_fkey"
  FOREIGN KEY ("media_id") REFERENCES "public_media_asset"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Direct SQL writes have the same rules as the API: only ACTIVE MEDIA-1
-- assets can be attached, and a retired vehicle remains frozen.
CREATE FUNCTION "vehicle_primary_media_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."primary_media_id" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."primary_media_id" IS DISTINCT FROM OLD."primary_media_id")
     AND NOT EXISTS (
       SELECT 1 FROM "public_media_asset" m
       WHERE m."id" = NEW."primary_media_id" AND m."status" = 'ACTIVE'
     ) THEN
    RAISE EXCEPTION 'vehicle primary media must be an active public media asset'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "vehicle_primary_media_guard"
  BEFORE INSERT OR UPDATE OF "primary_media_id" ON "vehicle"
  FOR EACH ROW EXECUTE FUNCTION "vehicle_primary_media_guard"();

CREATE FUNCTION "vehicle_gallery_media_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_vehicle_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_vehicle_id := OLD."vehicle_id";
  ELSE
    target_vehicle_id := NEW."vehicle_id";
  END IF;
  IF EXISTS (
    SELECT 1 FROM "vehicle" v
    WHERE v."id" = target_vehicle_id AND v."status" = 'RETIRED'
  ) THEN
    RAISE EXCEPTION 'retired vehicles are immutable'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF TG_OP <> 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM "public_media_asset" m
    WHERE m."id" = NEW."media_id" AND m."status" = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'vehicle gallery media must be an active public media asset'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "vehicle_gallery_media_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "vehicle_media"
  FOR EACH ROW EXECUTE FUNCTION "vehicle_gallery_media_guard"();

-- MEDIA-1 archiving stays terminal and is refused while either vehicle
-- relation still uses the asset, including a non-public vehicle.
CREATE FUNCTION "public_media_vehicle_use_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'ARCHIVED' AND OLD."status" = 'ACTIVE' AND (
    EXISTS (SELECT 1 FROM "vehicle" v WHERE v."primary_media_id" = OLD."id")
    OR EXISTS (SELECT 1 FROM "vehicle_media" vm WHERE vm."media_id" = OLD."id")
  ) THEN
    RAISE EXCEPTION 'public media asset is in use by a vehicle'
      USING ERRCODE = 'object_in_use';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "public_media_vehicle_use_guard"
  BEFORE UPDATE OF "status" ON "public_media_asset"
  FOR EACH ROW EXECUTE FUNCTION "public_media_vehicle_use_guard"();

-- Fleet managers may browse and select existing public images. Uploading,
-- editing and archiving still require media.manage and remain unchanged.
INSERT INTO "authorization_role_permission" ("role_key", "permission_key")
VALUES ('OPS_MANAGER', 'media.read')
ON CONFLICT DO NOTHING;
