-- PAY-HUB-1: provider-independent payment methods, immutable multi-currency
-- quotes, and the settlement/reconciliation foundation. No real provider is
-- activated here and no existing payment row is rewritten:
--
-- - Payment.amount_minor / currency_code keep their PR-10 meaning, the
--   booking amount (for example 24900 EUR);
-- - a PaymentQuote carries the amount presented to the payer (for example
--   163335 XOF) and the exact rate between both;
-- - PR-10 attempts keep quote_id NULL: they were made without a quote, and
--   no quote is invented for them. Every attempt created from now on needs
--   one (payment_guard).

ALTER TYPE "payment_provider" ADD VALUE IF NOT EXISTS 'STRIPE';
ALTER TYPE "payment_provider" ADD VALUE IF NOT EXISTS 'PAYPAL';
ALTER TYPE "payment_provider" ADD VALUE IF NOT EXISTS 'PAYDUNYA';
ALTER TYPE "payment_provider" ADD VALUE IF NOT EXISTS 'PAYTECH';
ALTER TYPE "payment_provider" ADD VALUE IF NOT EXISTS 'WAVE';
ALTER TYPE "payment_provider" ADD VALUE IF NOT EXISTS 'ORANGE_MONEY';
ALTER TYPE "payment_provider" ADD VALUE IF NOT EXISTS 'CMI';
ALTER TYPE "payment_provider" ADD VALUE IF NOT EXISTS 'CHARIPAY';
ALTER TYPE "payment_provider" ADD VALUE IF NOT EXISTS 'MOOSYL';
ALTER TYPE "payment_provider" ADD VALUE IF NOT EXISTS 'MANUAL_BANK_TRANSFER';
ALTER TYPE "payment_provider" ADD VALUE IF NOT EXISTS 'CASH';

CREATE TYPE "payment_method" AS ENUM (
  'CARD','CARD_CB','CARD_VISA','CARD_MASTERCARD','CARD_AMEX',
  'APPLE_PAY','GOOGLE_PAY','PAYPAL',
  'SEPA_CREDIT_TRANSFER','SEPA_DIRECT_DEBIT','BIZUM','WERO','KLARNA','ALMA',
  'WAVE_SN','ORANGE_MONEY_SN','FREE_MONEY_SN','EXPRESSO_SN','WIZALL_SN','DJAMO_SN',
  'MAROCPAY','CMI_CARD','MOROCCO_CASH_AGENCY',
  'BANKILY_MR','MASRVI_MR','SEDAD_MR','BIMBANK_MR','CLICK_MR','BCI_PAY_MR',
  'BANK_TRANSFER','CASH_AT_AGENCY'
);

CREATE TYPE "payment_fx_source" AS ENUM (
  'FX_IDENTITY','FX_SYNTHETIC_CI','FX_MANUAL_OPS','FX_PROVIDER','FX_EXTERNAL_SERVICE'
);

