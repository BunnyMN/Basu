-- ── A call between the two people an order is between ─────────────────
--
-- A guest who paid for a whole animal, and the supplier preparing it, ring
-- each other inside the app: voice first, a camera either of them can turn
-- on — the animal, the breakdown — without either number changing hands.
--
-- The voice and picture never touch this table, or this server unless a
-- phone cannot reach the other directly (then coturn relays it). What is
-- kept is the ring: who rang whom about what, the two halves of the WebRTC
-- handshake while it is being made, and how it ended.

CREATE SCHEMA call;

CREATE TABLE call.call (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- What the call is about, in the caller's vocabulary: `idesh` and the order's id.
  subject     text NOT NULL,
  subject_id  text NOT NULL,
  -- Shown to both sides: «Идэш №A1B2».
  about       text NOT NULL,
  caller_id   uuid NOT NULL,
  -- Everybody rung: the guest, or every person at the supplier who handles
  -- orders. The first to answer takes it.
  callees     uuid[] NOT NULL,
  -- What each side sees of the other, fixed when it rang.
  caller_name text NOT NULL,
  callee_name text NOT NULL,
  state       text NOT NULL CHECK (state IN ('ringing', 'answered', 'ended', 'declined', 'missed', 'cancelled')),
  -- The session descriptions. Forgotten once the call is over: they name
  -- the addresses the phones were reachable at.
  offer       text,
  answer      text,
  answered_by uuid,
  -- Bumped on every change, so a waiting screen asks «anything after 3?».
  version     int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  ended_at    timestamptz,
  ended_by    uuid,
  end_reason  text
);

CREATE INDEX call_subject_idx ON call.call (subject, subject_id, created_at DESC);
CREATE INDEX call_live_idx ON call.call (state) WHERE state IN ('ringing', 'answered');
-- One call at a time per order: two people ringing each other at once meet
-- in the one call rather than in two that both ring.
CREATE UNIQUE INDEX call_one_live_per_subject ON call.call (subject, subject_id) WHERE state IN ('ringing', 'answered');

-- How a phone is woken for a call. Not `notify.device`: iOS hands a VoIP
-- token through PushKit, a different token for a different kind of push,
-- and every push sent to it must ring — never a message.
CREATE TABLE call.ring_token (
  guest_id   uuid NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('voip', 'fcm')),
  token      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, token)
);
CREATE INDEX ring_token_guest_idx ON call.ring_token (guest_id);
