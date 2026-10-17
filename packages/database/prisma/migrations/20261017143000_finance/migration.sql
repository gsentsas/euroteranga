-- PR-22 operational finance.
-- Exact minor-unit amounts only. No FX conversion, general ledger, FEC,
-- statutory accounting or real PSP integration is introduced here.

CREATE TYPE "finance_revenue_type" AS ENUM ('BAGGAGE', 'OPTION', 'OTHER');
CREATE TYPE "finance_expense_type" AS ENUM (
  'FUEL','FERRY','TOLL','CREW','HOTEL','MAINTENANCE','BORDER','INSURANCE','OTHER'
);
CREATE TYPE "finance_entry_status" AS ENUM ('ACTIVE','VOIDED');

CREATE TABLE "trip_revenue" (
  "id" uuid NOT NULL, "reference" varchar(17) NOT NULL, "trip_id" uuid NOT NULL,
  "baggage_id" uuid, "type" "finance_revenue_type" NOT NULL,
  "status" "finance_entry_status" NOT NULL DEFAULT 'ACTIVE',
  "amount_minor" bigint NOT NULL, "currency_code" varchar(3) NOT NULL,
  "currency_minor_unit" integer NOT NULL, "description" varchar(500) NOT NULL,
  "occurred_at" timestamptz(3) NOT NULL, "created_by_identity_id" uuid NOT NULL,
  "created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "voided_by_identity_id" uuid, "voided_at" timestamptz(3), "void_reason" varchar(500),
  CONSTRAINT "trip_revenue_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "trip_revenue_reference_key" UNIQUE ("reference"),
  CONSTRAINT "trip_revenue_reference_format" CHECK ("reference" ~ '^ETFR-[0-9A-HJKMNP-TV-Z]{12}$'),
  CONSTRAINT "trip_revenue_amount_positive" CHECK ("amount_minor" > 0),
  CONSTRAINT "trip_revenue_currency_shape" CHECK ("currency_code" ~ '^[A-Z]{3}$' AND "currency_minor_unit" BETWEEN 0 AND 3),
  CONSTRAINT "trip_revenue_description_shape" CHECK (length("description") BETWEEN 3 AND 500 AND "description"=btrim("description")),
  CONSTRAINT "trip_revenue_baggage_shape" CHECK (("type"='BAGGAGE' AND "baggage_id" IS NOT NULL) OR ("type"<>'BAGGAGE' AND "baggage_id" IS NULL)),
  CONSTRAINT "trip_revenue_void_shape" CHECK (
    ("status"='ACTIVE' AND "voided_by_identity_id" IS NULL AND "voided_at" IS NULL AND "void_reason" IS NULL)
    OR ("status"='VOIDED' AND "voided_by_identity_id" IS NOT NULL AND "voided_at" IS NOT NULL
      AND "void_reason" IS NOT NULL AND length("void_reason") BETWEEN 3 AND 500 AND "void_reason"=btrim("void_reason"))
  )
);

CREATE TABLE "trip_expense" (
  "id" uuid NOT NULL, "reference" varchar(17) NOT NULL, "trip_id" uuid NOT NULL,
  "type" "finance_expense_type" NOT NULL, "status" "finance_entry_status" NOT NULL DEFAULT 'ACTIVE',
  "amount_minor" bigint NOT NULL, "currency_code" varchar(3) NOT NULL,
  "currency_minor_unit" integer NOT NULL, "description" varchar(500) NOT NULL,
  "vendor_label" varchar(160), "occurred_at" timestamptz(3) NOT NULL,
  "created_by_identity_id" uuid NOT NULL, "created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "voided_by_identity_id" uuid, "voided_at" timestamptz(3), "void_reason" varchar(500),
  CONSTRAINT "trip_expense_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "trip_expense_reference_key" UNIQUE ("reference"),
  CONSTRAINT "trip_expense_reference_format" CHECK ("reference" ~ '^ETFE-[0-9A-HJKMNP-TV-Z]{12}$'),
  CONSTRAINT "trip_expense_amount_positive" CHECK ("amount_minor" > 0),
  CONSTRAINT "trip_expense_currency_shape" CHECK ("currency_code" ~ '^[A-Z]{3}$' AND "currency_minor_unit" BETWEEN 0 AND 3),
  CONSTRAINT "trip_expense_description_shape" CHECK (length("description") BETWEEN 3 AND 500 AND "description"=btrim("description")),
  CONSTRAINT "trip_expense_vendor_shape" CHECK ("vendor_label" IS NULL OR (length("vendor_label") BETWEEN 1 AND 160 AND "vendor_label"=btrim("vendor_label"))),
  CONSTRAINT "trip_expense_void_shape" CHECK (
    ("status"='ACTIVE' AND "voided_by_identity_id" IS NULL AND "voided_at" IS NULL AND "void_reason" IS NULL)
    OR ("status"='VOIDED' AND "voided_by_identity_id" IS NOT NULL AND "voided_at" IS NOT NULL
      AND "void_reason" IS NOT NULL AND length("void_reason") BETWEEN 3 AND 500 AND "void_reason"=btrim("void_reason"))
  )
);

