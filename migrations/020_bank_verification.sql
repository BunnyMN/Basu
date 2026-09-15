-- ── A changed account is not yet a trusted one ─────────────────────────
--
-- A supplier may change where their money goes; so may anybody holding
-- their phone for an afternoon. So a change is announced to the owner by
-- SMS, and the new account pays out nothing until a person at finance has
-- checked it against the contract. Accounts on file today were written in
-- by ops from contracts, and count as checked.

ALTER TABLE idesh.supplier
  ADD COLUMN bank_changed_at  timestamptz,
  ADD COLUMN bank_verified_at timestamptz;

UPDATE idesh.supplier SET bank_verified_at = now() WHERE bank_account IS NOT NULL;
