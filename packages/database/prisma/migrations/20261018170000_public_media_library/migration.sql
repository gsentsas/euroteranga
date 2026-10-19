-- MEDIA-1: public media library of the website. Separate from passenger
-- documents: different tables, permissions and storage root. Only WebP
-- renditions re-encoded without metadata are stored; the uploaded file is not.
-- An asset is immutable: replacing an image means uploading a new asset, and
-- archiving is terminal.

-- CreateEnum
CREATE TYPE "public_media_status" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "public_media_asset" (
    "id" UUID NOT NULL,
    "status" "public_media_status" NOT NULL DEFAULT 'ACTIVE',
    "alt_text" VARCHAR(250) NOT NULL,
    "caption" VARCHAR(240),
    "credit" VARCHAR(160),
    "source_format" VARCHAR(8) NOT NULL,
    "source_sha256" CHAR(64) NOT NULL,
    "source_bytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "focal_x" SMALLINT NOT NULL DEFAULT 50,
    "focal_y" SMALLINT NOT NULL DEFAULT 50,
    "created_by_identity_id" UUID,
    "updated_by_identity_id" UUID,
    "archived_at" TIMESTAMPTZ(3),
    "archived_by_identity_id" UUID,
    "archive_reason" VARCHAR(300),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "public_media_asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_media_rendition" (
    "id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "format" VARCHAR(8) NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "storage_key" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "public_media_rendition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "public_media_asset_source_sha256_idx" ON "public_media_asset"("source_sha256");

-- CreateIndex
CREATE INDEX "public_media_asset_status_created_at_idx" ON "public_media_asset"("status", "created_at");

-- CreateIndex
CREATE INDEX "public_media_asset_created_by_identity_id_idx" ON "public_media_asset"("created_by_identity_id");

-- CreateIndex
CREATE INDEX "public_media_asset_updated_by_identity_id_idx" ON "public_media_asset"("updated_by_identity_id");

-- CreateIndex
CREATE INDEX "public_media_asset_archived_by_identity_id_idx" ON "public_media_asset"("archived_by_identity_id");

-- CreateIndex
CREATE INDEX "public_media_rendition_storage_key_idx" ON "public_media_rendition"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "public_media_rendition_asset_id_width_key" ON "public_media_rendition"("asset_id", "width");

-- AddForeignKey
ALTER TABLE "public_media_asset" ADD CONSTRAINT "public_media_asset_created_by_identity_id_fkey" FOREIGN KEY ("created_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_media_asset" ADD CONSTRAINT "public_media_asset_updated_by_identity_id_fkey" FOREIGN KEY ("updated_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_media_asset" ADD CONSTRAINT "public_media_asset_archived_by_identity_id_fkey" FOREIGN KEY ("archived_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_media_rendition" ADD CONSTRAINT "public_media_rendition_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public_media_asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



ALTER TABLE "public_media_asset" ADD CONSTRAINT "public_media_asset_alt_text_check"
  CHECK ("alt_text" = btrim("alt_text") AND char_length("alt_text") >= 1);
ALTER TABLE "public_media_asset" ADD CONSTRAINT "public_media_asset_texts_check" CHECK (
  ("caption" IS NULL OR ("caption" = btrim("caption") AND char_length("caption") >= 1))
  AND ("credit" IS NULL OR ("credit" = btrim("credit") AND char_length("credit") >= 1))
);
ALTER TABLE "public_media_asset" ADD CONSTRAINT "public_media_asset_source_check" CHECK (
  "source_format" IN ('jpeg', 'png', 'webp')
  AND "source_sha256" ~ '^[0-9a-f]{64}$'
  AND "source_bytes" BETWEEN 1 AND 20971520
  AND "width" BETWEEN 1 AND 20000
  AND "height" BETWEEN 1 AND 20000
);
ALTER TABLE "public_media_asset" ADD CONSTRAINT "public_media_asset_focal_check"
  CHECK ("focal_x" BETWEEN 0 AND 100 AND "focal_y" BETWEEN 0 AND 100);
ALTER TABLE "public_media_asset" ADD CONSTRAINT "public_media_asset_archive_check" CHECK (
  ("status" = 'ACTIVE' AND "archived_at" IS NULL AND "archived_by_identity_id" IS NULL
    AND "archive_reason" IS NULL)
  OR ("status" = 'ARCHIVED' AND "archived_at" IS NOT NULL AND "archive_reason" IS NOT NULL
    AND "archive_reason" = btrim("archive_reason") AND char_length("archive_reason") >= 3)
);

-- The same file twice is refused among active assets only: once archived,
-- it can be uploaded again as a new asset (archiving is terminal).
CREATE UNIQUE INDEX "public_media_asset_active_source_key"
  ON "public_media_asset"("source_sha256") WHERE "status" = 'ACTIVE';

ALTER TABLE "public_media_rendition" ADD CONSTRAINT "public_media_rendition_file_check" CHECK (
  "format" = 'webp'
  AND "width" BETWEEN 1 AND 20000
  AND "height" BETWEEN 1 AND 20000
  AND "bytes" >= 1
  AND "sha256" ~ '^[0-9a-f]{64}$'
  AND "storage_key" = 'public-media/' || substr("sha256", 1, 2) || '/' || "sha256"
);

-- Assets are archived, never deleted, and what was uploaded never changes.
-- Archiving is terminal: an archived asset is frozen.
CREATE FUNCTION "public_media_asset_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'public media assets cannot be deleted; archive them instead';
  END IF;
  IF OLD."status" = 'ARCHIVED' THEN
    RAISE EXCEPTION 'archived public media assets are frozen';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."source_format" IS DISTINCT FROM OLD."source_format"
     OR NEW."source_sha256" IS DISTINCT FROM OLD."source_sha256"
     OR NEW."source_bytes" IS DISTINCT FROM OLD."source_bytes"
     OR NEW."width" IS DISTINCT FROM OLD."width"
     OR NEW."height" IS DISTINCT FROM OLD."height"
     OR NEW."created_by_identity_id" IS DISTINCT FROM OLD."created_by_identity_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'public media source facts are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "public_media_asset_guard"
  BEFORE UPDATE OR DELETE ON "public_media_asset"
  FOR EACH ROW EXECUTE FUNCTION "public_media_asset_guard"();

-- A stored rendition is an immutable fact: its file is content-addressed.
CREATE FUNCTION "public_media_rendition_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'public media renditions are immutable';
END;
$$;

CREATE TRIGGER "public_media_rendition_guard"
  BEFORE UPDATE OR DELETE ON "public_media_rendition"
  FOR EACH ROW EXECUTE FUNCTION "public_media_rendition_guard"();

-- Media of the website is its own grant: no operational or passenger
-- document permission implies it, and media.* gives no access to passenger
-- documents.
INSERT INTO "authorization_permission" ("key", "description") VALUES
  ('media.read', 'Read the public media library of the website'),
  ('media.manage', 'Upload, describe and archive public website media');

INSERT INTO "authorization_role_permission" ("role_key", "permission_key") VALUES
  ('SUPER_ADMIN', 'media.read'),
  ('SUPER_ADMIN', 'media.manage'),
  ('DIRECTOR', 'media.read'),
  ('DIRECTOR', 'media.manage'),
  ('CONTENT_EDITOR', 'media.read'),
  ('CONTENT_EDITOR', 'media.manage');
