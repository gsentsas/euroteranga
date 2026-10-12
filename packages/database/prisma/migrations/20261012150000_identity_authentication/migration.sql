-- PR-02 Identity & Authentication.
-- Prisma-generated tables, indexes and foreign keys, followed by explicit SQL
-- invariants Prisma cannot express (see bottom of file and ADR-002).

-- CreateEnum
CREATE TYPE "auth_realm" AS ENUM ('CUSTOMER', 'STAFF', 'CREW');

-- CreateEnum
CREATE TYPE "auth_identity_status" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DISABLED');

-- CreateEnum
CREATE TYPE "auth_challenge_type" AS ENUM ('MFA_LOGIN', 'MFA_ENROLLMENT');

-- CreateEnum
CREATE TYPE "auth_session_revocation_reason" AS ENUM ('LOGOUT', 'LOGOUT_ALL', 'PASSWORD_CHANGED', 'PASSWORD_RESET');

-- CreateTable
CREATE TABLE "auth_identity" (
    "id" UUID NOT NULL,
    "realm" "auth_realm" NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "normalized_email" VARCHAR(254) NOT NULL,
    "status" "auth_identity_status" NOT NULL,
    "email_verified_at" TIMESTAMPTZ(3),
    "auth_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "auth_identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_credential" (
    "identity_id" UUID NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "password_credential_pkey" PRIMARY KEY ("identity_id")
);

