-- ── A person is not a phone number ────────────────────────────────────
--
-- Until now the phone was the account: it was the key, the only way in,
-- and the only way to reach anybody. Without an SMS gateway that made the
-- phone a door nobody could open, so the ways in widen to an email address
-- (proved by a code sent to it), a Google account, and an Apple ID (which
-- the App Store asks for beside any other social sign-in).
--
-- The phone stays where it is and stays unique; it simply stops being
-- required. What is required is that an account has at least one way back
-- into it — otherwise it could never be signed into again.

ALTER TABLE identity.guest ALTER COLUMN phone_e164 DROP NOT NULL;

ALTER TABLE identity.guest
  ADD COLUMN email             text,
  ADD COLUMN email_verified_at timestamptz,
  -- The subject Google and Apple give a person: stable for life, unlike the
  -- email, which somebody can change at the provider.
  ADD COLUMN google_sub        text,
  ADD COLUMN apple_sub         text;

-- Stored lowercased by the code; the index says so too, so two spellings of
-- one address can never become two accounts.
CREATE UNIQUE INDEX guest_email_key  ON identity.guest (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX guest_google_key ON identity.guest (google_sub)   WHERE google_sub IS NOT NULL;
CREATE UNIQUE INDEX guest_apple_key  ON identity.guest (apple_sub)    WHERE apple_sub IS NOT NULL;

ALTER TABLE identity.guest ADD CONSTRAINT guest_has_a_way_back
  CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL OR google_sub IS NOT NULL OR apple_sub IS NOT NULL);

-- A code goes to a phone or to an address, never both and never neither.
ALTER TABLE identity.otp_challenge ALTER COLUMN phone_e164 DROP NOT NULL;
ALTER TABLE identity.otp_challenge ADD COLUMN email text;
ALTER TABLE identity.otp_challenge ADD CONSTRAINT otp_one_address
  CHECK ((phone_e164 IS NULL) <> (email IS NULL));
CREATE INDEX otp_challenge_email_idx ON identity.otp_challenge (email, created_at) WHERE email IS NOT NULL;

-- One sign-in with Google in flight: the state that comes back must be the
-- one we sent, once, within minutes, and the PKCE verifier stays here rather
-- than travelling through the browser.
CREATE TABLE identity.oauth_state (
  state      text PRIMARY KEY,
  provider   text NOT NULL CHECK (provider IN ('google')),
  verifier   text NOT NULL,
  -- Where the person goes afterwards: one of a short list of our own pages,
  -- or the app's own scheme. Checked when written, not trusted when read.
  return_to  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A message can now reach a person by email, which is the only way to reach
-- somebody who signed up without a phone.
ALTER TABLE notify.message DROP CONSTRAINT notification_channel_check;
ALTER TABLE notify.message ADD CONSTRAINT notification_channel_check
  CHECK (channel IN ('push', 'sms', 'email'));
