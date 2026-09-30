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
-- open the door.
ALTER TABLE identity.otp_challenge
  ADD COLUMN purpose  text,
  ADD COLUMN guest_id uuid;
