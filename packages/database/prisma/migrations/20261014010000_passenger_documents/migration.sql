-- PR-11 Passenger Documents: the person travelling remains distinct from the
-- authenticated CUSTOMER/booker; private object bytes never enter PostgreSQL.

-- CreateEnum
CREATE TYPE "passenger_document_type" AS ENUM (
  'PASSPORT',
  'NATIONAL_ID',
  'RESIDENCE_PERMIT',
  'VISA',
  'PARENTAL_AUTHORIZATION',
  'OTHER'
);

-- Technical file-security state only. ACCEPTED is not regulatory validity.
CREATE TYPE "passenger_document_status" AS ENUM ('QUARANTINED', 'ACCEPTED', 'REJECTED');

-- CreateTable
CREATE TABLE "passenger" (
  "id" UUID NOT NULL,
  "reference" VARCHAR(16) NOT NULL,
  "owner_customer_identity_id" UUID NOT NULL,
  "given_name" VARCHAR(100) NOT NULL,
  "family_name" VARCHAR(100) NOT NULL,
  "date_of_birth" DATE NOT NULL,
  "nationality_country_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "passenger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_passenger" (
  "booking_id" UUID NOT NULL,
  "passenger_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "booking_passenger_pkey" PRIMARY KEY ("booking_id", "passenger_id")
);

