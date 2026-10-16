-- PR-18 Crew PWA / offline operations.
-- Additive only: enrolled Crew devices, revocable trip assignments and Crew
-- provenance on the existing append-only passenger boarding fact.

CREATE TABLE "crew_device" (
  "id" UUID NOT NULL,
  "device_id" VARCHAR(64) NOT NULL,
  "identity_id" UUID NOT NULL,
  "label" VARCHAR(80),
  "enrolled_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMPTZ(3),
  "revoked_by_identity_id" UUID,
  "revocation_reason" VARCHAR(255),
  CONSTRAINT "crew_device_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "crew_device_device_id_key" UNIQUE ("device_id"),
  CONSTRAINT "crew_device_device_id_format"
    CHECK ("device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$'),
  CONSTRAINT "crew_device_expiry_after_enrollment"
    CHECK ("expires_at" > "enrolled_at"),
  CONSTRAINT "crew_device_last_seen_after_enrollment"
    CHECK ("last_seen_at" >= "enrolled_at"),
  CONSTRAINT "crew_device_revocation_shape"
    CHECK (
      ("revoked_at" IS NULL AND "revoked_by_identity_id" IS NULL AND "revocation_reason" IS NULL)
      OR
      ("revoked_at" IS NOT NULL AND "revoked_by_identity_id" IS NOT NULL
       AND "revoked_at" >= "enrolled_at"
       AND length(btrim("revocation_reason")) >= 3)
    )
);

CREATE INDEX "crew_device_identity_id_revoked_at_expires_at_idx"
  ON "crew_device"("identity_id", "revoked_at", "expires_at");
CREATE INDEX "crew_device_expires_at_idx" ON "crew_device"("expires_at");

ALTER TABLE "crew_device"
  ADD CONSTRAINT "crew_device_identity_id_fkey"
  FOREIGN KEY ("identity_id") REFERENCES "auth_identity"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "crew_device"
  ADD CONSTRAINT "crew_device_revoked_by_identity_id_fkey"
  FOREIGN KEY ("revoked_by_identity_id") REFERENCES "auth_identity"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "crew_trip_assignment" (
  "id" UUID NOT NULL,
  "trip_id" UUID NOT NULL,
  "crew_identity_id" UUID NOT NULL,
  "assigned_by_identity_id" UUID NOT NULL,
  "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(3),
  "revoked_at" TIMESTAMPTZ(3),
  "revoked_by_identity_id" UUID,
  "revocation_reason" VARCHAR(255),
  CONSTRAINT "crew_trip_assignment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "crew_trip_assignment_expiry_after_assignment"
    CHECK ("expires_at" IS NULL OR "expires_at" > "assigned_at"),
  CONSTRAINT "crew_trip_assignment_revocation_shape"
    CHECK (
      ("revoked_at" IS NULL AND "revoked_by_identity_id" IS NULL AND "revocation_reason" IS NULL)
      OR
      ("revoked_at" IS NOT NULL AND "revoked_by_identity_id" IS NOT NULL
       AND "revoked_at" >= "assigned_at"
       AND length(btrim("revocation_reason")) >= 3)
    )
);

CREATE UNIQUE INDEX "crew_trip_assignment_active_pair_key"
  ON "crew_trip_assignment"("trip_id", "crew_identity_id")
  WHERE "revoked_at" IS NULL;
CREATE INDEX "crew_trip_assignment_trip_id_revoked_at_idx"
  ON "crew_trip_assignment"("trip_id", "revoked_at");
CREATE INDEX "crew_trip_assignment_crew_identity_id_revoked_at_expires_at_idx"
  ON "crew_trip_assignment"("crew_identity_id", "revoked_at", "expires_at");
CREATE INDEX "crew_trip_assignment_assigned_by_identity_id_idx"
  ON "crew_trip_assignment"("assigned_by_identity_id");
CREATE INDEX "crew_trip_assignment_revoked_by_identity_id_idx"
  ON "crew_trip_assignment"("revoked_by_identity_id");

ALTER TABLE "crew_trip_assignment"
  ADD CONSTRAINT "crew_trip_assignment_trip_id_fkey"
  FOREIGN KEY ("trip_id") REFERENCES "trip"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "crew_trip_assignment"
  ADD CONSTRAINT "crew_trip_assignment_crew_identity_id_fkey"
  FOREIGN KEY ("crew_identity_id") REFERENCES "auth_identity"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "crew_trip_assignment"
  ADD CONSTRAINT "crew_trip_assignment_assigned_by_identity_id_fkey"
  FOREIGN KEY ("assigned_by_identity_id") REFERENCES "auth_identity"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "crew_trip_assignment"
  ADD CONSTRAINT "crew_trip_assignment_revoked_by_identity_id_fkey"
  FOREIGN KEY ("revoked_by_identity_id") REFERENCES "auth_identity"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "passenger_boarding"
  ADD COLUMN "crew_device_id" UUID,
  ADD COLUMN "crew_assignment_id" UUID;

CREATE INDEX "passenger_boarding_crew_device_id_idx"
  ON "passenger_boarding"("crew_device_id");
CREATE INDEX "passenger_boarding_crew_assignment_id_idx"
  ON "passenger_boarding"("crew_assignment_id");

ALTER TABLE "passenger_boarding"
  ADD CONSTRAINT "passenger_boarding_crew_device_id_fkey"
  FOREIGN KEY ("crew_device_id") REFERENCES "crew_device"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "passenger_boarding"
  ADD CONSTRAINT "passenger_boarding_crew_assignment_id_fkey"
  FOREIGN KEY ("crew_assignment_id") REFERENCES "crew_trip_assignment"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Only CREW identities can own Crew devices. Device id is public context, not
-- a credential. Revocation is terminal and immutable once set.
CREATE FUNCTION "crew_device_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner_realm "auth_realm";
  owner_status "auth_identity_status";
  revoker_realm "auth_realm";
  revoker_status "auth_identity_status";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'crew device history is never deleted'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT "realm", "status" INTO owner_realm, owner_status
  FROM "auth_identity" WHERE "id" = NEW."identity_id" FOR SHARE;
  IF FOUND AND (owner_realm <> 'CREW' OR owner_status <> 'ACTIVE') THEN
    RAISE EXCEPTION 'crew device owner must be active CREW'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" <> OLD."id"
       OR NEW."device_id" <> OLD."device_id"
       OR NEW."identity_id" <> OLD."identity_id"
       OR NEW."enrolled_at" <> OLD."enrolled_at" THEN
      RAISE EXCEPTION 'crew device identity is immutable'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF OLD."revoked_at" IS NOT NULL AND
       (NEW."label" IS DISTINCT FROM OLD."label"
        OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
        OR NEW."last_seen_at" IS DISTINCT FROM OLD."last_seen_at"
        OR NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at"
        OR NEW."revoked_by_identity_id" IS DISTINCT FROM OLD."revoked_by_identity_id"
        OR NEW."revocation_reason" IS DISTINCT FROM OLD."revocation_reason") THEN
      RAISE EXCEPTION 'revoked crew device is immutable'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;

  IF NEW."revoked_by_identity_id" IS NOT NULL THEN
    SELECT "realm", "status" INTO revoker_realm, revoker_status
    FROM "auth_identity" WHERE "id" = NEW."revoked_by_identity_id" FOR SHARE;
    IF FOUND AND (
      revoker_status <> 'ACTIVE'
      OR NOT (NEW."revoked_by_identity_id" = NEW."identity_id" OR revoker_realm = 'STAFF')
    ) THEN
      RAISE EXCEPTION 'crew device revoker must be its active owner or active STAFF'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "crew_device_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "crew_device"
  FOR EACH ROW EXECUTE FUNCTION "crew_device_guard"();

-- Assignment history is append-like: core identity/trip/grant facts never
-- change; only explicit revocation may close an active assignment.
CREATE FUNCTION "crew_trip_assignment_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  crew_realm "auth_realm";
  crew_status "auth_identity_status";
  grantor_realm "auth_realm";
  grantor_status "auth_identity_status";
  revoker_realm "auth_realm";
  revoker_status "auth_identity_status";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'crew trip assignment history is never deleted'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT "realm", "status" INTO crew_realm, crew_status
  FROM "auth_identity" WHERE "id" = NEW."crew_identity_id" FOR SHARE;
  IF FOUND AND (crew_realm <> 'CREW' OR crew_status <> 'ACTIVE') THEN
    RAISE EXCEPTION 'trip assignment requires active CREW identity'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "realm", "status" INTO grantor_realm, grantor_status
  FROM "auth_identity" WHERE "id" = NEW."assigned_by_identity_id" FOR SHARE;
  IF FOUND AND (grantor_realm <> 'STAFF' OR grantor_status <> 'ACTIVE') THEN
    RAISE EXCEPTION 'trip assignment grantor must be active STAFF'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" <> OLD."id"
       OR NEW."trip_id" <> OLD."trip_id"
       OR NEW."crew_identity_id" <> OLD."crew_identity_id"
       OR NEW."assigned_by_identity_id" <> OLD."assigned_by_identity_id"
       OR NEW."assigned_at" <> OLD."assigned_at"
       OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at" THEN
      RAISE EXCEPTION 'crew trip assignment grant is immutable'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF OLD."revoked_at" IS NOT NULL AND
       (NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at"
        OR NEW."revoked_by_identity_id" IS DISTINCT FROM OLD."revoked_by_identity_id"
        OR NEW."revocation_reason" IS DISTINCT FROM OLD."revocation_reason") THEN
      RAISE EXCEPTION 'crew trip assignment revocation is immutable'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;

  IF NEW."revoked_by_identity_id" IS NOT NULL THEN
    SELECT "realm", "status" INTO revoker_realm, revoker_status
    FROM "auth_identity" WHERE "id" = NEW."revoked_by_identity_id" FOR SHARE;
    IF FOUND AND (revoker_realm <> 'STAFF' OR revoker_status <> 'ACTIVE') THEN
      RAISE EXCEPTION 'trip assignment revoker must be active STAFF'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "crew_trip_assignment_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "crew_trip_assignment"
  FOR EACH ROW EXECUTE FUNCTION "crew_trip_assignment_guard"();

-- Replace PR-14 boarding guard: STAFF remains valid without Crew provenance;
-- CREW must prove current device + assignment provenance inside the same DB
-- transaction. PR-14 trip/readiness semantics remain unchanged.
CREATE OR REPLACE FUNCTION "passenger_boarding_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  subject RECORD;
  actor_realm "auth_realm";
  actor_status "auth_identity_status";
  device RECORD;
  assignment RECORD;
  now_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'passenger boardings are append-only'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT c."checked_in_at", b."confirmed_at", b."cancelled_at",
         b."trip_id", t."status" AS trip_status
    INTO subject
  FROM "passenger_check_in" c
  JOIN "booking" b ON b."id" = c."booking_id"
  JOIN "trip" t ON t."id" = b."trip_id"
  WHERE c."id" = NEW."check_in_id"
  FOR SHARE OF c, t;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF subject."confirmed_at" IS NULL OR subject."cancelled_at" IS NOT NULL
     OR subject.trip_status <> 'SCHEDULED' THEN
    RAISE EXCEPTION 'boarding requires a confirmed, active scheduled journey'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT "realm", "status" INTO actor_realm, actor_status
  FROM "auth_identity" WHERE "id" = NEW."boarded_by_identity_id" FOR SHARE;
  IF NOT FOUND OR actor_status <> 'ACTIVE' OR actor_realm NOT IN ('STAFF', 'CREW') THEN
    RAISE EXCEPTION 'only active STAFF or CREW may board a passenger'
      USING ERRCODE = 'check_violation';
  END IF;

  IF actor_realm = 'CREW' THEN
    IF NEW."client_event_id" IS NULL
       OR NEW."crew_device_id" IS NULL
       OR NEW."crew_assignment_id" IS NULL THEN
      RAISE EXCEPTION 'CREW boarding requires device, assignment and client event provenance'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT "device_id", "identity_id", "expires_at", "revoked_at"
      INTO device
    FROM "crew_device" WHERE "id" = NEW."crew_device_id" FOR SHARE;
    IF NOT FOUND
       OR device."device_id" <> NEW."device_id"
       OR device."identity_id" <> NEW."boarded_by_identity_id"
       OR device."revoked_at" IS NOT NULL
       OR device."expires_at" <= now_at THEN
      RAISE EXCEPTION 'CREW boarding requires an active owned device'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT "trip_id", "crew_identity_id", "expires_at", "revoked_at"
      INTO assignment
    FROM "crew_trip_assignment"
    WHERE "id" = NEW."crew_assignment_id" FOR SHARE;
    IF NOT FOUND
       OR assignment."trip_id" <> subject."trip_id"
       OR assignment."crew_identity_id" <> NEW."boarded_by_identity_id"
       OR assignment."revoked_at" IS NOT NULL
       OR (assignment."expires_at" IS NOT NULL AND assignment."expires_at" <= now_at) THEN
      RAISE EXCEPTION 'CREW boarding requires an active trip assignment'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."crew_device_id" IS NOT NULL OR NEW."crew_assignment_id" IS NOT NULL THEN
      RAISE EXCEPTION 'STAFF boarding cannot claim CREW provenance'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."occurred_at" < GREATEST(subject."checked_in_at" - interval '5 minutes',
                                  now_at - interval '30 days')
     OR NEW."occurred_at" > now_at + interval '5 minutes' THEN
    RAISE EXCEPTION 'boarding occurred_at is outside the accepted window'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW."boarded_at" := now_at;
  RETURN NEW;
END;
$$;

-- Crew-realm permissions are separate from STAFF boarding and trip
-- permissions. They confer no manifest, permit, readiness or departure right.
INSERT INTO "authorization_permission" ("key", "description") VALUES
  ('crew.trip.read', 'Read only trips currently assigned to the Crew identity'),
  ('crew.device.manage', 'Enroll, inspect and revoke devices owned by the Crew identity'),
  ('crew.boarding.scan', 'Synchronize typed passenger boarding events for an assigned trip');

INSERT INTO "authorization_role_permission" ("role_key", "permission_key") VALUES
  -- SUPER_ADMIN needs these grants to satisfy the existing anti-escalation
  -- rule when provisioning a CREW-realm role; realm guards still prevent it
  -- from calling Crew routes with a STAFF session.
  ('SUPER_ADMIN', 'crew.trip.read'),
  ('SUPER_ADMIN', 'crew.device.manage'),
  ('SUPER_ADMIN', 'crew.boarding.scan'),
  ('DRIVER', 'crew.trip.read'),
  ('DRIVER', 'crew.device.manage'),
  ('DRIVER', 'crew.boarding.scan'),
  ('CREW', 'crew.trip.read'),
  ('CREW', 'crew.device.manage'),
  ('CREW', 'crew.boarding.scan')
ON CONFLICT DO NOTHING;

CREATE FUNCTION "crew_offline_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Crew device and assignment history cannot be truncated (%)', TG_TABLE_NAME
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;

CREATE TRIGGER "crew_device_no_truncate"
  BEFORE TRUNCATE ON "crew_device"
  FOR EACH STATEMENT EXECUTE FUNCTION "crew_offline_no_truncate"();
CREATE TRIGGER "crew_trip_assignment_no_truncate"
  BEFORE TRUNCATE ON "crew_trip_assignment"
  FOR EACH STATEMENT EXECUTE FUNCTION "crew_offline_no_truncate"();
