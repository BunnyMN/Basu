-- ── No more invite codes ──────────────────────────────────────────────
--
-- A seat at the desk, like a place in a business, is a role an account is
-- given — asked for by the person once they have signed in, and granted by
-- somebody who may grant it. A ten-digit code read out over a phone was a
-- second, parallel way in; it is gone, and so is its table.
--
-- The seats that came in by an invite keep their link: the account proved
-- itself then. They read as carried over, like the seats that were there
-- before accounts were linked by proof at all.

DROP TABLE ops.invite;

UPDATE ops.member_account SET how = 'carried' WHERE how = 'invite';
ALTER TABLE ops.member_account DROP CONSTRAINT member_account_how_check;
ALTER TABLE ops.member_account ADD CONSTRAINT member_account_how_check
  CHECK (how IN ('phone', 'email', 'carried', 'request'));
