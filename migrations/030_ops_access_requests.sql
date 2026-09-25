-- ── Asking for a seat, rather than being typed in ────────────────────
--
-- A person signs in however they like — Google, a code by email, the phone
-- — and from the dashboard asks for the role they need. An admin says yes or
-- no. Nobody has to collect anybody's address and type it into a form: the
-- account asking is the account that gets the seat.

CREATE TABLE ops.access_request (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The account asking. No foreign key to identity, as everywhere.
  guest_id       uuid NOT NULL,
  -- Who they say they are, and how the admin can tell: the name typed with
  -- the request and the address the account signed in with.
  name           text NOT NULL,
  contact        text,
  role           text NOT NULL CHECK (role IN ('admin', 'finance', 'ops', 'viewer')),
  note           text,
  state          text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'declined')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz,
  decided_by     text,
  decline_reason text
);
-- One open request per account; a declined one may ask again.
CREATE UNIQUE INDEX access_request_open_key ON ops.access_request (guest_id) WHERE state = 'pending';
CREATE INDEX access_request_pending_idx ON ops.access_request (created_at) WHERE state = 'pending';

-- A member approved from a request is the account itself; it needs no
-- phone or address of its own to be found by.
ALTER TABLE ops.member DROP CONSTRAINT member_has_an_address;

ALTER TABLE ops.member_account DROP CONSTRAINT member_account_how_check;
ALTER TABLE ops.member_account ADD CONSTRAINT member_account_how_check
  CHECK (how IN ('invite', 'phone', 'email', 'carried', 'request'));
