-- ── A way onto the desk that does not trust a phone number ────────────
--
-- With passwords instead of SMS codes, a phone number is no longer proof of
-- anything: anybody can type anybody's. The desk grants authority by phone,
-- so authority now arrives with an invite — a one-time code an admin hands
-- to one person, privately, which that person redeems with their own phone
-- and the password they choose.
--
-- Only the hash is stored. An invite may be bound to one phone (the usual
-- case: an admin adds a named member) or to none (the very first admin,
-- when there is nobody yet to name them).
CREATE TABLE ops.invite (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash     text NOT NULL UNIQUE,
  phone         text CHECK (phone IS NULL OR phone ~ '^\+976[0-9]{8}$'),
  role          text CHECK (role IS NULL OR role IN ('admin','finance','ops','viewer')),
  name          text,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  used_by_phone text
);
