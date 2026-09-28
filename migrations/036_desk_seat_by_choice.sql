-- ── A seat at the desk is given, not asked for ─────────────────────────
--
-- Basu's own desk is not something the public applies to. An admin opens
-- «Гишүүд», finds the person among the accounts already on Basu, and gives
-- them a role; the account sits at once, because the admin chose that very
-- account. Its link says so: 'chosen'.
--
-- The asking is gone from the product. Asks made before stay in
-- ops.access_request as a record; nothing reads or writes them now.

ALTER TABLE ops.member_account DROP CONSTRAINT member_account_how_check;
ALTER TABLE ops.member_account ADD CONSTRAINT member_account_how_check
  CHECK (how IN ('phone', 'email', 'carried', 'request', 'chosen'));
