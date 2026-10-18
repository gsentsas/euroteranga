-- CMS-1: structured content of the public website (pages, site settings,
-- navigation) with draft, publication and immutable history.

-- CreateEnum
CREATE TYPE "content_entry_kind" AS ENUM ('PAGE', 'SITE_SETTINGS', 'NAVIGATION');

-- CreateEnum
CREATE TYPE "content_revision_status" AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "content_entry" (
    "id" UUID NOT NULL,
    "kind" "content_entry_kind" NOT NULL,
    "key" VARCHAR(120) NOT NULL,
    "last_revision" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "content_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_revision" (
    "id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" "content_revision_status" NOT NULL DEFAULT 'DRAFT',
    "document" JSONB NOT NULL,
    "note" VARCHAR(200),
    "based_on_revision" INTEGER,
    "author_identity_id" UUID,
    "published_at" TIMESTAMPTZ(3),
    "published_by_identity_id" UUID,
    "superseded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "content_revision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "content_entry_kind_key_key" ON "content_entry"("kind", "key");

-- CreateIndex
CREATE INDEX "content_revision_entry_id_status_idx" ON "content_revision"("entry_id", "status");

-- CreateIndex
CREATE INDEX "content_revision_author_identity_id_idx" ON "content_revision"("author_identity_id");

-- CreateIndex
CREATE INDEX "content_revision_published_by_identity_id_idx" ON "content_revision"("published_by_identity_id");

-- CreateIndex
CREATE UNIQUE INDEX "content_revision_entry_id_revision_key" ON "content_revision"("entry_id", "revision");

-- AddForeignKey
ALTER TABLE "content_revision" ADD CONSTRAINT "content_revision_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "content_entry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_revision" ADD CONSTRAINT "content_revision_author_identity_id_fkey" FOREIGN KEY ("author_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_revision" ADD CONSTRAINT "content_revision_published_by_identity_id_fkey" FOREIGN KEY ("published_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One editable draft and one live revision per entry, at most.
CREATE UNIQUE INDEX "content_revision_one_draft_per_entry"
  ON "content_revision"("entry_id") WHERE "status" = 'DRAFT';
CREATE UNIQUE INDEX "content_revision_one_published_per_entry"
  ON "content_revision"("entry_id") WHERE "status" = 'PUBLISHED';

ALTER TABLE "content_entry" ADD CONSTRAINT "content_entry_key_format_check" CHECK (
  ("kind" = 'PAGE' AND "key" ~ '^/([a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*){0,3})?$')
  OR ("kind" = 'SITE_SETTINGS' AND "key" = 'site')
  OR ("kind" = 'NAVIGATION' AND "key" = 'navigation')
);
ALTER TABLE "content_entry" ADD CONSTRAINT "content_entry_last_revision_check"
  CHECK ("last_revision" >= 0);
ALTER TABLE "content_entry" ADD CONSTRAINT "content_entry_archive_check"
  CHECK ("kind" = 'PAGE' OR "archived_at" IS NULL);

ALTER TABLE "content_revision" ADD CONSTRAINT "content_revision_document_object_check"
  CHECK (jsonb_typeof("document") = 'object');
ALTER TABLE "content_revision" ADD CONSTRAINT "content_revision_document_size_check"
  CHECK (octet_length("document"::text) <= 262144);
ALTER TABLE "content_revision" ADD CONSTRAINT "content_revision_number_check" CHECK (
  "revision" >= 1
  AND ("based_on_revision" IS NULL OR ("based_on_revision" >= 1 AND "based_on_revision" < "revision"))
);
ALTER TABLE "content_revision" ADD CONSTRAINT "content_revision_note_check"
  CHECK ("note" IS NULL OR ("note" = btrim("note") AND char_length("note") >= 1));
ALTER TABLE "content_revision" ADD CONSTRAINT "content_revision_state_check" CHECK (
  ("status" = 'DRAFT' AND "published_at" IS NULL AND "published_by_identity_id" IS NULL
    AND "superseded_at" IS NULL)
  OR ("status" = 'PUBLISHED' AND "published_at" IS NOT NULL AND "superseded_at" IS NULL)
  OR ("status" = 'SUPERSEDED' AND "published_at" IS NOT NULL AND "superseded_at" IS NOT NULL)
);

-- Entries are never deleted (pages are archived) and their identity is fixed.
CREATE FUNCTION "content_entry_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'content entries cannot be deleted; archive the page instead';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."key" IS DISTINCT FROM OLD."key" OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'content entry identity is immutable';
  END IF;
  IF NEW."last_revision" < OLD."last_revision" THEN
    RAISE EXCEPTION 'content revision numbers are never reused';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "content_entry_guard"
  BEFORE UPDATE OR DELETE ON "content_entry"
  FOR EACH ROW EXECUTE FUNCTION "content_entry_guard"();

-- Revisions: drafts are editable and discardable; publication is stamped by
-- the database clock; published and superseded revisions are history.
CREATE FUNCTION "content_revision_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  latest INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'content revisions are created as DRAFT';
    END IF;
    -- Numbers are issued once per entry, even when a draft is later discarded.
    SELECT "last_revision" INTO latest FROM "content_entry" WHERE "id" = NEW."entry_id" FOR UPDATE;
    IF latest IS NULL OR NEW."revision" <> latest + 1 THEN
      RAISE EXCEPTION 'content revision numbers only increase, one at a time';
    END IF;
    UPDATE "content_entry" SET "last_revision" = NEW."revision" WHERE "id" = NEW."entry_id";
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'published content history cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."entry_id" IS DISTINCT FROM OLD."entry_id"
     OR NEW."revision" IS DISTINCT FROM OLD."revision"
     OR NEW."based_on_revision" IS DISTINCT FROM OLD."based_on_revision"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'content revision identity is immutable';
  END IF;

  IF OLD."status" = 'DRAFT' THEN
    IF NEW."status" = 'PUBLISHED' THEN
      NEW."published_at" := clock_timestamp();
    ELSIF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'a draft can only be published';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'PUBLISHED' AND NEW."status" = 'SUPERSEDED'
     AND NEW."document" = OLD."document"
     AND NEW."note" IS NOT DISTINCT FROM OLD."note"
     AND NEW."author_identity_id" IS NOT DISTINCT FROM OLD."author_identity_id"
     AND NEW."published_at" = OLD."published_at"
     AND NEW."published_by_identity_id" IS NOT DISTINCT FROM OLD."published_by_identity_id" THEN
    NEW."superseded_at" := clock_timestamp();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'published content revisions are immutable';
END;
$$;

CREATE TRIGGER "content_revision_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "content_revision"
  FOR EACH ROW EXECUTE FUNCTION "content_revision_guard"();

CREATE FUNCTION "content_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'content history cannot be truncated';
END;
$$;

CREATE TRIGGER "content_entry_no_truncate"
  BEFORE TRUNCATE ON "content_entry"
  FOR EACH STATEMENT EXECUTE FUNCTION "content_no_truncate"();
CREATE TRIGGER "content_revision_no_truncate"
  BEFORE TRUNCATE ON "content_revision"
  FOR EACH STATEMENT EXECUTE FUNCTION "content_no_truncate"();

-- Permissions: reading and editing content are separate from operations;
-- SEO metadata of a page needs seo.manage on top of content.manage.
INSERT INTO "authorization_permission" ("key", "description") VALUES
  ('content.read', 'Read public website content, drafts and history'),
  ('content.manage', 'Create, edit, publish, restore and archive public website content'),
  ('seo.manage', 'Change the search metadata (title, description, indexing) of public pages');

INSERT INTO "authorization_role" ("key", "name", "description", "realm", "privileged", "system", "updated_at") VALUES
  ('CONTENT_EDITOR', 'Éditeur de contenus', 'Public website content (pages, navigation, settings)', 'STAFF', false, true, CURRENT_TIMESTAMP);

INSERT INTO "authorization_role_permission" ("role_key", "permission_key") VALUES
  ('SUPER_ADMIN', 'content.read'),
  ('SUPER_ADMIN', 'content.manage'),
  ('SUPER_ADMIN', 'seo.manage'),
  ('DIRECTOR', 'content.read'),
  ('DIRECTOR', 'content.manage'),
  ('DIRECTOR', 'seo.manage'),
  ('CONTENT_EDITOR', 'ops.access'),
  ('CONTENT_EDITOR', 'content.read'),
  ('CONTENT_EDITOR', 'content.manage');
