-- ── A seat at the desk is an account that proved the address named ─────
--
-- The desk used to match a session to a member by phone number: whoever
-- was signed in on the number the admin typed was that member. With
-- passwords instead of SMS codes a number proves nothing — somebody who
-- registered the number before its owner had claimed the invite would have
-- sat down in their chair.
--
-- Now a member is linked to accounts, and only by proof: the invite the
-- admin handed that person, a phone number an SMS code reached, or an email
-- address Google, Apple or a code in the inbox vouched for. A member may be
-- named by an address as well as, or instead of, a phone — which is how a
-- person comes to the desk with «Google-ээр нэвтрэх».

-- identity: which numbers a code has actually reached.
ALTER TABLE identity.guest ADD COLUMN phone_verified_at timestamptz;

ALTER TABLE ops.member ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE ops.member ADD COLUMN email text;
ALTER TABLE ops.member ADD CONSTRAINT member_has_an_address CHECK (phone IS NOT NULL OR email IS NOT NULL);
-- Stored lowercased by the code; two spellings of one address are one member.
CREATE UNIQUE INDEX member_email_key ON ops.member (lower(email)) WHERE email IS NOT NULL;

-- The accounts a member comes in through. One person may have a few — the
-- number they signed up with, the Google account they use at work — and
-- every one of them is the same seat. An account is at most one member.
-- No foreign key to identity: a module keeps its own tables, as everywhere.
CREATE TABLE ops.member_account (
  guest_id  uuid PRIMARY KEY,
  member_id uuid NOT NULL REFERENCES ops.member (id) ON DELETE CASCADE,
  -- How the link was proved: the invite, a verified phone, a verified
  -- email — or carried over from before this migration.
  how       text NOT NULL CHECK (how IN ('invite', 'phone', 'email', 'carried')),
  linked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX member_account_member_idx ON ops.member_account (member_id);

-- Everybody already at the desk keeps their seat: a member whose number has
-- an account with a password got it through an invite, or before invites
-- existed. The one place a migration looks across the line, once.
INSERT INTO ops.member_account (guest_id, member_id, how)
SELECT g.id, m.id, 'carried'
  FROM ops.member m
  JOIN identity.guest g ON g.phone_e164 = m.phone
 WHERE g.closed_at IS NULL AND g.password_hash IS NOT NULL
ON CONFLICT (guest_id) DO NOTHING;