CREATE TABLE "refund" (
  "id" uuid NOT NULL, "reference" varchar(17) NOT NULL, "payment_id" uuid NOT NULL,
  "client_refund_id" varchar(64) NOT NULL, "amount_minor" bigint NOT NULL,
  "currency_code" varchar(3) NOT NULL, "currency_minor_unit" integer NOT NULL,
  "reason" varchar(500) NOT NULL, "recorded_by_identity_id" uuid NOT NULL,
  "recorded_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "refund_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "refund_reference_key" UNIQUE ("reference"),
  CONSTRAINT "refund_payment_id_client_refund_id_key" UNIQUE ("payment_id","client_refund_id"),
  CONSTRAINT "refund_reference_format" CHECK ("reference" ~ '^ETRF-[0-9A-HJKMNP-TV-Z]{12}$'),
  CONSTRAINT "refund_client_id_format" CHECK ("client_refund_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$'),
  CONSTRAINT "refund_amount_positive" CHECK ("amount_minor">0),
  CONSTRAINT "refund_currency_shape" CHECK ("currency_code" ~ '^[A-Z]{3}$' AND "currency_minor_unit" BETWEEN 0 AND 3),
  CONSTRAINT "refund_reason_shape" CHECK (length("reason") BETWEEN 3 AND 500 AND "reason"=btrim("reason"))
);

CREATE TABLE "credit_note" (
  "id" uuid NOT NULL, "reference" varchar(17) NOT NULL, "refund_id" uuid NOT NULL,
  "amount_minor" bigint NOT NULL, "currency_code" varchar(3) NOT NULL,
  "currency_minor_unit" integer NOT NULL, "issued_by_identity_id" uuid NOT NULL,
  "issued_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "credit_note_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "credit_note_reference_key" UNIQUE ("reference"),
  CONSTRAINT "credit_note_refund_id_key" UNIQUE ("refund_id"),
  CONSTRAINT "credit_note_reference_format" CHECK ("reference" ~ '^ETCN-[0-9A-HJKMNP-TV-Z]{12}$'),
  CONSTRAINT "credit_note_amount_positive" CHECK ("amount_minor">0),
  CONSTRAINT "credit_note_currency_shape" CHECK ("currency_code" ~ '^[A-Z]{3}$' AND "currency_minor_unit" BETWEEN 0 AND 3)
);

CREATE TABLE "payout" (
  "id" uuid NOT NULL, "reference" varchar(17) NOT NULL, "expense_id" uuid NOT NULL,
  "client_payout_id" varchar(64) NOT NULL, "amount_minor" bigint NOT NULL,
  "currency_code" varchar(3) NOT NULL, "currency_minor_unit" integer NOT NULL,
  "note" varchar(500), "recorded_by_identity_id" uuid NOT NULL,
  "paid_at" timestamptz(3) NOT NULL, "recorded_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payout_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payout_reference_key" UNIQUE ("reference"),
  CONSTRAINT "payout_expense_id_client_payout_id_key" UNIQUE ("expense_id","client_payout_id"),
  CONSTRAINT "payout_reference_format" CHECK ("reference" ~ '^ETPO-[0-9A-HJKMNP-TV-Z]{12}$'),
  CONSTRAINT "payout_client_id_format" CHECK ("client_payout_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$'),
  CONSTRAINT "payout_amount_positive" CHECK ("amount_minor">0),
  CONSTRAINT "payout_currency_shape" CHECK ("currency_code" ~ '^[A-Z]{3}$' AND "currency_minor_unit" BETWEEN 0 AND 3),
  CONSTRAINT "payout_note_shape" CHECK ("note" IS NULL OR (length("note") BETWEEN 3 AND 500 AND "note"=btrim("note")))
);

CREATE TABLE "finance_receipt" (
  "id" uuid NOT NULL, "reference" varchar(17) NOT NULL, "expense_id" uuid NOT NULL,
  "object_key" varchar(96) NOT NULL, "sha256" char(64) NOT NULL,
  "mime_type" varchar(64) NOT NULL, "size_bytes" integer NOT NULL,
  "uploaded_by_identity_id" uuid NOT NULL, "created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "finance_receipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "finance_receipt_reference_key" UNIQUE ("reference"),
  CONSTRAINT "finance_receipt_object_key_key" UNIQUE ("object_key"),
  CONSTRAINT "finance_receipt_reference_format" CHECK ("reference" ~ '^ETRC-[0-9A-HJKMNP-TV-Z]{12}$'),
  CONSTRAINT "finance_receipt_object_key_format" CHECK ("object_key" ~ '^finance-receipts/[0-9a-f]{2}/[0-9a-f]{64}$'),
  CONSTRAINT "finance_receipt_sha256_format" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "finance_receipt_mime_supported" CHECK ("mime_type" IN ('application/pdf','image/jpeg','image/png')),
  CONSTRAINT "finance_receipt_size_positive" CHECK ("size_bytes">0)
);

CREATE INDEX "trip_revenue_trip_id_status_occurred_at_id_idx" ON "trip_revenue"("trip_id","status","occurred_at","id");
CREATE INDEX "trip_revenue_baggage_id_idx" ON "trip_revenue"("baggage_id");
CREATE INDEX "trip_revenue_created_by_identity_id_created_at_idx" ON "trip_revenue"("created_by_identity_id","created_at");
CREATE INDEX "trip_expense_trip_id_status_occurred_at_id_idx" ON "trip_expense"("trip_id","status","occurred_at","id");
CREATE INDEX "trip_expense_created_by_identity_id_created_at_idx" ON "trip_expense"("created_by_identity_id","created_at");
CREATE INDEX "refund_payment_id_recorded_at_id_idx" ON "refund"("payment_id","recorded_at","id");
CREATE INDEX "refund_recorded_by_identity_id_recorded_at_idx" ON "refund"("recorded_by_identity_id","recorded_at");
CREATE INDEX "credit_note_issued_by_identity_id_issued_at_idx" ON "credit_note"("issued_by_identity_id","issued_at");
CREATE INDEX "payout_expense_id_paid_at_id_idx" ON "payout"("expense_id","paid_at","id");
CREATE INDEX "payout_recorded_by_identity_id_recorded_at_idx" ON "payout"("recorded_by_identity_id","recorded_at");
CREATE INDEX "finance_receipt_expense_id_created_at_id_idx" ON "finance_receipt"("expense_id","created_at","id");
CREATE INDEX "finance_receipt_uploaded_by_identity_id_created_at_idx" ON "finance_receipt"("uploaded_by_identity_id","created_at");

ALTER TABLE "trip_revenue" ADD CONSTRAINT "trip_revenue_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "trip_revenue" ADD CONSTRAINT "trip_revenue_baggage_id_fkey" FOREIGN KEY ("baggage_id") REFERENCES "baggage"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "trip_revenue" ADD CONSTRAINT "trip_revenue_created_by_identity_id_fkey" FOREIGN KEY ("created_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "trip_revenue" ADD CONSTRAINT "trip_revenue_voided_by_identity_id_fkey" FOREIGN KEY ("voided_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "trip_expense" ADD CONSTRAINT "trip_expense_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "trip_expense" ADD CONSTRAINT "trip_expense_created_by_identity_id_fkey" FOREIGN KEY ("created_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "trip_expense" ADD CONSTRAINT "trip_expense_voided_by_identity_id_fkey" FOREIGN KEY ("voided_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "refund" ADD CONSTRAINT "refund_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "refund" ADD CONSTRAINT "refund_recorded_by_identity_id_fkey" FOREIGN KEY ("recorded_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refund"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_issued_by_identity_id_fkey" FOREIGN KEY ("issued_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "payout" ADD CONSTRAINT "payout_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "trip_expense"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "payout" ADD CONSTRAINT "payout_recorded_by_identity_id_fkey" FOREIGN KEY ("recorded_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_receipt" ADD CONSTRAINT "finance_receipt_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "trip_expense"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_receipt" ADD CONSTRAINT "finance_receipt_uploaded_by_identity_id_fkey" FOREIGN KEY ("uploaded_by_identity_id") REFERENCES "auth_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "finance_assert_active_staff"(identity uuid,label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r "auth_realm"; s "auth_identity_status";
BEGIN
  SELECT "realm","status" INTO r,s FROM "auth_identity" WHERE "id"=identity;
  IF r IS DISTINCT FROM 'STAFF' OR s IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'finance % must be active STAFF',label USING ERRCODE='23514';
  END IF;
END;
$$;

-- PR-22 replaces the PR-10 shape constraint: confirmation stays historical,
-- but a later cancellation is now valid when the trigger proves full refund.
ALTER TABLE "booking" DROP CONSTRAINT "booking_confirmation_consistent";
ALTER TABLE "booking" ADD CONSTRAINT "booking_confirmation_consistent"
  CHECK (
    "confirmed_at" IS NULL
    OR (
      "confirmed_at" >= "created_at"
      AND "confirmed_at" < "hold_expires_at"
      AND ("cancelled_at" IS NULL OR "cancelled_at" >= "confirmed_at")
    )
  );

CREATE FUNCTION "finance_booking_fully_refunded"(booking uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE payment_amount bigint; refunded bigint;
BEGIN
  SELECT p."amount_minor",COALESCE(SUM(r."amount_minor"),0) INTO payment_amount,refunded
  FROM "payment" p LEFT JOIN "refund" r ON r."payment_id"=p."id"
  WHERE p."booking_id"=booking AND p."status"='SUCCEEDED'
  GROUP BY p."id",p."amount_minor";
  RETURN payment_amount IS NOT NULL AND refunded=payment_amount;
END;
$$;

CREATE FUNCTION "trip_revenue_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bag_trip uuid;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'trip revenue is historical and cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    PERFORM "finance_assert_active_staff"(NEW."created_by_identity_id",'revenue creator');
    NEW."created_at":=clock_timestamp();
    IF NEW."occurred_at">clock_timestamp()+interval '5 minutes' THEN RAISE EXCEPTION 'revenue occurred_at too far in the future' USING ERRCODE='23514'; END IF;
    IF NEW."type"='BAGGAGE' THEN
      SELECT b."trip_id" INTO bag_trip FROM "baggage" bg JOIN "booking" b ON b."id"=bg."booking_id" WHERE bg."id"=NEW."baggage_id";
      IF bag_trip IS DISTINCT FROM NEW."trip_id" THEN RAISE EXCEPTION 'baggage revenue must use a bag on the same trip' USING ERRCODE='23514'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."reference" IS DISTINCT FROM OLD."reference" OR NEW."trip_id" IS DISTINCT FROM OLD."trip_id"
    OR NEW."baggage_id" IS DISTINCT FROM OLD."baggage_id" OR NEW."type" IS DISTINCT FROM OLD."type"
    OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor" OR NEW."currency_code" IS DISTINCT FROM OLD."currency_code"
    OR NEW."currency_minor_unit" IS DISTINCT FROM OLD."currency_minor_unit" OR NEW."description" IS DISTINCT FROM OLD."description"
    OR NEW."occurred_at" IS DISTINCT FROM OLD."occurred_at" OR NEW."created_by_identity_id" IS DISTINCT FROM OLD."created_by_identity_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN RAISE EXCEPTION 'trip revenue facts are immutable' USING ERRCODE='23514'; END IF;
  IF OLD."status"='VOIDED' THEN RAISE EXCEPTION 'voided revenue is terminal' USING ERRCODE='23514'; END IF;
  IF NEW."status"<>'VOIDED' OR NEW."voided_by_identity_id" IS NULL OR NEW."void_reason" IS NULL THEN
    RAISE EXCEPTION 'revenue can only transition ACTIVE to VOIDED with reason' USING ERRCODE='23514';
  END IF;
  PERFORM "finance_assert_active_staff"(NEW."voided_by_identity_id",'revenue voider');
  NEW."voided_at":=clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION "trip_expense_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'trip expense is historical and cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    PERFORM "finance_assert_active_staff"(NEW."created_by_identity_id",'expense creator');
    NEW."created_at":=clock_timestamp();
    IF NEW."occurred_at">clock_timestamp()+interval '5 minutes' THEN RAISE EXCEPTION 'expense occurred_at too far in the future' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."reference" IS DISTINCT FROM OLD."reference" OR NEW."trip_id" IS DISTINCT FROM OLD."trip_id"
    OR NEW."type" IS DISTINCT FROM OLD."type" OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
    OR NEW."currency_code" IS DISTINCT FROM OLD."currency_code" OR NEW."currency_minor_unit" IS DISTINCT FROM OLD."currency_minor_unit"
    OR NEW."description" IS DISTINCT FROM OLD."description" OR NEW."vendor_label" IS DISTINCT FROM OLD."vendor_label"
    OR NEW."occurred_at" IS DISTINCT FROM OLD."occurred_at" OR NEW."created_by_identity_id" IS DISTINCT FROM OLD."created_by_identity_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN RAISE EXCEPTION 'trip expense facts are immutable' USING ERRCODE='23514'; END IF;
  IF OLD."status"='VOIDED' THEN RAISE EXCEPTION 'voided expense is terminal' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM "payout" WHERE "expense_id"=OLD."id") THEN RAISE EXCEPTION 'an expense with payouts cannot be voided' USING ERRCODE='23514'; END IF;
  IF NEW."status"<>'VOIDED' OR NEW."voided_by_identity_id" IS NULL OR NEW."void_reason" IS NULL THEN
    RAISE EXCEPTION 'expense can only transition ACTIVE to VOIDED with reason' USING ERRCODE='23514';
  END IF;
  PERFORM "finance_assert_active_staff"(NEW."voided_by_identity_id",'expense voider');
  NEW."voided_at":=clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION "refund_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p RECORD; already bigint;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'refunds are append-only' USING ERRCODE='23514'; END IF;
  SELECT "id","status","amount_minor","currency_code","currency_minor_unit" INTO p FROM "payment" WHERE "id"=NEW."payment_id" FOR UPDATE;
  IF NOT FOUND OR p."status"<>'SUCCEEDED' THEN RAISE EXCEPTION 'refund requires a SUCCEEDED payment' USING ERRCODE='23514'; END IF;
  IF NEW."currency_code"<>p."currency_code" OR NEW."currency_minor_unit"<>p."currency_minor_unit" THEN RAISE EXCEPTION 'refund currency must equal payment currency' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(SUM("amount_minor"),0) INTO already FROM "refund" WHERE "payment_id"=NEW."payment_id";
  IF already+NEW."amount_minor">p."amount_minor" THEN RAISE EXCEPTION 'refund total exceeds payment amount' USING ERRCODE='23514'; END IF;
  PERFORM "finance_assert_active_staff"(NEW."recorded_by_identity_id",'refund recorder');
  NEW."recorded_at":=clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION "credit_note_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'credit notes are append-only' USING ERRCODE='23514'; END IF;
  SELECT "amount_minor","currency_code","currency_minor_unit" INTO r FROM "refund" WHERE "id"=NEW."refund_id";
  IF NOT FOUND OR NEW."amount_minor"<>r."amount_minor" OR NEW."currency_code"<>r."currency_code" OR NEW."currency_minor_unit"<>r."currency_minor_unit" THEN
    RAISE EXCEPTION 'credit note must exactly match its refund' USING ERRCODE='23514';
  END IF;
  PERFORM "finance_assert_active_staff"(NEW."issued_by_identity_id",'credit note issuer');
  NEW."issued_at":=clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION "refund_credit_note_consistency"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM "credit_note" c
    WHERE c."refund_id"=NEW."id"
      AND c."amount_minor"=NEW."amount_minor"
      AND c."currency_code"=NEW."currency_code"
      AND c."currency_minor_unit"=NEW."currency_minor_unit"
  ) THEN
    RAISE EXCEPTION 'every refund requires one matching credit note' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION "payout_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e RECORD; already bigint;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'payouts are append-only' USING ERRCODE='23514'; END IF;
  SELECT "id","status","amount_minor","currency_code","currency_minor_unit" INTO e FROM "trip_expense" WHERE "id"=NEW."expense_id" FOR UPDATE;
  IF NOT FOUND OR e."status"<>'ACTIVE' THEN RAISE EXCEPTION 'payout requires an ACTIVE expense' USING ERRCODE='23514'; END IF;
  IF NEW."currency_code"<>e."currency_code" OR NEW."currency_minor_unit"<>e."currency_minor_unit" THEN RAISE EXCEPTION 'payout currency must equal expense currency' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(SUM("amount_minor"),0) INTO already FROM "payout" WHERE "expense_id"=NEW."expense_id";
  IF already+NEW."amount_minor">e."amount_minor" THEN RAISE EXCEPTION 'payout total exceeds expense amount' USING ERRCODE='23514'; END IF;
  IF NEW."paid_at">clock_timestamp()+interval '5 minutes' THEN RAISE EXCEPTION 'payout paid_at too far in the future' USING ERRCODE='23514'; END IF;
  PERFORM "finance_assert_active_staff"(NEW."recorded_by_identity_id",'payout recorder');
  NEW."recorded_at":=clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION "finance_receipt_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st "finance_entry_status";
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'finance receipts are immutable' USING ERRCODE='23514'; END IF;
  SELECT "status" INTO st FROM "trip_expense" WHERE "id"=NEW."expense_id" FOR SHARE;
  IF st IS DISTINCT FROM 'ACTIVE' THEN RAISE EXCEPTION 'receipt requires an ACTIVE expense' USING ERRCODE='23514'; END IF;
  PERFORM "finance_assert_active_staff"(NEW."uploaded_by_identity_id",'receipt uploader');
  NEW."created_at":=clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trip_revenue_guard" BEFORE INSERT OR UPDATE OR DELETE ON "trip_revenue" FOR EACH ROW EXECUTE FUNCTION "trip_revenue_guard"();
CREATE TRIGGER "trip_expense_guard" BEFORE INSERT OR UPDATE OR DELETE ON "trip_expense" FOR EACH ROW EXECUTE FUNCTION "trip_expense_guard"();
CREATE TRIGGER "refund_guard" BEFORE INSERT OR UPDATE OR DELETE ON "refund" FOR EACH ROW EXECUTE FUNCTION "refund_guard"();
CREATE TRIGGER "credit_note_guard" BEFORE INSERT OR UPDATE OR DELETE ON "credit_note" FOR EACH ROW EXECUTE FUNCTION "credit_note_guard"();
CREATE CONSTRAINT TRIGGER "refund_credit_note_consistency_refund" AFTER INSERT ON "refund" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "refund_credit_note_consistency"();
CREATE TRIGGER "payout_guard" BEFORE INSERT OR UPDATE OR DELETE ON "payout" FOR EACH ROW EXECUTE FUNCTION "payout_guard"();
CREATE TRIGGER "finance_receipt_guard" BEFORE INSERT OR UPDATE OR DELETE ON "finance_receipt" FOR EACH ROW EXECUTE FUNCTION "finance_receipt_guard"();

CREATE FUNCTION "finance_no_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'finance history cannot be truncated' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER "trip_revenue_no_truncate" BEFORE TRUNCATE ON "trip_revenue" FOR EACH STATEMENT EXECUTE FUNCTION "finance_no_truncate"();
CREATE TRIGGER "trip_expense_no_truncate" BEFORE TRUNCATE ON "trip_expense" FOR EACH STATEMENT EXECUTE FUNCTION "finance_no_truncate"();
CREATE TRIGGER "refund_no_truncate" BEFORE TRUNCATE ON "refund" FOR EACH STATEMENT EXECUTE FUNCTION "finance_no_truncate"();
CREATE TRIGGER "credit_note_no_truncate" BEFORE TRUNCATE ON "credit_note" FOR EACH STATEMENT EXECUTE FUNCTION "finance_no_truncate"();
CREATE TRIGGER "payout_no_truncate" BEFORE TRUNCATE ON "payout" FOR EACH STATEMENT EXECUTE FUNCTION "finance_no_truncate"();
CREATE TRIGGER "finance_receipt_no_truncate" BEFORE TRUNCATE ON "finance_receipt" FOR EACH STATEMENT EXECUTE FUNCTION "finance_no_truncate"();

CREATE OR REPLACE FUNCTION "booking_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  customer_realm "auth_realm";
  customer_status "auth_identity_status";
  trip_row RECORD;
  origin RECORD;
  destination RECORD;
  fare RECORD;
  confirming_trip_status "trip_status";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bookings cannot be deleted; cancel them instead'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."reference" IS DISTINCT FROM OLD."reference"
       OR NEW."customer_identity_id" IS DISTINCT FROM OLD."customer_identity_id"
       OR NEW."trip_id" IS DISTINCT FROM OLD."trip_id"
       OR NEW."origin_route_waypoint_id" IS DISTINCT FROM OLD."origin_route_waypoint_id"
       OR NEW."destination_route_waypoint_id" IS DISTINCT FROM OLD."destination_route_waypoint_id"
       OR NEW."origin_sequence" IS DISTINCT FROM OLD."origin_sequence"
       OR NEW."destination_sequence" IS DISTINCT FROM OLD."destination_sequence"
       OR NEW."fare_entry_id" IS DISTINCT FROM OLD."fare_entry_id"
       OR NEW."unit_amount_minor" IS DISTINCT FROM OLD."unit_amount_minor"
       OR NEW."currency_code" IS DISTINCT FROM OLD."currency_code"
       OR NEW."currency_minor_unit" IS DISTINCT FROM OLD."currency_minor_unit"
       OR NEW."hold_expires_at" IS DISTINCT FROM OLD."hold_expires_at"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
      RAISE EXCEPTION 'booking identity, journey, price and hold are immutable'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."cancelled_at" IS NOT NULL THEN
      RAISE EXCEPTION 'cancelled bookings are immutable'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    -- PR-22: confirmed bookings may be cancelled only after full refund.
    IF OLD."confirmed_at" IS NOT NULL THEN
      IF NEW."confirmed_at" IS DISTINCT FROM OLD."confirmed_at" THEN
        RAISE EXCEPTION 'the confirmation of a booking is immutable'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."cancelled_at" IS NOT NULL AND OLD."cancelled_at" IS NULL
         AND NOT "finance_booking_fully_refunded"(OLD."id") THEN
        RAISE EXCEPTION 'a confirmed booking must be fully refunded before cancellation'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW."cancelled_at" IS NOT NULL AND OLD."hold_expires_at" <= now() THEN
      RAISE EXCEPTION 'an expired hold cannot be cancelled'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    -- PR-10: confirmation (NULL -> timestamp, once) of a still active hold,
    -- only by a succeeded payment of this booking. The trip is read without a
    -- lock: booking -> trip would form a cycle with trip cancellation, which
    -- locks the trip first and then every booking of the trip.
    IF NEW."confirmed_at" IS NOT NULL THEN
      IF OLD."hold_expires_at" <= now() THEN
        RAISE EXCEPTION 'an expired hold cannot be confirmed'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
      SELECT "status" INTO confirming_trip_status FROM "trip" WHERE "id" = NEW."trip_id";
      IF confirming_trip_status IS DISTINCT FROM 'SCHEDULED' THEN
        RAISE EXCEPTION 'only a booking of a SCHEDULED trip can be confirmed'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM "payment" p
        WHERE p."booking_id" = NEW."id" AND p."status" = 'SUCCEEDED'
      ) THEN
        RAISE EXCEPTION 'a booking is confirmed only by a succeeded payment'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT
  IF NEW."cancelled_at" IS NOT NULL OR NEW."cancellation_reason" IS NOT NULL
     OR NEW."confirmed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'bookings must be created as active holds'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT "realm", "status" INTO customer_realm, customer_status
  FROM "auth_identity" WHERE "id" = NEW."customer_identity_id";
  IF FOUND THEN
    IF customer_realm <> 'CUSTOMER' THEN
      RAISE EXCEPTION 'a booking belongs to a CUSTOMER identity'
        USING ERRCODE = 'check_violation';
    END IF;
    IF customer_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'only an ACTIVE customer can hold seats'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- FOR SHARE: a concurrent trip cancellation (FOR UPDATE) is serialized.
  SELECT "status", "route_version_id", "seat_map_version_id", "fare_table_version_id",
         "planned_departure_at"
    INTO trip_row
  FROM "trip" WHERE "id" = NEW."trip_id" FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports the missing trip
  END IF;
  IF trip_row."status" <> 'SCHEDULED' THEN
    RAISE EXCEPTION 'only a SCHEDULED trip can be booked'
      USING ERRCODE = 'check_violation';
  END IF;
  IF trip_row."planned_departure_at" IS NULL OR trip_row."planned_departure_at" <= now() THEN
    RAISE EXCEPTION 'a trip that has departed cannot be booked'
      USING ERRCODE = 'check_violation';
  END IF;
  IF trip_row."seat_map_version_id" IS NULL THEN
    RAISE EXCEPTION 'a booked trip needs a seat map'
      USING ERRCODE = 'check_violation';
  END IF;
  IF trip_row."fare_table_version_id" IS NULL THEN
    RAISE EXCEPTION 'a booked trip needs pricing'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."hold_expires_at" > trip_row."planned_departure_at" THEN
    RAISE EXCEPTION 'a hold cannot outlast the trip departure'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT "route_version_id", "sequence", "stop_id", "boarding_allowed", "alighting_allowed"
    INTO origin
  FROM "route_waypoint" WHERE "id" = NEW."origin_route_waypoint_id";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  SELECT "route_version_id", "sequence", "stop_id", "boarding_allowed", "alighting_allowed"
    INTO destination
  FROM "route_waypoint" WHERE "id" = NEW."destination_route_waypoint_id";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF origin."route_version_id" <> trip_row."route_version_id"
     OR destination."route_version_id" <> trip_row."route_version_id" THEN
    RAISE EXCEPTION 'booking waypoints must belong to the trip route version'
      USING ERRCODE = 'check_violation';
  END IF;
  IF origin."stop_id" IS NULL OR destination."stop_id" IS NULL THEN
    RAISE EXCEPTION 'bookings are between stops only'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT origin."boarding_allowed" THEN
    RAISE EXCEPTION 'the booking origin must allow boarding'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT destination."alighting_allowed" THEN
    RAISE EXCEPTION 'the booking destination must allow alighting'
      USING ERRCODE = 'check_violation';
  END IF;
  IF origin."sequence" >= destination."sequence" THEN
    RAISE EXCEPTION 'the booking origin must come before the destination'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."origin_sequence" <> origin."sequence"
     OR NEW."destination_sequence" <> destination."sequence" THEN
    RAISE EXCEPTION 'booking sequences must be those of its waypoints'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT fe."fare_table_version_id", fe."origin_route_waypoint_id",
         fe."destination_route_waypoint_id", fe."amount_minor",
         ft."currency_code", ft."currency_minor_unit"
    INTO fare
  FROM "fare_entry" fe
  JOIN "fare_table_version" v ON v."id" = fe."fare_table_version_id"
  JOIN "fare_table" ft ON ft."id" = v."fare_table_id"
  WHERE fe."id" = NEW."fare_entry_id";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF fare."fare_table_version_id" <> trip_row."fare_table_version_id" THEN
    RAISE EXCEPTION 'the booking fare must belong to the trip pricing'
      USING ERRCODE = 'check_violation';
  END IF;
  IF fare."origin_route_waypoint_id" <> NEW."origin_route_waypoint_id"
     OR fare."destination_route_waypoint_id" <> NEW."destination_route_waypoint_id" THEN
    RAISE EXCEPTION 'the booking fare must price exactly its origin and destination'
      USING ERRCODE = 'check_violation';
  END IF;
  IF fare."amount_minor" <> NEW."unit_amount_minor"
     OR fare."currency_code" <> NEW."currency_code"
     OR fare."currency_minor_unit" <> NEW."currency_minor_unit" THEN
    RAISE EXCEPTION 'the booking price must be the exact snapshot of its fare'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION "booking_seat_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  booking_row RECORD;
  cell RECORD;
  trip_seat_map UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'booking seats are historical and cannot be deleted'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."booking_id" IS DISTINCT FROM OLD."booking_id"
       OR NEW."seat_map_cell_id" IS DISTINCT FROM OLD."seat_map_cell_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
      RAISE EXCEPTION 'a booking seat cannot change'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."released_at" IS NOT NULL AND NEW."released_at" IS DISTINCT FROM OLD."released_at" THEN
      RAISE EXCEPTION 'a released booking seat is final'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF NEW."released_at" IS NOT NULL AND OLD."released_at" IS NULL THEN
      SELECT "cancelled_at", "hold_expires_at", "confirmed_at" INTO booking_row
      FROM "booking" WHERE "id" = NEW."booking_id";
      IF booking_row."confirmed_at" IS NOT NULL
         AND (booking_row."cancelled_at" IS NULL
              OR NOT "finance_booking_fully_refunded"(NEW."booking_id")) THEN
        RAISE EXCEPTION 'a seat of a confirmed booking requires cancellation and full refund'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
      IF booking_row."cancelled_at" IS NULL AND booking_row."hold_expires_at" > now() THEN
        RAISE EXCEPTION 'a seat of an active hold cannot be released'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT
  IF NEW."released_at" IS NOT NULL THEN
    RAISE EXCEPTION 'booking seats are created held'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "cancelled_at", "hold_expires_at", "trip_id", "confirmed_at" INTO booking_row
  FROM "booking" WHERE "id" = NEW."booking_id" FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  -- PR-10: the seats (and so the amount) of a confirmed booking are final.
  IF booking_row."confirmed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'seats cannot be added to a confirmed booking'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF booking_row."cancelled_at" IS NOT NULL OR booking_row."hold_expires_at" <= now() THEN
    RAISE EXCEPTION 'seats can only be added to an active hold'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT "seat_map_version_id" INTO trip_seat_map FROM "trip" WHERE "id" = booking_row."trip_id";
  SELECT "seat_map_version_id", "kind" INTO cell
  FROM "seat_map_cell" WHERE "id" = NEW."seat_map_cell_id";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF cell."seat_map_version_id" IS DISTINCT FROM trip_seat_map THEN
    RAISE EXCEPTION 'a booked seat must belong to the trip seat map'
      USING ERRCODE = 'check_violation';
  END IF;
  IF cell."kind" <> 'SEAT' THEN
    RAISE EXCEPTION 'only SEAT cells can be booked'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION "seat_inventory_lock_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  seat_row RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'seat inventory locks are immutable; release them by deletion'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    SELECT b."id" AS "booking_id", b."cancelled_at", b."hold_expires_at", b."confirmed_at" INTO seat_row
    FROM "booking_seat" bs JOIN "booking" b ON b."id" = bs."booking_id"
    WHERE bs."id" = OLD."booking_seat_id";
    IF FOUND AND seat_row."confirmed_at" IS NOT NULL
       AND (seat_row."cancelled_at" IS NULL
            OR NOT "finance_booking_fully_refunded"(seat_row."booking_id")) THEN
      RAISE EXCEPTION 'the seat lock of a confirmed booking requires cancellation and full refund'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF FOUND AND seat_row."cancelled_at" IS NULL AND seat_row."hold_expires_at" > now() THEN
      RAISE EXCEPTION 'the seat lock of an active hold cannot be deleted'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN OLD;
  END IF;

  -- INSERT
  SELECT bs."seat_map_cell_id", bs."released_at", b."trip_id", b."origin_sequence",
         b."destination_sequence", b."cancelled_at", b."hold_expires_at", b."confirmed_at"
    INTO seat_row
  FROM "booking_seat" bs JOIN "booking" b ON b."id" = bs."booking_id"
  WHERE bs."id" = NEW."booking_seat_id"
  FOR SHARE OF b;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF NEW."trip_id" <> seat_row."trip_id" OR NEW."seat_map_cell_id" <> seat_row."seat_map_cell_id" THEN
    RAISE EXCEPTION 'a seat lock must match its booking seat and trip'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."segment_sequence" < seat_row."origin_sequence"
     OR NEW."segment_sequence" >= seat_row."destination_sequence" THEN
    RAISE EXCEPTION 'a seat lock must cover a segment of its booking journey'
      USING ERRCODE = 'check_violation';
  END IF;
  IF seat_row."released_at" IS NOT NULL OR seat_row."cancelled_at" IS NOT NULL
     OR seat_row."confirmed_at" IS NOT NULL OR seat_row."hold_expires_at" <= now() THEN
    RAISE EXCEPTION 'only an active hold can lock seats'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION "trip_lifecycle_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  version_published TIMESTAMPTZ;
  seat_map_published TIMESTAMPTZ;
  vehicle_state "vehicle_status";
  vehicle_seat_map UUID;
  timetable_error TEXT;
  scheduling BOOLEAN := false;
  vehicle_changed BOOLEAN := false;
  seat_map_changed BOOLEAN := false;
  fare_published TIMESTAMPTZ;
  fare_route_version UUID;
  fare_changed BOOLEAN := false;
  departing BOOLEAN := false;
  departure_auth_trip UUID;
  departure_auth_version INTEGER;
  latest_auth_version INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'trips cannot be deleted; cancel them instead'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'trips must be created as DRAFT'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT "published_at" INTO version_published
    FROM "route_version" WHERE "id" = NEW."route_version_id";
    IF FOUND AND version_published IS NULL THEN
      RAISE EXCEPTION 'a trip must use a route version that has been published'
        USING ERRCODE = 'check_violation';
    END IF;
    vehicle_changed := NEW."vehicle_id" IS NOT NULL;
    seat_map_changed := NEW."seat_map_version_id" IS NOT NULL;
    fare_changed := NEW."fare_table_version_id" IS NOT NULL;
  ELSE
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."reference" IS DISTINCT FROM OLD."reference"
       OR NEW."route_version_id" IS DISTINCT FROM OLD."route_version_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
      RAISE EXCEPTION 'trip reference, route version and identity are immutable'
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."status" = 'CANCELLED' THEN
      RAISE EXCEPTION 'cancelled trips are immutable'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF OLD."status" = 'COMPLETED' THEN
      RAISE EXCEPTION 'completed trips are immutable'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
      (OLD."status" = 'DRAFT' AND NEW."status" IN ('SCHEDULED', 'CANCELLED'))
      OR (OLD."status" = 'SCHEDULED' AND NEW."status" IN ('CANCELLED', 'IN_PROGRESS'))
      OR (OLD."status" = 'IN_PROGRESS' AND NEW."status" = 'COMPLETED')
    ) THEN
      RAISE EXCEPTION 'invalid trip status transition from % to %', OLD."status", NEW."status"
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    departing := OLD."status" = 'SCHEDULED' AND NEW."status" = 'IN_PROGRESS';
    IF departing THEN
      IF NEW."vehicle_id" IS NULL THEN
        RAISE EXCEPTION 'departure requires an assigned vehicle'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
      IF NEW."departure_authorization_id" IS NULL THEN
        RAISE EXCEPTION 'departure requires an authorization'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
      SELECT "trip_id", "version" INTO departure_auth_trip, departure_auth_version
      FROM "departure_authorization"
      WHERE "id" = NEW."departure_authorization_id" FOR SHARE;
      IF NOT FOUND OR departure_auth_trip IS DISTINCT FROM NEW."id" THEN
        RAISE EXCEPTION 'departure authorization must belong to the trip'
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT MAX("version") INTO latest_auth_version
      FROM "departure_authorization" WHERE "trip_id" = NEW."id";
      IF departure_auth_version IS DISTINCT FROM latest_auth_version THEN
        RAISE EXCEPTION 'departure requires the latest authorization'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
      NEW."actual_departure_at" := clock_timestamp();
      NEW."actual_arrival_at" := NULL;
    ELSIF OLD."status" = 'IN_PROGRESS' AND NEW."status" = 'COMPLETED' THEN
      IF NEW."departure_authorization_id" IS DISTINCT FROM OLD."departure_authorization_id" THEN
        RAISE EXCEPTION 'departure authorization is immutable after departure'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
      NEW."actual_departure_at" := OLD."actual_departure_at";
      NEW."actual_arrival_at" := clock_timestamp();
    ELSIF NEW."actual_departure_at" IS DISTINCT FROM OLD."actual_departure_at"
       OR NEW."actual_arrival_at" IS DISTINCT FROM OLD."actual_arrival_at"
       OR NEW."departure_authorization_id" IS DISTINCT FROM OLD."departure_authorization_id" THEN
      RAISE EXCEPTION 'actual trip clocks and departure authorization are server-owned'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    IF OLD."status" <> 'DRAFT' AND (
      NEW."planned_departure_at" IS DISTINCT FROM OLD."planned_departure_at"
      OR NEW."planned_arrival_at" IS DISTINCT FROM OLD."planned_arrival_at"
      OR NEW."scheduled_at" IS DISTINCT FROM OLD."scheduled_at"
    ) THEN
      RAISE EXCEPTION 'the timetable of a scheduled trip is frozen'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    IF NEW."status" = 'CANCELLED' AND NEW."vehicle_id" IS DISTINCT FROM OLD."vehicle_id" THEN
      RAISE EXCEPTION 'a trip cannot change vehicle while being cancelled'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    -- PR-10: refunds do not exist yet, so a trip with a confirmed (paid)
    -- booking cannot be cancelled (TRIP_HAS_CONFIRMED_BOOKINGS).
    IF NEW."status" = 'CANCELLED' AND EXISTS (
      SELECT 1 FROM "booking"
      WHERE "trip_id" = NEW."id"
        AND "confirmed_at" IS NOT NULL
        AND "cancelled_at" IS NULL
        AND NOT "finance_booking_fully_refunded"("id")
    ) THEN
      RAISE EXCEPTION 'a trip with confirmed bookings cannot be cancelled'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    -- PR-09: a cancellation releases every active booking hold first, in the
    -- same transaction (BOOKING_CANCELLED_BY_TRIP).
    IF NEW."status" = 'CANCELLED' AND EXISTS (
      SELECT 1 FROM "booking"
      WHERE "trip_id" = NEW."id" AND "cancelled_at" IS NULL AND "hold_expires_at" > now()
    ) THEN
      RAISE EXCEPTION 'a trip with active booking holds cannot be cancelled'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    seat_map_changed := NEW."seat_map_version_id" IS DISTINCT FROM OLD."seat_map_version_id";
    IF seat_map_changed AND NOT (OLD."status" = 'DRAFT' AND NEW."status" = 'DRAFT') THEN
      RAISE EXCEPTION 'the seat map of a scheduled or cancelled trip is frozen'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    fare_changed := NEW."fare_table_version_id" IS DISTINCT FROM OLD."fare_table_version_id";
    IF fare_changed AND NOT (OLD."status" = 'DRAFT' AND NEW."status" = 'DRAFT') THEN
      RAISE EXCEPTION 'the pricing of a scheduled or cancelled trip is frozen'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    vehicle_changed := NEW."vehicle_id" IS DISTINCT FROM OLD."vehicle_id";
    scheduling := OLD."status" = 'DRAFT' AND NEW."status" = 'SCHEDULED';
    IF OLD."status" = 'IN_PROGRESS' AND vehicle_changed THEN
      RAISE EXCEPTION 'the vehicle of an in-progress trip is frozen'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    IF scheduling THEN
      timetable_error := "trip_timetable_error"(
        NEW."id", NEW."route_version_id", NEW."planned_departure_at", NEW."planned_arrival_at"
      );
      IF timetable_error IS NOT NULL THEN
        RAISE EXCEPTION 'cannot schedule trip: %', timetable_error
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW."seat_map_version_id" IS NOT NULL AND seat_map_changed THEN
    SELECT "published_at" INTO seat_map_published
    FROM "seat_map_version" WHERE "id" = NEW."seat_map_version_id";
    IF FOUND AND seat_map_published IS NULL THEN
      RAISE EXCEPTION 'a trip seat map must be a version that has been published'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."fare_table_version_id" IS NOT NULL AND fare_changed THEN
    SELECT "published_at", "route_version_id" INTO fare_published, fare_route_version
    FROM "fare_table_version" WHERE "id" = NEW."fare_table_version_id";
    IF FOUND THEN
      IF fare_published IS NULL THEN
        RAISE EXCEPTION 'a trip fare table must be a version that has been published'
          USING ERRCODE = 'check_violation';
      END IF;
      IF fare_route_version IS DISTINCT FROM NEW."route_version_id" THEN
        RAISE EXCEPTION 'the trip fare table must price the trip route version'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW."vehicle_id" IS NOT NULL AND (vehicle_changed OR seat_map_changed OR scheduling OR departing) THEN
    SELECT "status", "seat_map_version_id" INTO vehicle_state, vehicle_seat_map
    FROM "vehicle" WHERE "id" = NEW."vehicle_id" FOR SHARE;
    IF FOUND THEN
      IF (vehicle_changed OR scheduling OR departing) AND vehicle_state <> 'ACTIVE' THEN
        RAISE EXCEPTION 'an assigned vehicle must be ACTIVE'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."seat_map_version_id" IS NOT NULL
         AND vehicle_seat_map IS DISTINCT FROM NEW."seat_map_version_id" THEN
        RAISE EXCEPTION 'the trip seat map and the vehicle seat map are incompatible'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
INSERT INTO "authorization_permission" ("key","description") VALUES
  ('finance.read','Read operational trip finance, profitability, refunds and settlement data'),
  ('finance.manage','Create and void operational trip revenues/expenses and record payouts/evidence'),
  ('payment.refund','Record bounded refunds against succeeded payments');

INSERT INTO "authorization_role_permission" ("role_key","permission_key") VALUES
  ('SUPER_ADMIN','finance.read'),('SUPER_ADMIN','finance.manage'),('SUPER_ADMIN','payment.refund'),
  ('DIRECTOR','finance.read'),('DIRECTOR','finance.manage'),('DIRECTOR','payment.refund'),
  ('OPS_MANAGER','finance.read'),
  ('FINANCE','finance.read'),('FINANCE','finance.manage'),('FINANCE','payment.refund'),
  ('AUDITOR','finance.read')
ON CONFLICT DO NOTHING;