-- CreateTable
CREATE TABLE "passenger_document" (
  "id" UUID NOT NULL,
  "reference" VARCHAR(16) NOT NULL,
  "passenger_id" UUID NOT NULL,
  "type" "passenger_document_type" NOT NULL,
  "object_key" VARCHAR(128) NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "mime_type" VARCHAR(64) NOT NULL,
  "size_bytes" BIGINT NOT NULL,
  "status" "passenger_document_status" NOT NULL DEFAULT 'QUARANTINED',
  "failure_code" VARCHAR(48),
  "expires_at" DATE,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  "accepted_at" TIMESTAMPTZ(3),
  "rejected_at" TIMESTAMPTZ(3),

  CONSTRAINT "passenger_document_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "passenger_reference_key" ON "passenger"("reference");
CREATE INDEX "passenger_owner_customer_identity_id_id_idx"
  ON "passenger"("owner_customer_identity_id", "id");
CREATE INDEX "passenger_nationality_country_id_idx" ON "passenger"("nationality_country_id");

CREATE INDEX "booking_passenger_passenger_id_booking_id_idx"
  ON "booking_passenger"("passenger_id", "booking_id");

CREATE UNIQUE INDEX "passenger_document_reference_key" ON "passenger_document"("reference");
CREATE UNIQUE INDEX "passenger_document_object_key_key" ON "passenger_document"("object_key");
CREATE INDEX "passenger_document_passenger_id_id_idx"
  ON "passenger_document"("passenger_id", "id");
CREATE INDEX "passenger_document_status_id_idx" ON "passenger_document"("status", "id");
CREATE INDEX "passenger_document_type_id_idx" ON "passenger_document"("type", "id");
CREATE INDEX "passenger_document_created_at_id_idx"
  ON "passenger_document"("created_at", "id");

-- AddForeignKey
ALTER TABLE "passenger" ADD CONSTRAINT "passenger_owner_customer_identity_id_fkey"
  FOREIGN KEY ("owner_customer_identity_id") REFERENCES "auth_identity"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "passenger" ADD CONSTRAINT "passenger_nationality_country_id_fkey"
  FOREIGN KEY ("nationality_country_id") REFERENCES "country"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "booking_passenger" ADD CONSTRAINT "booking_passenger_booking_id_fkey"
  FOREIGN KEY ("booking_id") REFERENCES "booking"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "booking_passenger" ADD CONSTRAINT "booking_passenger_passenger_id_fkey"
  FOREIGN KEY ("passenger_id") REFERENCES "passenger"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "passenger_document" ADD CONSTRAINT "passenger_document_passenger_id_fkey"
  FOREIGN KEY ("passenger_id") REFERENCES "passenger"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Stable, non-sequential public identifiers (60 bits of CSPRNG entropy).
ALTER TABLE "passenger" ADD CONSTRAINT "passenger_reference_format"
  CHECK ("reference" ~ '^ETV-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$');
ALTER TABLE "passenger_document" ADD CONSTRAINT "passenger_document_reference_format"
  CHECK ("reference" ~ '^ETD-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$');

-- Minimal identity data. Names are normalized before storage and the date is
-- checked again by the trigger against the database clock.
ALTER TABLE "passenger" ADD CONSTRAINT "passenger_names_normalized"
  CHECK (
    length("given_name") BETWEEN 1 AND 100
    AND length("family_name") BETWEEN 1 AND 100
    AND "given_name" = btrim("given_name")
    AND "family_name" = btrim("family_name")
  );

-- No original name or path enters the object key. The server emits 256 random
-- bits and uses the first byte only as a flat-prefix shard.
ALTER TABLE "passenger_document" ADD CONSTRAINT "passenger_document_object_key_format"
  CHECK ("object_key" ~ '^passenger-documents/[0-9a-f]{2}/[0-9a-f]{64}$');
ALTER TABLE "passenger_document" ADD CONSTRAINT "passenger_document_sha256_format"
  CHECK ("sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "passenger_document" ADD CONSTRAINT "passenger_document_size_positive"
  CHECK ("size_bytes" > 0);
ALTER TABLE "passenger_document" ADD CONSTRAINT "passenger_document_mime_supported"
  CHECK ("mime_type" IN ('application/pdf', 'image/jpeg', 'image/png'));
ALTER TABLE "passenger_document" ADD CONSTRAINT "passenger_document_failure_code_known"
  CHECK (
    "failure_code" IS NULL OR "failure_code" IN (
      'MALWARE_DETECTED',
      'SCANNER_TIMEOUT',
      'SCANNER_UNAVAILABLE',
      'SCANNER_ERROR',
      'STORAGE_INTEGRITY_ERROR'
    )
  );
ALTER TABLE "passenger_document" ADD CONSTRAINT "passenger_document_status_consistent"
  CHECK (
    (
      "status" = 'QUARANTINED'
      AND "accepted_at" IS NULL
      AND "rejected_at" IS NULL
      AND "failure_code" IS NULL
    ) OR (
      "status" = 'ACCEPTED'
      AND "accepted_at" IS NOT NULL
      AND "rejected_at" IS NULL
      AND "failure_code" IS NULL
    ) OR (
      "status" = 'REJECTED'
      AND "accepted_at" IS NULL
      AND "rejected_at" IS NOT NULL
      AND "failure_code" IS NOT NULL
    )
  );
ALTER TABLE "passenger_document" ADD CONSTRAINT "passenger_document_transition_after_creation"
  CHECK (
    ("accepted_at" IS NULL OR "accepted_at" >= "created_at")
    AND ("rejected_at" IS NULL OR "rejected_at" >= "created_at")
  );

-- A Passenger is always owned by an ACTIVE CUSTOMER at creation time. The
-- account and person remain different records; ownership is immutable.
CREATE FUNCTION "passenger_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner_realm "auth_realm";
  owner_status "auth_identity_status";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'passengers are historical and cannot be deleted'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."reference" IS DISTINCT FROM OLD."reference"
       OR NEW."owner_customer_identity_id" IS DISTINCT FROM OLD."owner_customer_identity_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
      RAISE EXCEPTION 'passenger identity, reference and owner are immutable'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."date_of_birth" > CURRENT_DATE THEN
    RAISE EXCEPTION 'passenger date of birth cannot be in the future'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT "realm", "status" INTO owner_realm, owner_status
    FROM "auth_identity" WHERE "id" = NEW."owner_customer_identity_id" FOR SHARE;
    IF FOUND AND (owner_realm <> 'CUSTOMER' OR owner_status <> 'ACTIVE') THEN
      RAISE EXCEPTION 'a passenger belongs to an ACTIVE CUSTOMER identity'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "passenger_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "passenger"
  FOR EACH ROW EXECUTE FUNCTION "passenger_guard"();

-- BookingPassenger insertions serialize on the parent booking. This makes the
-- count authoritative under concurrency: two requests for the final slot
-- cannot both pass. Historical PR-09/PR-10 bookings with zero rows stay valid.
CREATE FUNCTION "booking_passenger_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  booking_row RECORD;
  passenger_owner UUID;
  seat_count BIGINT;
  passenger_count BIGINT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'booking passengers are historical and cannot be changed or deleted'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT "customer_identity_id", "confirmed_at", "cancelled_at"
    INTO booking_row
  FROM "booking" WHERE "id" = NEW."booking_id" FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports the missing booking
  END IF;
  IF booking_row."confirmed_at" IS NULL OR booking_row."cancelled_at" IS NOT NULL THEN
    RAISE EXCEPTION 'passengers can only be attached to a confirmed booking'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT "owner_customer_identity_id" INTO passenger_owner
  FROM "passenger" WHERE "id" = NEW."passenger_id";
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports the missing passenger
  END IF;
  IF passenger_owner <> booking_row."customer_identity_id" THEN
    RAISE EXCEPTION 'the passenger and booking must have the same CUSTOMER owner'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO seat_count FROM "booking_seat"
  WHERE "booking_id" = NEW."booking_id";
  SELECT count(*) INTO passenger_count FROM "booking_passenger"
  WHERE "booking_id" = NEW."booking_id";
  IF passenger_count >= seat_count THEN
    RAISE EXCEPTION 'a booking cannot have more passengers than seats'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "booking_passenger_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "booking_passenger"
  FOR EACH ROW EXECUTE FUNCTION "booking_passenger_guard"();

-- Document identity and file metadata are immutable. A file starts in logical
-- quarantine and can make exactly one fail-closed transition.
CREATE FUNCTION "passenger_document_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'passenger document metadata is historical and cannot be deleted'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'QUARANTINED' THEN
      RAISE EXCEPTION 'passenger documents must be created quarantined'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."reference" IS DISTINCT FROM OLD."reference"
     OR NEW."passenger_id" IS DISTINCT FROM OLD."passenger_id"
     OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."object_key" IS DISTINCT FROM OLD."object_key"
     OR NEW."sha256" IS DISTINCT FROM OLD."sha256"
     OR NEW."mime_type" IS DISTINCT FROM OLD."mime_type"
     OR NEW."size_bytes" IS DISTINCT FROM OLD."size_bytes"
     OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'passenger document identity and file metadata are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'QUARANTINED' OR NEW."status" NOT IN ('ACCEPTED', 'REJECTED') THEN
    RAISE EXCEPTION 'invalid passenger document status transition from % to %', OLD."status", NEW."status"
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "passenger_document_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "passenger_document"
  FOR EACH ROW EXECUTE FUNCTION "passenger_document_guard"();

-- Row-level guards do not fire for TRUNCATE.
CREATE FUNCTION "passenger_documents_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'passenger and document history cannot be truncated'
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;

CREATE TRIGGER "passenger_no_truncate"
  BEFORE TRUNCATE ON "passenger"
  FOR EACH STATEMENT EXECUTE FUNCTION "passenger_documents_no_truncate"();
CREATE TRIGGER "booking_passenger_no_truncate"
  BEFORE TRUNCATE ON "booking_passenger"
  FOR EACH STATEMENT EXECUTE FUNCTION "passenger_documents_no_truncate"();
CREATE TRIGGER "passenger_document_no_truncate"
  BEFORE TRUNCATE ON "passenger_document"
  FOR EACH STATEMENT EXECUTE FUNCTION "passenger_documents_no_truncate"();

-- Narrow STAFF read permission. There is deliberately no compliance approval
-- permission or mutation in PR-11.
INSERT INTO "authorization_permission" ("key", "description") VALUES
  ('passenger.document.read', 'Read passenger document metadata and accepted private files');

INSERT INTO "authorization_role_permission" ("role_key", "permission_key") VALUES
  ('SUPER_ADMIN', 'passenger.document.read'),
  ('DIRECTOR', 'passenger.document.read'),
  ('OPS_MANAGER', 'passenger.document.read'),
  ('COMPLIANCE_AGENT', 'passenger.document.read');
