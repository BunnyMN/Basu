-- ── What an account needs before it can be somebody's ──────────────────
--
-- Three gaps, and none of them are features anybody asks for until the day
-- they matter: a person cannot see where they are signed in, cannot sign a
-- lost phone out, and cannot leave.
--
-- The last one is not optional. App Store review guideline 5.1.1(v) requires
-- an app that creates accounts to let somebody delete theirs from inside the
-- app — not by email, not by ringing anyone.

ALTER TABLE identity.guest_session
  -- Any authenticated call is proof the session is alive, so liveness needs no
  -- separate ping and cannot drift out of step with real use. The same trick
  -- the kitchen tablets use.
  ADD COLUMN last_seen_at timestamptz,
  -- What the phone calls itself. Without it a session list is four identical
  -- rows and nobody can tell which one to revoke.
  ADD COLUMN label text;

UPDATE identity.guest_session SET last_seen_at = created_at WHERE last_seen_at IS NULL;

CREATE INDEX guest_session_seen_idx
  ON identity.guest_session (guest_id, last_seen_at DESC) WHERE revoked_at IS NULL;

-- ── Closing an account ─────────────────────────────────────────────────
--
-- Not a DELETE. Two things outlive the account and must:
--
--   * the ledger, which is append-only and is the evidence in any dispute
--     about money that has already moved;
--   * the tax receipts, which the seller is required to keep — they are the
--     restaurant's records as much as ours.
--
-- So the person is erased and the accounting is not. The phone number is
-- replaced with a tombstone rather than nulled, because it is UNIQUE and the
-- same number must be free to open a new account tomorrow.

ALTER TABLE identity.guest ADD COLUMN closed_at timestamptz;

COMMENT ON COLUMN identity.guest.closed_at IS
  'Set when the person asked to leave. The row survives so the ledger still
   has something to point at; nothing personal survives on it.';
