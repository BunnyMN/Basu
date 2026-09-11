-- ── What ops did ──────────────────────────────────────────────────────
--
-- Actions on an order already land in its own event log, with the actor.
-- Actions on a supplier or a listing — a suspension, a hidden listing, a
-- contract's terms changed — had no record at all. This is that record:
-- append-only, one row per thing a person at ops did, with the reason they
-- typed. The only admissible evidence when a supplier asks why.

CREATE TABLE idesh.audit (
  id          bigserial PRIMARY KEY,
  who         text NOT NULL,            -- ops:<name>, or ops when the token is the only name
  action      text NOT NULL,            -- supplier.suspend, listing.hide, order.cancel, …
  target_kind text NOT NULL CHECK (target_kind IN ('supplier','listing','order','settlement')),
  target_id   uuid NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_recent_idx ON idesh.audit (created_at DESC);
CREATE INDEX audit_target_idx ON idesh.audit (target_kind, target_id);
