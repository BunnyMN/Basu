-- ── A listing a supplier pays to put first ────────────────────────────
--
-- Three kinds of listing: the ordinary one, free; «Онцгой» (featured), above
-- the ordinary ones with a pine mark; and «VIP», first of all, larger, with
-- a honey mark and a place on the front page. A supplier buys a tier for a
-- number of days at the price the desk has set, and pays Basu for it by a
-- QPay invoice. The tier holds from the moment the money arrives until its
-- days run out; buying the same tier again while it holds adds the days on.
--
-- A promotion is a row per purchase, never an edit of the listing: what was
-- bought, for how long, at what price and who paid is the record the desk
-- and an accountant read back.

CREATE TABLE idesh.promotion (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  uuid NOT NULL REFERENCES idesh.listing(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES idesh.supplier(id) ON DELETE CASCADE,
  tier        text NOT NULL CHECK (tier IN ('featured', 'vip')),
  days        integer NOT NULL CHECK (days > 0),
  price_mnt   integer NOT NULL CHECK (price_mnt >= 0),
  -- pending: the invoice is out; active: paid, and holds between its times;
  -- cancelled: never paid, or taken off by the desk.
  state       text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'active', 'cancelled')),
  -- The person who bought it. No foreign key to identity, as everywhere.
  bought_by   uuid NOT NULL,
  -- The QPay invoice, and the ledger transfer that took the money.
  topup_id    uuid,
  transfer_id uuid,
  starts_at   timestamptz,
  ends_at     timestamptz,
  paid_at     timestamptz,
  ended_by    text,
  ended_note  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (state <> 'active' OR (starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at > starts_at))
);
CREATE INDEX promotion_live_idx ON idesh.promotion (listing_id, ends_at) WHERE state = 'active';
CREATE INDEX promotion_supplier_idx ON idesh.promotion (supplier_id, created_at DESC);

-- The desk's record names promotions too: taken off, with a reason.
ALTER TABLE idesh.audit DROP CONSTRAINT audit_target_kind_check;
ALTER TABLE idesh.audit ADD CONSTRAINT audit_target_kind_check
  CHECK (target_kind IN ('supplier','listing','order','settlement','guest','member','restaurant','device','menu_item','receipt','ledger','message','setting','org','role','menu','promotion'));

-- Paying Basu to put a listing first is the business's money: its owner and
-- managers may, as the code's built-in roles say. Written into the roles a
-- server already has; a fresh one gets it from the code at start.
UPDATE access.role
   SET permissions = array_append(permissions, 'org.idesh.stall:promote')
 WHERE scope = 'org' AND key IN ('owner', 'manager')
   AND NOT ('org.idesh.stall:promote' = ANY (permissions));
