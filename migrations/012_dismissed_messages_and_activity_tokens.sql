-- ── Swiping a message away, and the lock screen's own token ────────────
--
-- A guest can now remove a row from their inbox. The message is not deleted:
-- it is the record of something Basu said, and "we told you at 12:14" has to
-- stay true after the row is gone. It stops being shown, and stops counting.

ALTER TABLE notify.message ADD COLUMN dismissed_at timestamptz;

COMMENT ON COLUMN notify.message.dismissed_at IS
  'Set when the guest swiped the row away. The message stays; the inbox no longer lists or counts it.';

-- ActivityKit hands the phone a push token per Live Activity, separate from
-- the device token. Sending to it moves the lock screen card without the app
-- being open. One row per (order, phone); a new token for the same activity
-- replaces the old one.
CREATE TABLE notify.activity_token (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id   uuid NOT NULL,
  subject    text NOT NULL,
  subject_id text NOT NULL,
  push_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject, subject_id, push_token)
);
CREATE INDEX activity_token_subject_idx ON notify.activity_token (subject, subject_id);

COMMENT ON COLUMN notify.activity_token.subject_id IS
  'dine.dining_order.id today. No FK on purpose — notify is a module, not a table.';
