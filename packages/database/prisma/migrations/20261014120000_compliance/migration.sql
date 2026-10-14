-- PR-12 Compliance: versioned regulatory rules, deterministic evaluation of
-- one booking passenger and append-only human review.
-- CODE_IS_NOT_LEGAL_AUTHORITY: this migration creates no regulatory rule.
-- Rules exist only as verified, published versions entered by authorized STAFF.
-- CreateEnum
CREATE TYPE "compliance_rule_version_status" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "compliance_verification_status" AS ENUM ('UNVERIFIED', 'VERIFIED');

-- CreateEnum
CREATE TYPE "compliance_outcome" AS ENUM ('PASS', 'FAIL', 'REVIEW_REQUIRED', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "compliance_result" AS ENUM ('PASS', 'FAIL', 'REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "compliance_review_decision" AS ENUM ('COMPLIANT', 'NON_COMPLIANT', 'NEEDS_INFORMATION');

-- CreateTable
CREATE TABLE "compliance_rule" (
    "id" UUID NOT NULL,
    "reference" VARCHAR(17) NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "compliance_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_rule_version" (
    "id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "compliance_rule_version_status" NOT NULL DEFAULT 'DRAFT',
    "language_version" INTEGER NOT NULL DEFAULT 1,
    "definition" JSONB NOT NULL,
    "definition_sha256" CHAR(64) NOT NULL,
    "customer_guidance" VARCHAR(500) NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "source_authority" VARCHAR(200),
    "source_title" VARCHAR(300),
    "source_url" VARCHAR(2048),
    "source_reference" VARCHAR(200),
    "source_checked_on" DATE,
    "verification_status" "compliance_verification_status" NOT NULL DEFAULT 'UNVERIFIED',
    "verified_at" TIMESTAMPTZ(3),
    "verified_by_identity_id" UUID,
    "verified_definition_sha256" CHAR(64),
    "verification_note" VARCHAR(1000),
    "published_at" TIMESTAMPTZ(3),
    "published_by_identity_id" UUID,
    "retired_at" TIMESTAMPTZ(3),
    "retired_by_identity_id" UUID,
    "retirement_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "compliance_rule_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_evaluation" (
    "id" UUID NOT NULL,
    "reference" VARCHAR(17) NOT NULL,
    "booking_id" UUID NOT NULL,
    "passenger_id" UUID NOT NULL,
    "travel_date" DATE NOT NULL,
    "arrival_date" DATE NOT NULL,
    "engine_version" VARCHAR(32) NOT NULL,
    "facts" JSONB NOT NULL,
    "facts_fingerprint" CHAR(64) NOT NULL,
    "rules_fingerprint" CHAR(64) NOT NULL,
    "result" "compliance_result" NOT NULL,
    "findings" JSONB NOT NULL DEFAULT '[]',
    "actor_identity_id" UUID NOT NULL,
    "evaluated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_evaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_evaluation_result" (
    "id" UUID NOT NULL,
    "evaluation_id" UUID NOT NULL,
    "rule_version_id" UUID NOT NULL,
    "outcome" "compliance_outcome" NOT NULL,
    "reason_code" VARCHAR(64) NOT NULL,
    "details" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "compliance_evaluation_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_evaluation_evidence" (
    "evaluation_result_id" UUID NOT NULL,
    "passenger_document_id" UUID NOT NULL,

    CONSTRAINT "compliance_evaluation_evidence_pkey" PRIMARY KEY ("evaluation_result_id","passenger_document_id")
);

-- CreateTable
CREATE TABLE "compliance_review" (
    "id" UUID NOT NULL,
    "evaluation_id" UUID NOT NULL,
    "supersedes_review_id" UUID,
    "decision" "compliance_review_decision" NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "customer_message" VARCHAR(500),
    "reviewer_identity_id" UUID NOT NULL,
    "reviewed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_review_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "compliance_rule_reference_key" ON "compliance_rule"("reference");

-- CreateIndex
CREATE INDEX "compliance_rule_version_status_effective_from_idx" ON "compliance_rule_version"("status", "effective_from");

-- CreateIndex
CREATE INDEX "compliance_rule_version_verified_by_identity_id_idx" ON "compliance_rule_version"("verified_by_identity_id");

-- CreateIndex
CREATE INDEX "compliance_rule_version_published_by_identity_id_idx" ON "compliance_rule_version"("published_by_identity_id");

-- CreateIndex
CREATE INDEX "compliance_rule_version_retired_by_identity_id_idx" ON "compliance_rule_version"("retired_by_identity_id");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_rule_version_rule_id_version_key" ON "compliance_rule_version"("rule_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_evaluation_reference_key" ON "compliance_evaluation"("reference");

-- CreateIndex
CREATE INDEX "compliance_evaluation_booking_id_passenger_id_evaluated_at_idx" ON "compliance_evaluation"("booking_id", "passenger_id", "evaluated_at");

-- CreateIndex
CREATE INDEX "compliance_evaluation_result_id_idx" ON "compliance_evaluation"("result", "id");

-- CreateIndex
CREATE INDEX "compliance_evaluation_travel_date_id_idx" ON "compliance_evaluation"("travel_date", "id");

-- CreateIndex
CREATE INDEX "compliance_evaluation_actor_identity_id_idx" ON "compliance_evaluation"("actor_identity_id");

-- CreateIndex
CREATE INDEX "compliance_evaluation_result_rule_version_id_idx" ON "compliance_evaluation_result"("rule_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_evaluation_result_evaluation_id_rule_version_id_key" ON "compliance_evaluation_result"("evaluation_id", "rule_version_id");

-- CreateIndex
CREATE INDEX "compliance_evaluation_evidence_passenger_document_id_idx" ON "compliance_evaluation_evidence"("passenger_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_review_supersedes_review_id_key" ON "compliance_review"("supersedes_review_id");

-- CreateIndex
CREATE INDEX "compliance_review_evaluation_id_reviewed_at_idx" ON "compliance_review"("evaluation_id", "reviewed_at");

-- CreateIndex
CREATE INDEX "compliance_review_reviewer_identity_id_idx" ON "compliance_review"("reviewer_identity_id");

-- AddForeignKey
ALTER TABLE "compliance_rule_version" ADD CONSTRAINT "compliance_rule_version_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "compliance_rule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_rule_version" ADD CONSTRAINT "compliance_rule_version_verified_by_identity_id_fkey" FOREIGN KEY ("verified_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_rule_version" ADD CONSTRAINT "compliance_rule_version_published_by_identity_id_fkey" FOREIGN KEY ("published_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_rule_version" ADD CONSTRAINT "compliance_rule_version_retired_by_identity_id_fkey" FOREIGN KEY ("retired_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_evaluation" ADD CONSTRAINT "compliance_evaluation_booking_id_passenger_id_fkey" FOREIGN KEY ("booking_id", "passenger_id") REFERENCES "booking_passenger"("booking_id", "passenger_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_evaluation" ADD CONSTRAINT "compliance_evaluation_actor_identity_id_fkey" FOREIGN KEY ("actor_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_evaluation_result" ADD CONSTRAINT "compliance_evaluation_result_evaluation_id_fkey" FOREIGN KEY ("evaluation_id") REFERENCES "compliance_evaluation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_evaluation_result" ADD CONSTRAINT "compliance_evaluation_result_rule_version_id_fkey" FOREIGN KEY ("rule_version_id") REFERENCES "compliance_rule_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_evaluation_evidence" ADD CONSTRAINT "compliance_evaluation_evidence_evaluation_result_id_fkey" FOREIGN KEY ("evaluation_result_id") REFERENCES "compliance_evaluation_result"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_evaluation_evidence" ADD CONSTRAINT "compliance_evaluation_evidence_passenger_document_id_fkey" FOREIGN KEY ("passenger_document_id") REFERENCES "passenger_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_review" ADD CONSTRAINT "compliance_review_evaluation_id_fkey" FOREIGN KEY ("evaluation_id") REFERENCES "compliance_evaluation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_review" ADD CONSTRAINT "compliance_review_supersedes_review_id_fkey" FOREIGN KEY ("supersedes_review_id") REFERENCES "compliance_review"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_review" ADD CONSTRAINT "compliance_review_reviewer_identity_id_fkey" FOREIGN KEY ("reviewer_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Public references (60 bits of CSPRNG entropy, unambiguous alphabet).
ALTER TABLE "compliance_rule" ADD CONSTRAINT "compliance_rule_reference_format"
  CHECK ("reference" ~ '^ETCR-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$');
ALTER TABLE "compliance_rule" ADD CONSTRAINT "compliance_rule_title_plain"
  CHECK (
    length("title") BETWEEN 3 AND 160
    AND "title" = btrim("title")
    AND "title" !~ '[<>[:cntrl:]]'
  );

ALTER TABLE "compliance_rule_version" ADD CONSTRAINT "compliance_rule_version_number_positive"
  CHECK ("version" > 0);
ALTER TABLE "compliance_rule_version" ADD CONSTRAINT "compliance_rule_version_language_known"
  CHECK ("language_version" = 1);
ALTER TABLE "compliance_rule_version" ADD CONSTRAINT "compliance_rule_version_definition_shape"
  CHECK (jsonb_typeof("definition") = 'object' AND octet_length("definition"::text) <= 16384);
ALTER TABLE "compliance_rule_version" ADD CONSTRAINT "compliance_rule_version_digest_format"
  CHECK (
    "definition_sha256" ~ '^[0-9a-f]{64}$'
    AND ("verified_definition_sha256" IS NULL OR "verified_definition_sha256" ~ '^[0-9a-f]{64}$')
  );
ALTER TABLE "compliance_rule_version" ADD CONSTRAINT "compliance_rule_version_guidance_plain"
  CHECK (
    length("customer_guidance") BETWEEN 1 AND 500
    AND "customer_guidance" = btrim("customer_guidance")
    AND "customer_guidance" !~ '[<>[:cntrl:]]'
  );
-- Inclusive calendar interval compared with the planned travel date.
ALTER TABLE "compliance_rule_version" ADD CONSTRAINT "compliance_rule_version_effective_interval"
  CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");
ALTER TABLE "compliance_rule_version" ADD CONSTRAINT "compliance_rule_version_source_plain"
  CHECK (
    ("source_authority" IS NULL OR (length(btrim("source_authority")) > 0
      AND "source_authority" = btrim("source_authority") AND "source_authority" !~ '[<>[:cntrl:]]'))
    AND ("source_title" IS NULL OR (length(btrim("source_title")) > 0
      AND "source_title" = btrim("source_title") AND "source_title" !~ '[<>[:cntrl:]]'))
    AND ("source_reference" IS NULL OR (length(btrim("source_reference")) > 0
      AND "source_reference" = btrim("source_reference") AND "source_reference" !~ '[<>[:cntrl:]]'))
    AND ("verification_note" IS NULL OR (length(btrim("verification_note")) > 0
      AND "verification_note" !~ '[<>]'))
    AND ("retirement_reason" IS NULL OR (length(btrim("retirement_reason")) >= 10
      AND "retirement_reason" !~ '[<>]'))
  );
-- Sources are links to official https pages only (no javascript:, data:, http:).
ALTER TABLE "compliance_rule_version" ADD CONSTRAINT "compliance_rule_version_source_url_https"
  CHECK ("source_url" IS NULL OR "source_url" ~ '^https://[^[:space:]<>"]+$');
-- VERIFIED needs complete provenance and pins the exact verified definition:
-- any later definition change is impossible without losing verification.
ALTER TABLE "compliance_rule_version" ADD CONSTRAINT "compliance_rule_version_verification_consistent"
  CHECK (
    (
      "verification_status" = 'UNVERIFIED'
      AND "verified_at" IS NULL
      AND "verified_by_identity_id" IS NULL
      AND "verified_definition_sha256" IS NULL
    ) OR (
      "verification_status" = 'VERIFIED'
      AND "verified_at" IS NOT NULL
      AND "verified_by_identity_id" IS NOT NULL
      AND "verified_definition_sha256" = "definition_sha256"
      AND "source_authority" IS NOT NULL
      AND "source_title" IS NOT NULL
      AND "source_checked_on" IS NOT NULL
      AND ("source_url" IS NOT NULL OR "source_reference" IS NOT NULL)
    )
  );
-- PUBLISHED or RETIRED is impossible without VERIFIED.
ALTER TABLE "compliance_rule_version" ADD CONSTRAINT "compliance_rule_version_status_consistent"
  CHECK (
    (
      "status" = 'DRAFT'
      AND "published_at" IS NULL AND "published_by_identity_id" IS NULL
      AND "retired_at" IS NULL AND "retired_by_identity_id" IS NULL AND "retirement_reason" IS NULL
    ) OR (
      "status" = 'PUBLISHED'
      AND "verification_status" = 'VERIFIED'
      AND "published_at" IS NOT NULL AND "published_by_identity_id" IS NOT NULL
      AND "retired_at" IS NULL AND "retired_by_identity_id" IS NULL AND "retirement_reason" IS NULL
    ) OR (
      "status" = 'RETIRED'
      AND "verification_status" = 'VERIFIED'
      AND "published_at" IS NOT NULL AND "published_by_identity_id" IS NOT NULL
      AND "retired_at" IS NOT NULL AND "retired_by_identity_id" IS NOT NULL
      AND "retirement_reason" IS NOT NULL
    )
  );
ALTER TABLE "compliance_rule_version" ADD CONSTRAINT "compliance_rule_version_timeline"
  CHECK (
    ("verified_at" IS NULL OR "verified_at" >= "created_at")
    AND ("published_at" IS NULL OR "published_at" >= "verified_at")
    AND ("retired_at" IS NULL OR "retired_at" >= "published_at")
  );

-- At most one editable draft per rule (raw SQL partial index, see ADR-027).
CREATE UNIQUE INDEX "compliance_rule_version_one_draft_per_rule"
  ON "compliance_rule_version"("rule_id") WHERE "status" = 'DRAFT';

ALTER TABLE "compliance_evaluation" ADD CONSTRAINT "compliance_evaluation_reference_format"
  CHECK ("reference" ~ '^ETCE-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$');
ALTER TABLE "compliance_evaluation" ADD CONSTRAINT "compliance_evaluation_engine_version_format"
  CHECK ("engine_version" ~ '^compliance-engine/[1-9][0-9]*$');
ALTER TABLE "compliance_evaluation" ADD CONSTRAINT "compliance_evaluation_fingerprint_format"
  CHECK ("facts_fingerprint" ~ '^[0-9a-f]{64}$' AND "rules_fingerprint" ~ '^[0-9a-f]{64}$');
ALTER TABLE "compliance_evaluation" ADD CONSTRAINT "compliance_evaluation_dates_ordered"
  CHECK ("arrival_date" >= "travel_date");
ALTER TABLE "compliance_evaluation" ADD CONSTRAINT "compliance_evaluation_snapshot_shape"
  CHECK (
    jsonb_typeof("facts") = 'object' AND octet_length("facts"::text) <= 8192
    AND jsonb_typeof("findings") = 'array'
  );

ALTER TABLE "compliance_evaluation_result" ADD CONSTRAINT "compliance_evaluation_result_reason_format"
  CHECK ("reason_code" ~ '^[A-Z][A-Z0-9_]{1,63}$' AND jsonb_typeof("details") = 'array');

ALTER TABLE "compliance_review" ADD CONSTRAINT "compliance_review_reason_required"
  CHECK (length(btrim("reason")) BETWEEN 10 AND 1000 AND "reason" !~ '[<>]');
ALTER TABLE "compliance_review" ADD CONSTRAINT "compliance_review_customer_message_plain"
  CHECK (
    "customer_message" IS NULL OR (length(btrim("customer_message")) > 0
      AND "customer_message" = btrim("customer_message") AND "customer_message" !~ '[<>[:cntrl:]]')
  );
-- Linear review history: one first review per evaluation, and each review
-- superseded at most once (unique supersedes_review_id above).
CREATE UNIQUE INDEX "compliance_review_one_first_per_evaluation"
  ON "compliance_review"("evaluation_id") WHERE "supersedes_review_id" IS NULL;

-- Rule identity is immutable and never deleted.
CREATE FUNCTION "compliance_rule_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'compliance rules are historical and cannot be deleted'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."reference" IS DISTINCT FROM OLD."reference"
     OR NEW."title" IS DISTINCT FROM OLD."title"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'compliance rule identity is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "compliance_rule_guard"
  BEFORE UPDATE OR DELETE ON "compliance_rule"
  FOR EACH ROW EXECUTE FUNCTION "compliance_rule_guard"();

-- Version lifecycle: DRAFT (editable; any content change drops the
-- verification) -> PUBLISHED (immutable) -> RETIRED (immutable). A draft is
-- published only verified and unchanged; nothing is ever deleted.
CREATE FUNCTION "compliance_rule_version_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  content_changed BOOLEAN;
  verification_changed BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'compliance rule versions are historical and cannot be deleted'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."verification_status" <> 'UNVERIFIED' THEN
      RAISE EXCEPTION 'compliance rule versions must be created as unverified drafts'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."rule_id" IS DISTINCT FROM OLD."rule_id"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'compliance rule version identity is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  content_changed := (
    NEW."language_version", NEW."definition", NEW."definition_sha256", NEW."customer_guidance",
    NEW."effective_from", NEW."effective_to", NEW."source_authority", NEW."source_title",
    NEW."source_url", NEW."source_reference"
  ) IS DISTINCT FROM (
    OLD."language_version", OLD."definition", OLD."definition_sha256", OLD."customer_guidance",
    OLD."effective_from", OLD."effective_to", OLD."source_authority", OLD."source_title",
    OLD."source_url", OLD."source_reference"
  );
  verification_changed := (
    NEW."verification_status", NEW."verified_at", NEW."verified_by_identity_id",
    NEW."verified_definition_sha256", NEW."verification_note", NEW."source_checked_on"
  ) IS DISTINCT FROM (
    OLD."verification_status", OLD."verified_at", OLD."verified_by_identity_id",
    OLD."verified_definition_sha256", OLD."verification_note", OLD."source_checked_on"
  );

  IF OLD."status" = 'RETIRED' THEN
    RAISE EXCEPTION 'retired compliance rule versions are immutable'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF OLD."status" = 'PUBLISHED' THEN
    IF NEW."status" <> 'RETIRED' OR content_changed OR verification_changed
       OR NEW."published_at" IS DISTINCT FROM OLD."published_at"
       OR NEW."published_by_identity_id" IS DISTINCT FROM OLD."published_by_identity_id" THEN
      RAISE EXCEPTION 'published compliance rule versions are immutable; create a new version'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN NEW;
  END IF;

  -- OLD is a DRAFT.
  IF NEW."status" = 'RETIRED' THEN
    RAISE EXCEPTION 'a draft compliance rule version cannot be retired'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW."status" = 'PUBLISHED'
     AND (OLD."verification_status" <> 'VERIFIED' OR content_changed OR verification_changed) THEN
    RAISE EXCEPTION 'only an unchanged verified draft can be published'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF content_changed AND NEW."verification_status" <> 'UNVERIFIED' THEN
    RAISE EXCEPTION 'a changed draft must be verified again'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."verification_status" = 'VERIFIED' AND OLD."verification_status" = 'UNVERIFIED'
     AND NEW."source_checked_on" > CURRENT_DATE THEN
    RAISE EXCEPTION 'a source cannot be checked in the future'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "compliance_rule_version_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "compliance_rule_version"
  FOR EACH ROW EXECUTE FUNCTION "compliance_rule_version_guard"();

-- Evaluations, their results and evidence are append-only history.
CREATE FUNCTION "compliance_history_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'compliance history is append-only (%)', TG_TABLE_NAME
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;

CREATE TRIGGER "compliance_evaluation_append_only"
  BEFORE UPDATE OR DELETE ON "compliance_evaluation"
  FOR EACH ROW EXECUTE FUNCTION "compliance_history_append_only"();

-- A result may only apply a version that is PUBLISHED right now. The share
-- lock makes a concurrent retirement wait for this evaluation to commit.
CREATE FUNCTION "compliance_evaluation_result_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  version_status "compliance_rule_version_status";
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'compliance history is append-only (%)', TG_TABLE_NAME
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT "status" INTO version_status
  FROM "compliance_rule_version" WHERE "id" = NEW."rule_version_id" FOR SHARE;
  IF FOUND AND version_status <> 'PUBLISHED' THEN
    RAISE EXCEPTION 'only published compliance rule versions can be applied'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "compliance_evaluation_result_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "compliance_evaluation_result"
  FOR EACH ROW EXECUTE FUNCTION "compliance_evaluation_result_guard"();

-- Evidence: a technically ACCEPTED document of the evaluated passenger.
-- Technical acceptance remains distinct from regulatory sufficiency.
CREATE FUNCTION "compliance_evaluation_evidence_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  evaluated_passenger UUID;
  document_passenger UUID;
  document_status "passenger_document_status";
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'compliance history is append-only (%)', TG_TABLE_NAME
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT e."passenger_id" INTO evaluated_passenger
  FROM "compliance_evaluation_result" r
  JOIN "compliance_evaluation" e ON e."id" = r."evaluation_id"
  WHERE r."id" = NEW."evaluation_result_id";
  SELECT "passenger_id", "status" INTO document_passenger, document_status
  FROM "passenger_document" WHERE "id" = NEW."passenger_document_id";
  IF document_passenger IS DISTINCT FROM evaluated_passenger
     OR document_status IS DISTINCT FROM 'ACCEPTED' THEN
    RAISE EXCEPTION 'evidence must be a technically accepted document of the evaluated passenger'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "compliance_evaluation_evidence_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "compliance_evaluation_evidence"
  FOR EACH ROW EXECUTE FUNCTION "compliance_evaluation_evidence_guard"();

-- Reviews: append-only, by an ACTIVE STAFF identity, on the latest
-- evaluation of the booking passenger, superseding only a review of the same
-- evaluation. Whether that evaluation is still current (fingerprints) is
-- decided by the API under a row lock.
CREATE FUNCTION "compliance_review_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  reviewer_realm "auth_realm";
  reviewer_status "auth_identity_status";
  evaluation_row RECORD;
  superseded_evaluation UUID;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'compliance reviews are append-only'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT "realm", "status" INTO reviewer_realm, reviewer_status
  FROM "auth_identity" WHERE "id" = NEW."reviewer_identity_id";
  IF FOUND AND (reviewer_realm <> 'STAFF' OR reviewer_status <> 'ACTIVE') THEN
    RAISE EXCEPTION 'a compliance review is made by an ACTIVE STAFF identity'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "id", "booking_id", "passenger_id", "evaluated_at" INTO evaluation_row
  FROM "compliance_evaluation" WHERE "id" = NEW."evaluation_id";
  IF FOUND AND EXISTS (
    SELECT 1 FROM "compliance_evaluation" newer
    WHERE newer."booking_id" = evaluation_row."booking_id"
      AND newer."passenger_id" = evaluation_row."passenger_id"
      AND (newer."evaluated_at", newer."id") > (evaluation_row."evaluated_at", evaluation_row."id")
  ) THEN
    RAISE EXCEPTION 'only the latest evaluation of a booking passenger can be reviewed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."supersedes_review_id" IS NOT NULL THEN
    SELECT "evaluation_id" INTO superseded_evaluation
    FROM "compliance_review" WHERE "id" = NEW."supersedes_review_id";
    IF superseded_evaluation IS DISTINCT FROM NEW."evaluation_id" THEN
      RAISE EXCEPTION 'a review can only supersede a review of the same evaluation'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "compliance_review_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "compliance_review"
  FOR EACH ROW EXECUTE FUNCTION "compliance_review_guard"();

-- Row-level guards do not fire for TRUNCATE.
CREATE FUNCTION "compliance_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'compliance history cannot be truncated (%)', TG_TABLE_NAME
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;

CREATE TRIGGER "compliance_rule_no_truncate"
  BEFORE TRUNCATE ON "compliance_rule"
  FOR EACH STATEMENT EXECUTE FUNCTION "compliance_no_truncate"();
CREATE TRIGGER "compliance_rule_version_no_truncate"
  BEFORE TRUNCATE ON "compliance_rule_version"
  FOR EACH STATEMENT EXECUTE FUNCTION "compliance_no_truncate"();
CREATE TRIGGER "compliance_evaluation_no_truncate"
  BEFORE TRUNCATE ON "compliance_evaluation"
  FOR EACH STATEMENT EXECUTE FUNCTION "compliance_no_truncate"();
CREATE TRIGGER "compliance_evaluation_result_no_truncate"
  BEFORE TRUNCATE ON "compliance_evaluation_result"
  FOR EACH STATEMENT EXECUTE FUNCTION "compliance_no_truncate"();
CREATE TRIGGER "compliance_evaluation_evidence_no_truncate"
  BEFORE TRUNCATE ON "compliance_evaluation_evidence"
  FOR EACH STATEMENT EXECUTE FUNCTION "compliance_no_truncate"();
CREATE TRIGGER "compliance_review_no_truncate"
  BEFORE TRUNCATE ON "compliance_review"
  FOR EACH STATEMENT EXECUTE FUNCTION "compliance_no_truncate"();

-- Permissions: read != review != rule management (create/verify/publish/retire).
INSERT INTO "authorization_permission" ("key", "description") VALUES
  ('compliance.read', 'Read passenger compliance evaluations, findings and reviews'),
  ('compliance.review', 'Evaluate booking passengers and record a reasoned human compliance review'),
  ('compliance.rule.read', 'Read regulatory rules, versions and their provenance'),
  ('compliance.rule.manage', 'Draft, verify, publish and retire regulatory rule versions');

INSERT INTO "authorization_role_permission" ("role_key", "permission_key") VALUES
  ('SUPER_ADMIN', 'compliance.read'),
  ('SUPER_ADMIN', 'compliance.review'),
  ('SUPER_ADMIN', 'compliance.rule.read'),
  ('SUPER_ADMIN', 'compliance.rule.manage'),
  ('DIRECTOR', 'compliance.read'),
  ('DIRECTOR', 'compliance.review'),
  ('DIRECTOR', 'compliance.rule.read'),
  ('DIRECTOR', 'compliance.rule.manage'),
  ('COMPLIANCE_AGENT', 'compliance.read'),
  ('COMPLIANCE_AGENT', 'compliance.review'),
  ('COMPLIANCE_AGENT', 'compliance.rule.read'),
  ('OPS_MANAGER', 'compliance.read'),
  ('AUDITOR', 'compliance.rule.read');
