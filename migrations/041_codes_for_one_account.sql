-- ── A code asked for from inside a session is that account's alone ───
--
-- A code by email proved one thing, that somebody can read an inbox, and
-- whatever asked for that inbox took any code sent to it. At the door that
-- is the whole question. Two codes, though, are asked for from inside a
-- session, and only after the session has shown it is still its person:
-- the one that ties a new address to an account (its password, or a
-- sign-in a moment ago), and the one that gives an account without a
-- password its first (sent to the account's own address). Taking any code
-- there let a session left open in a borrowed browser skip that showing:
-- the door sends a code to anybody's inbox for the asking, «Имэйл холбох»
-- took it, and the holder's own address was on the account — and through
-- it, a password of their choosing.
--
-- Every code now says what it was sent for, and one asked for from inside
-- a session names the account that asked. It is good for that account and
-- that purpose only. A code the door sent names nobody, and only those
-- open the door. A code to a phone says neither, as before.
ALTER TABLE identity.otp_challenge
  ADD COLUMN purpose  text CHECK (purpose IN ('sign_in', 'sign_up', 'reset', 'attach', 'set_password')),
  ADD COLUMN guest_id uuid REFERENCES identity.guest(id) ON DELETE CASCADE,
  -- The two asked for from inside a session name the account, and no other does.
  ADD CONSTRAINT otp_asked_by_an_account CHECK ((guest_id IS NOT NULL) = (purpose IN ('attach', 'set_password')));

-- ── A letter about a password is counted, like a code ─────────────────
--
-- Every password set or replaced sends a letter to the account's address,
-- from the same Gmail account as every code, and Gmail stops sending — and
-- may suspend the account — past about 500 letters a day. Codes stop at 400
-- a day for that reason. These letters had no stop: changing a password
-- knowing the old one takes no code, so one person switching between two
-- passwords sent a letter a switch, and within the hour the day's letters
-- were gone — every sign-in code, reset and «Имэйл холбох» with them, for
-- everybody, and perhaps the address Basu is reached at.
--
-- Each letter is written down here before it goes: one an hour to an
-- address, fifty a day in all, which keeps codes and letters together
-- under the limit. Rows older than a day count for nothing and are swept
-- with the codes.
CREATE TABLE identity.notice (
  email      text NOT NULL,
  -- Whose password the letter was about.
  guest_id   uuid NOT NULL REFERENCES identity.guest(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL
);
CREATE INDEX notice_created_idx ON identity.notice (created_at);
CREATE INDEX notice_email_idx ON identity.notice (email, created_at);
