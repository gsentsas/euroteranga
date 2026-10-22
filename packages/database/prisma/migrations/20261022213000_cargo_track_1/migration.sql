-- CARGO-TRACK-1: public cargo tracking capabilities.
-- Tokens are opaque capabilities; only SHA-256 digests are persisted.

CREATE TABLE "road_freight_public_token" (
  "id" UUID NOT NULL,
  "shipment_id" UUID NOT NULL,
  "token_hash" BYTEA NOT NULL,
  "created_by_identity_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(3),
  "revoked_at" TIMESTAMPTZ(3),
  "revoked_by_identity_id" UUID,
  "revocation_reason" VARCHAR(255),
  CONSTRAINT "road_freight_public_token_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "road_freight_public_token_token_hash_key" UNIQUE ("token_hash"),
  CONSTRAINT "road_freight_public_token_expiry_shape" CHECK (
    "expires_at" IS NULL OR "expires_at" > "created_at"
  ),
  CONSTRAINT "road_freight_public_token_revocation_shape" CHECK (
    (
      "revoked_at" IS NULL
      AND "revoked_by_identity_id" IS NULL
      AND "revocation_reason" IS NULL
    )
    OR (
      "revoked_at" IS NOT NULL
      AND "revoked_by_identity_id" IS NOT NULL
      AND "revocation_reason" IS NOT NULL
      AND length("revocation_reason") BETWEEN 3 AND 255
      AND "revocation_reason" = btrim("revocation_reason")
      AND "revoked_at" >= "created_at"
    )
  )
);

CREATE INDEX "road_freight_public_token_shipment_id_revoked_at_expires_at_idx"
  ON "road_freight_public_token" ("shipment_id", "revoked_at", "expires_at");
CREATE INDEX "road_freight_public_token_created_at_id_idx"
  ON "road_freight_public_token" ("created_at", "id");

ALTER TABLE "road_freight_public_token"
  ADD CONSTRAINT "road_freight_public_token_shipment_id_fkey"
  FOREIGN KEY ("shipment_id") REFERENCES "road_freight_shipment"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "road_freight_public_token"
  ADD CONSTRAINT "road_freight_public_token_created_by_identity_id_fkey"
  FOREIGN KEY ("created_by_identity_id") REFERENCES "auth_identity"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "road_freight_public_token"
  ADD CONSTRAINT "road_freight_public_token_revoked_by_identity_id_fkey"
  FOREIGN KEY ("revoked_by_identity_id") REFERENCES "auth_identity"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "road_freight_tracking_staff_active"(actor_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $cargo_tracking$
  SELECT EXISTS (
    SELECT 1
    FROM "auth_identity" a
    WHERE a."id" = actor_id
      AND a."realm" = 'STAFF'
      AND a."status" = 'ACTIVE'
  )
$cargo_tracking$;

CREATE FUNCTION "road_freight_public_token_guard"() RETURNS trigger
LANGUAGE plpgsql AS $cargo_tracking$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'road freight public tracking tokens cannot be deleted'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT "road_freight_tracking_staff_active"(NEW."created_by_identity_id") THEN
      RAISE EXCEPTION 'road freight tracking token creator must be active STAFF'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."revoked_at" IS NOT NULL
       OR NEW."revoked_by_identity_id" IS NOT NULL
       OR NEW."revocation_reason" IS NOT NULL THEN
      RAISE EXCEPTION 'road freight tracking token must start active'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."shipment_id" IS DISTINCT FROM OLD."shipment_id"
     OR NEW."token_hash" IS DISTINCT FROM OLD."token_hash"
     OR NEW."created_by_identity_id" IS DISTINCT FROM OLD."created_by_identity_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at" THEN
    RAISE EXCEPTION 'road freight tracking token identity is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."revoked_at" IS NOT NULL THEN
    IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
      RAISE EXCEPTION 'revoked road freight tracking token is immutable'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."revoked_at" IS NULL
     OR NEW."revoked_by_identity_id" IS NULL
     OR NEW."revocation_reason" IS NULL THEN
    RAISE EXCEPTION 'road freight tracking token update must revoke the token'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT "road_freight_tracking_staff_active"(NEW."revoked_by_identity_id") THEN
    RAISE EXCEPTION 'road freight tracking token revoker must be active STAFF'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$cargo_tracking$;

CREATE TRIGGER "road_freight_public_token_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "road_freight_public_token"
  FOR EACH ROW EXECUTE FUNCTION "road_freight_public_token_guard"();

CREATE FUNCTION "road_freight_public_token_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $cargo_tracking$
BEGIN
  RAISE EXCEPTION 'road freight public tracking token history cannot be truncated'
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$cargo_tracking$;

CREATE TRIGGER "road_freight_public_token_no_truncate"
  BEFORE TRUNCATE ON "road_freight_public_token"
  FOR EACH STATEMENT EXECUTE FUNCTION "road_freight_public_token_no_truncate"();
