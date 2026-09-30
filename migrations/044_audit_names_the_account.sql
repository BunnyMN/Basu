-- ── The desk's record names the account, and the session ─────────────
--
-- A line of the desk's record said who acted by a member's name alone,
-- `ops:Бат`. Names are not unique: two people called Бат may both sit at
-- the desk. And nothing said which account acted, or through which
-- session: a browser still holding somebody's session acts in their name,
-- and the record could not tell those actions from their own.
--
-- Each line now also names, by id, the account that acted, the session it
-- came in on — the id of its row in identity.guest_session, never the
-- token, which is kept nowhere but as a hash — and the seat it sat in.
-- `who` stays as it was: the name as the desk read it that day. The lines
-- from before are left without, since nobody can say now which session
-- wrote them; so is whatever the demo's shared secret does, which is
-- nobody's account and no seat.
--
-- No foreign keys, as everywhere across the line: the record outlives what
-- it names and is never edited. A closed account's id stays here, naming
-- nobody; a session's row is only ever revoked, never deleted. Whatever
-- comes to clear out expired sessions (docs/security-and-admin-architecture.md
-- §4) must keep the ones named here, or their lines lose the device and the
-- sign-in time that tell one of somebody's sessions from another.

ALTER TABLE idesh.audit
  ADD COLUMN actor_guest   uuid,
  ADD COLUMN actor_session uuid,
  ADD COLUMN actor_member  uuid,
  -- A session is always somebody's, and a seat acts only through an account.
  ADD CONSTRAINT audit_actor_account_check
    CHECK ((actor_session IS NULL AND actor_member IS NULL) OR actor_guest IS NOT NULL);