-- CreateTable
CREATE TABLE "auth_session" (
    "id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "auth_version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idle_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revocation_reason" "auth_session_revocation_reason",

    CONSTRAINT "auth_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_token" (
    "id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "pending_password_hash" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "invalidated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_token" (
    "id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "invalidated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_challenge" (
    "id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "type" "auth_challenge_type" NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_totp_credential" (
    "identity_id" UUID NOT NULL,
    "secret_ciphertext" BYTEA NOT NULL,
    "secret_nonce" BYTEA NOT NULL,
    "key_version" INTEGER NOT NULL,
    "enabled_at" TIMESTAMPTZ(3),
    "last_accepted_step" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mfa_totp_credential_pkey" PRIMARY KEY ("identity_id")
);

-- CreateTable
CREATE TABLE "mfa_recovery_code" (
    "id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "code_hash" BYTEA NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_rate_limit_bucket" (
    "key" BYTEA NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "count" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "auth_rate_limit_bucket_pkey" PRIMARY KEY ("key","window_start")
);

-- CreateIndex
CREATE UNIQUE INDEX "auth_identity_realm_normalized_email_key" ON "auth_identity"("realm", "normalized_email");

-- CreateIndex
CREATE UNIQUE INDEX "auth_session_token_hash_key" ON "auth_session"("token_hash");

-- CreateIndex
CREATE INDEX "auth_session_identity_id_idx" ON "auth_session"("identity_id");

-- CreateIndex
CREATE INDEX "auth_session_absolute_expires_at_idx" ON "auth_session"("absolute_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_token_token_hash_key" ON "email_verification_token"("token_hash");

-- CreateIndex
CREATE INDEX "email_verification_token_identity_id_idx" ON "email_verification_token"("identity_id");

-- CreateIndex
CREATE INDEX "email_verification_token_expires_at_idx" ON "email_verification_token"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_token_token_hash_key" ON "password_reset_token"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_token_identity_id_idx" ON "password_reset_token"("identity_id");

-- CreateIndex
CREATE INDEX "password_reset_token_expires_at_idx" ON "password_reset_token"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "auth_challenge_token_hash_key" ON "auth_challenge"("token_hash");

-- CreateIndex
CREATE INDEX "auth_challenge_identity_id_idx" ON "auth_challenge"("identity_id");

-- CreateIndex
CREATE INDEX "auth_challenge_expires_at_idx" ON "auth_challenge"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_recovery_code_code_hash_key" ON "mfa_recovery_code"("code_hash");

-- CreateIndex
CREATE INDEX "mfa_recovery_code_identity_id_idx" ON "mfa_recovery_code"("identity_id");

-- CreateIndex
CREATE INDEX "auth_rate_limit_bucket_expires_at_idx" ON "auth_rate_limit_bucket"("expires_at");

-- AddForeignKey
ALTER TABLE "password_credential" ADD CONSTRAINT "password_credential_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "auth_identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "auth_identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verification_token" ADD CONSTRAINT "email_verification_token_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "auth_identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_token" ADD CONSTRAINT "password_reset_token_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "auth_identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_challenge" ADD CONSTRAINT "auth_challenge_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "auth_identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_totp_credential" ADD CONSTRAINT "mfa_totp_credential_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "auth_identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_recovery_code" ADD CONSTRAINT "mfa_recovery_code_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "auth_identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Explicit invariants (not expressible in the Prisma schema)
-- ---------------------------------------------------------------------------

-- Opaque token digests are SHA-256 (32 bytes); rate-limit keys are HMAC-SHA256.
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_token_hash_len" CHECK (octet_length("token_hash") = 32);
ALTER TABLE "email_verification_token" ADD CONSTRAINT "email_verification_token_hash_len" CHECK (octet_length("token_hash") = 32);
ALTER TABLE "password_reset_token" ADD CONSTRAINT "password_reset_token_hash_len" CHECK (octet_length("token_hash") = 32);
ALTER TABLE "auth_challenge" ADD CONSTRAINT "auth_challenge_token_hash_len" CHECK (octet_length("token_hash") = 32);
ALTER TABLE "mfa_recovery_code" ADD CONSTRAINT "mfa_recovery_code_hash_len" CHECK (octet_length("code_hash") = 32);
ALTER TABLE "auth_rate_limit_bucket" ADD CONSTRAINT "auth_rate_limit_bucket_key_len" CHECK (octet_length("key") = 32);

-- AES-256-GCM uses a 96-bit nonce; ciphertext always carries a 16-byte tag.
ALTER TABLE "mfa_totp_credential" ADD CONSTRAINT "mfa_totp_credential_nonce_len" CHECK (octet_length("secret_nonce") = 12);
ALTER TABLE "mfa_totp_credential" ADD CONSTRAINT "mfa_totp_credential_ciphertext_len" CHECK (octet_length("secret_ciphertext") > 16);
ALTER TABLE "mfa_totp_credential" ADD CONSTRAINT "mfa_totp_credential_key_version" CHECK ("key_version" >= 1);

ALTER TABLE "auth_identity" ADD CONSTRAINT "auth_identity_auth_version" CHECK ("auth_version" >= 1);
ALTER TABLE "auth_identity" ADD CONSTRAINT "auth_identity_normalized_email_not_blank" CHECK (length(btrim("normalized_email")) > 0);
-- An active customer has necessarily verified its address.
ALTER TABLE "auth_identity" ADD CONSTRAINT "auth_identity_active_customer_verified"
  CHECK ("realm" <> 'CUSTOMER' OR "status" <> 'ACTIVE' OR "email_verified_at" IS NOT NULL);

ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_idle_before_absolute" CHECK ("idle_expires_at" <= "absolute_expires_at");
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_revocation_consistent"
  CHECK (("revoked_at" IS NULL) = ("revocation_reason" IS NULL));

ALTER TABLE "auth_challenge" ADD CONSTRAINT "auth_challenge_attempts" CHECK ("attempts" >= 0);
ALTER TABLE "auth_rate_limit_bucket" ADD CONSTRAINT "auth_rate_limit_bucket_count" CHECK ("count" >= 1);

-- At most one usable verification / reset token per identity: issuing a new
-- token supersedes the previous one, and concurrent issuance cannot leave two
-- usable tokens behind.
CREATE UNIQUE INDEX "email_verification_token_one_active_per_identity"
  ON "email_verification_token" ("identity_id")
  WHERE "consumed_at" IS NULL AND "invalidated_at" IS NULL;
CREATE UNIQUE INDEX "password_reset_token_one_active_per_identity"
  ON "password_reset_token" ("identity_id")
  WHERE "consumed_at" IS NULL AND "invalidated_at" IS NULL;