CREATE TABLE "payment_quote" (
  "id" UUID NOT NULL,
  "booking_id" UUID NOT NULL,
  "booking_amount_minor" BIGINT NOT NULL,
  "booking_currency_code" VARCHAR(3) NOT NULL,
  "booking_currency_minor_unit" INTEGER NOT NULL,
  "presentment_amount_minor" BIGINT NOT NULL,
  "presentment_currency_code" VARCHAR(3) NOT NULL,
  "presentment_currency_minor_unit" INTEGER NOT NULL,
  "fx_rate" DECIMAL(30,12) NOT NULL,
  "fx_source" "payment_fx_source" NOT NULL,
  "quoted_at" TIMESTAMPTZ(3) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "payer_country" CHAR(2) NOT NULL,
  "payment_method" "payment_method" NOT NULL,
  "provider_candidate" "payment_provider" NOT NULL,

  CONSTRAINT "payment_quote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "payment_quote_booking_id_quoted_at_id_idx"
  ON "payment_quote"("booking_id", "quoted_at", "id");
CREATE INDEX "payment_quote_payer_country_payment_method_quoted_at_idx"
  ON "payment_quote"("payer_country", "payment_method", "quoted_at");
ALTER TABLE "payment_quote" ADD CONSTRAINT "payment_quote_booking_id_fkey"
  FOREIGN KEY ("booking_id") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_quote" ADD CONSTRAINT "payment_quote_amounts_positive"
  CHECK ("booking_amount_minor" > 0 AND "presentment_amount_minor" > 0);
ALTER TABLE "payment_quote" ADD CONSTRAINT "payment_quote_booking_currency"
  CHECK ("booking_currency_code" ~ '^[A-Z]{3}$' AND "booking_currency_minor_unit" BETWEEN 0 AND 3);
-- The presentment currencies of PAY-HUB-1, with their ISO 4217 minor units.
ALTER TABLE "payment_quote" ADD CONSTRAINT "payment_quote_presentment_currency"
  CHECK (
    ("presentment_currency_code", "presentment_currency_minor_unit")
      IN (('EUR', 2), ('XOF', 0), ('MAD', 2), ('MRU', 2))
  );
ALTER TABLE "payment_quote" ADD CONSTRAINT "payment_quote_payer_country"
  CHECK ("payer_country" IN ('FR', 'ES', 'MA', 'MR', 'SN'));
ALTER TABLE "payment_quote" ADD CONSTRAINT "payment_quote_fx_rate_positive"
  CHECK ("fx_rate" > 0);
-- Same currency: identity, nothing converted. Different currencies: a real
-- conversion source, never the identity.
ALTER TABLE "payment_quote" ADD CONSTRAINT "payment_quote_fx_identity"
  CHECK (
    (
      "booking_currency_code" = "presentment_currency_code"
      AND "booking_currency_minor_unit" = "presentment_currency_minor_unit"
      AND "fx_source" = 'FX_IDENTITY'
      AND "fx_rate" = 1
    )
    OR ("booking_currency_code" <> "presentment_currency_code" AND "fx_source" <> 'FX_IDENTITY')
  );
-- The presented amount is the booking amount at the recorded rate, rounded
-- half up to the presentment minor unit (exact NUMERIC arithmetic): the
-- quote cannot carry an amount its own rate does not justify.
ALTER TABLE "payment_quote" ADD CONSTRAINT "payment_quote_presentment_from_rate"
  CHECK (
    "presentment_amount_minor" = round(
      "booking_amount_minor"::numeric * "fx_rate"
        * power(10::numeric, "presentment_currency_minor_unit" - "booking_currency_minor_unit")
    )
  );
ALTER TABLE "payment_quote" ADD CONSTRAINT "payment_quote_window"
  CHECK ("expires_at" > "quoted_at");

-- PR-10 attempts keep NULL (no quote existed); new attempts need one.
ALTER TABLE "payment" ADD COLUMN "quote_id" UUID;
CREATE UNIQUE INDEX "payment_quote_id_key" ON "payment"("quote_id");
ALTER TABLE "payment" ADD CONSTRAINT "payment_quote_id_fkey"
  FOREIGN KEY ("quote_id") REFERENCES "payment_quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "payment_settlement" (
  "id" UUID NOT NULL,
  "payment_id" UUID NOT NULL,
  "provider" "payment_provider" NOT NULL,
  "provider_transaction_id" VARCHAR(128) NOT NULL,
  "settlement_reference" VARCHAR(128) NOT NULL,
  "gross_amount_minor" BIGINT NOT NULL,
  "provider_fee_minor" BIGINT NOT NULL,
  "net_amount_minor" BIGINT NOT NULL,
  "settlement_currency_code" VARCHAR(3) NOT NULL,
  "settlement_currency_minor_unit" INTEGER NOT NULL,
  "settled_at" TIMESTAMPTZ(3) NOT NULL,
  "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "payment_settlement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payment_settlement_payment_id_key" ON "payment_settlement"("payment_id");
CREATE UNIQUE INDEX "payment_settlement_provider_settlement_reference_key"
  ON "payment_settlement"("provider", "settlement_reference");
CREATE INDEX "payment_settlement_settled_at_id_idx" ON "payment_settlement"("settled_at", "id");
ALTER TABLE "payment_settlement" ADD CONSTRAINT "payment_settlement_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "payment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "payment_settlement" ADD CONSTRAINT "payment_settlement_provider_transaction_format"
  CHECK ("provider_transaction_id" ~ '^[A-Za-z0-9_.:-]{8,128}$');
ALTER TABLE "payment_settlement" ADD CONSTRAINT "payment_settlement_reference_format"
  CHECK ("settlement_reference" ~ '^[A-Za-z0-9_.:/-]{4,128}$');
ALTER TABLE "payment_settlement" ADD CONSTRAINT "payment_settlement_amounts"
  CHECK (
    "gross_amount_minor" > 0 AND "provider_fee_minor" >= 0 AND "net_amount_minor" >= 0
    AND "net_amount_minor" = "gross_amount_minor" - "provider_fee_minor"
  );
ALTER TABLE "payment_settlement" ADD CONSTRAINT "payment_settlement_currency"
  CHECK ("settlement_currency_code" ~ '^[A-Z]{3}$' AND "settlement_currency_minor_unit" BETWEEN 0 AND 3);

-- PaymentQuote: an immutable commercial fact, created only for an active
-- hold of a SCHEDULED trip, snapshotting its exact total, never outliving
-- the hold. A new price is a new quote.
CREATE FUNCTION "payment_quote_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  booking_row RECORD;
  trip_state "trip_status";
  seat_count BIGINT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'payment quotes are immutable'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT "trip_id", "unit_amount_minor", "currency_code", "currency_minor_unit",
         "cancelled_at", "confirmed_at", "hold_expires_at"
    INTO booking_row
  FROM "booking" WHERE "id" = NEW."booking_id" FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports the missing booking
  END IF;
  IF booking_row."cancelled_at" IS NOT NULL OR booking_row."confirmed_at" IS NOT NULL
     OR booking_row."hold_expires_at" <= now() THEN
    RAISE EXCEPTION 'only an active booking hold can receive a payment quote'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT "status" INTO trip_state FROM "trip" WHERE "id" = booking_row."trip_id";
  IF trip_state IS DISTINCT FROM 'SCHEDULED' THEN
    RAISE EXCEPTION 'only a booking of a SCHEDULED trip can receive a payment quote'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW."expires_at" > booking_row."hold_expires_at" THEN
    RAISE EXCEPTION 'a payment quote cannot outlast its booking hold'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO seat_count FROM "booking_seat" WHERE "booking_id" = NEW."booking_id";
  IF NEW."booking_amount_minor" <> booking_row."unit_amount_minor"::bigint * seat_count
     OR NEW."booking_currency_code" <> booking_row."currency_code"
     OR NEW."booking_currency_minor_unit" <> booking_row."currency_minor_unit" THEN
    RAISE EXCEPTION 'a payment quote must snapshot the exact booking total'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_quote_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "payment_quote"
  FOR EACH ROW EXECUTE FUNCTION "payment_quote_guard"();
CREATE TRIGGER "payment_quote_no_truncate"
  BEFORE TRUNCATE ON "payment_quote"
  FOR EACH STATEMENT EXECUTE FUNCTION "payment_no_truncate"();

-- Payment: every PR-10 rule, unchanged, plus the quote. The function is
-- replaced in place: the trigger itself is never dropped, so no row is ever
-- unguarded. A new attempt needs an unexpired quote of its booking for the
-- same booking amount; quote_id is immutable like the rest of the identity.
CREATE OR REPLACE FUNCTION "payment_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  booking_row RECORD;
  quote_row RECORD;
  trip_state "trip_status";
  seat_count BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payments cannot be deleted'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."reference" IS DISTINCT FROM OLD."reference"
       OR NEW."booking_id" IS DISTINCT FROM OLD."booking_id"
       OR NEW."customer_identity_id" IS DISTINCT FROM OLD."customer_identity_id"
       OR NEW."quote_id" IS DISTINCT FROM OLD."quote_id"
       OR NEW."provider" IS DISTINCT FROM OLD."provider"
       OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
       OR NEW."currency_code" IS DISTINCT FROM OLD."currency_code"
       OR NEW."currency_minor_unit" IS DISTINCT FROM OLD."currency_minor_unit"
       OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
      RAISE EXCEPTION 'payment identity, quote, booking and amount are immutable'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'a % payment is final', OLD."status"
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF OLD."provider_payment_id" IS NOT NULL
       AND NEW."provider_payment_id" IS DISTINCT FROM OLD."provider_payment_id" THEN
      RAISE EXCEPTION 'the provider payment id is immutable once known'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'SUCCEEDED' THEN
      IF NOT EXISTS (
        SELECT 1 FROM "payment_event" e
        WHERE e."payment_id" = NEW."id" AND e."type" = 'PAYMENT_SUCCEEDED'
          AND e."processed_at" IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'a payment succeeds only through a processed provider success event'
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT "cancelled_at", "confirmed_at", "hold_expires_at" INTO booking_row
      FROM "booking" WHERE "id" = NEW."booking_id" FOR SHARE;
      IF booking_row."cancelled_at" IS NOT NULL OR booking_row."confirmed_at" IS NOT NULL
         OR booking_row."hold_expires_at" <= now() THEN
        RAISE EXCEPTION 'only the payment of an active hold can succeed'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
    ELSIF NEW."status" = 'FAILED' THEN
      IF NOT EXISTS (
        SELECT 1 FROM "payment_event" e
        WHERE e."payment_id" = NEW."id" AND e."processed_at" IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'a payment fails only through a processed provider event'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT
  IF NEW."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'payments must be created PENDING'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "customer_identity_id", "trip_id", "unit_amount_minor", "currency_code",
         "currency_minor_unit", "cancelled_at", "confirmed_at", "hold_expires_at"
    INTO booking_row
  FROM "booking" WHERE "id" = NEW."booking_id" FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports the missing booking
  END IF;
  IF NEW."customer_identity_id" <> booking_row."customer_identity_id" THEN
    RAISE EXCEPTION 'a payment is made by the owner of its booking'
      USING ERRCODE = 'check_violation';
  END IF;
  IF booking_row."cancelled_at" IS NOT NULL OR booking_row."confirmed_at" IS NOT NULL
     OR booking_row."hold_expires_at" <= now() THEN
    RAISE EXCEPTION 'only an active hold can be paid'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT "status" INTO trip_state FROM "trip" WHERE "id" = booking_row."trip_id";
  IF trip_state IS DISTINCT FROM 'SCHEDULED' THEN
    RAISE EXCEPTION 'only a booking of a SCHEDULED trip can be paid'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT count(*) INTO seat_count FROM "booking_seat" WHERE "booking_id" = NEW."booking_id";
  IF NEW."amount_minor" <> booking_row."unit_amount_minor"::bigint * seat_count
     OR NEW."currency_code" <> booking_row."currency_code"
     OR NEW."currency_minor_unit" <> booking_row."currency_minor_unit" THEN
    RAISE EXCEPTION 'the payment amount must be the exact total of its booking'
      USING ERRCODE = 'check_violation';
  END IF;
  -- PAY-HUB-1, after the PR-10 checks (the booking's state is reported first).
  IF NEW."quote_id" IS NULL THEN
    RAISE EXCEPTION 'a new payment attempt needs a payment quote'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "booking_id", "booking_amount_minor", "booking_currency_code",
         "booking_currency_minor_unit", "expires_at"
    INTO quote_row
  FROM "payment_quote" WHERE "id" = NEW."quote_id";
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports the missing quote
  END IF;
  IF quote_row."booking_id" <> NEW."booking_id"
     OR quote_row."booking_amount_minor" <> NEW."amount_minor"
     OR quote_row."booking_currency_code" <> NEW."currency_code"
     OR quote_row."booking_currency_minor_unit" <> NEW."currency_minor_unit" THEN
    RAISE EXCEPTION 'a payment and its quote cover the same booking amount'
      USING ERRCODE = 'check_violation';
  END IF;
  IF quote_row."expires_at" <= now() THEN
    RAISE EXCEPTION 'an expired payment quote cannot start an attempt'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END;
$$;

-- PaymentSettlement: a later, immutable fact of the provider (or the bank)
-- about a SUCCEEDED payment. It never changes the payment, and it is not the
-- operating-expense Payout model of PR-22.
CREATE FUNCTION "payment_settlement_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  payment_row RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'payment settlements are immutable'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT "status", "provider", "provider_payment_id" INTO payment_row
  FROM "payment" WHERE "id" = NEW."payment_id" FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports the missing payment
  END IF;
  IF payment_row."status" <> 'SUCCEEDED' THEN
    RAISE EXCEPTION 'only a SUCCEEDED payment can be settled'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW."provider" <> payment_row."provider"
     OR NEW."provider_transaction_id" IS DISTINCT FROM payment_row."provider_payment_id" THEN
    RAISE EXCEPTION 'a settlement identifies the provider transaction of its payment'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."settled_at" > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'a settlement cannot be dated in the future'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW."recorded_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_settlement_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "payment_settlement"
  FOR EACH ROW EXECUTE FUNCTION "payment_settlement_guard"();
CREATE TRIGGER "payment_settlement_no_truncate"
  BEFORE TRUNCATE ON "payment_settlement"
  FOR EACH STATEMENT EXECUTE FUNCTION "payment_no_truncate"();
