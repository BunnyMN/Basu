-- ── A way in that does not depend on an SMS gateway ───────────────────
--
-- Until now the only door was a one-time code, which means no sign-in
-- without a working SMS provider — and in the demo that hole was filled by
-- a code everybody knows, which is no door at all. A password the person
-- chooses is a door they can open today.
--
-- The hash is scrypt with its parameters written into the string, so the
-- cost can be raised later and old rows still open. Null means an account
-- that has not set one: it cannot sign in this way, and it is not a
-- password anybody can guess.
ALTER TABLE identity.guest
  ADD COLUMN password_hash  text,
  ADD COLUMN password_set_at timestamptz,
  -- A wrong password five times in a row and the door rests, so that a
  -- script cannot walk the whole keyspace at the rate the rate limiter allows.
  ADD COLUMN failed_sign_ins integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until    timestamptz;
