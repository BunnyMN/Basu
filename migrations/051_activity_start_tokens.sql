-- ── A lock screen card the server can put up ──────────────────────────
--
-- An идэш takes days and a Live Activity lives eight hours, so the phone only
-- put a card up on the day the meat changed hands — and only when the app was
-- opened. A supplier who started preparing, or marked the meat ready, the
-- day before showed nowhere but in a message.
--
-- Since iOS 17.2 the server can start a card itself, by a push to the phone's
-- «push to start» token — one per phone and kind of card, not per order. The
-- phone hands it over; each step the supplier takes then puts the card up for
-- the hours after it, and the card's own token moves it from there.

CREATE TABLE notify.activity_start_token (
  guest_id   uuid NOT NULL,
  -- The kind of card: `idesh` today.
  subject    text NOT NULL,
  push_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject, push_token)
);
CREATE INDEX activity_start_token_guest_idx ON notify.activity_start_token (guest_id, subject);

-- One start per order and state: the relay asks every tick, and a card already
-- put up for «Бэлэн» is not put up again because the guest swiped it away.
CREATE TABLE notify.activity_started (
  subject    text NOT NULL,
  subject_id text NOT NULL,
  state      text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject, subject_id, state)
);

COMMENT ON TABLE notify.activity_start_token IS
  'ActivityKit push-to-start tokens: one per phone and kind of card. Sending to one starts a Live Activity without the app.';
