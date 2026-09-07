-- ── What each lock screen was last told ─────────────────────────────────
--
-- The server moves a Live Activity by push. Rather than push on every state
-- change from inside dine (and miss the ones that are not state changes — a
-- replanned fire time), the scheduler looks at every order that has a card
-- somewhere, works out what the card should say, and pushes only when that
-- differs from what this token was last sent. The hash is what "last sent"
-- means; a failed push leaves it alone, so the next tick tries again.
--
-- A token Apple has declared dead is deleted, not flagged: there is nothing
-- to do with it but stop.

ALTER TABLE notify.activity_token
  ADD COLUMN pushed_hash text,
  ADD COLUMN pushed_at   timestamptz;

COMMENT ON COLUMN notify.activity_token.pushed_hash IS
  'A digest of the last content state delivered to this token; NULL until the first push lands.';
