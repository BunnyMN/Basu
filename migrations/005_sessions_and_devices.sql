-- Who is asking.
--
-- Three kinds of caller, three different lifetimes. A guest session is long
-- and phone-bound; a tablet is paired once and then trusted for months, but
-- revocably, because tablets get left on counters; ops is a person with a role.

CREATE TABLE otp_challenge (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 text NOT NULL,
  code_hash  text NOT NULL,          -- never the code itself
  attempts   int  NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_challenge_phone_idx ON otp_challenge (phone_e164, created_at DESC);

CREATE TABLE guest_session (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id   uuid NOT NULL REFERENCES guest(id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX guest_session_guest_idx ON guest_session (guest_id) WHERE revoked_at IS NULL;

CREATE TABLE kds_device (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurant(id) ON DELETE CASCADE,
  label         text NOT NULL,
  token_hash    text UNIQUE,
  -- Short-lived code the manager types into the tablet once.
  pairing_code  text,
  pairing_expires_at timestamptz,
  paired_at     timestamptz,
  revoked_at    timestamptz,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kds_device_restaurant_idx ON kds_device (restaurant_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX kds_device_pairing_idx ON kds_device (pairing_code)
  WHERE pairing_code IS NOT NULL AND paired_at IS NULL;

-- A tablet that has not been heard from is a kitchen cooking blind (§08 of the
-- technical spec): past ninety seconds the restaurant stops taking orders.
COMMENT ON COLUMN kds_device.last_seen_at IS
  'Heartbeat. Older than 90s means the restaurant is treated as offline.';
