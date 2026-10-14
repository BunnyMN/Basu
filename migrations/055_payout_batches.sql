-- ── One transfer a day per supplier ───────────────────────────────────
--
-- A payout was a line per order, and every line was a bank transfer of its
-- own: six orders handed over on the 9th were six transfers of 147₮ each,
-- six approvals and six «Шилжүүлсэн». The desk pays a supplier the way a
-- merchant is settled instead: once a day in Ulaanbaatar is over, the
-- payouts that fell due on it are gathered into one batch — that day's
-- earnings for that supplier — and the batch is approved by one member and
-- marked sent by another, as a single settlement was.
--
-- The settlements stay: each is still the order's own debt in the ledger,
-- paid out on its own key. The batch is what was approved and what was
-- sent, with the one bank reference. Refunds go to different people and
-- stay one transfer each.
CREATE TABLE idesh.payout_batch (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES idesh.supplier(id),
  -- The day, in Ulaanbaatar, the payouts in it fell due.
  day         date NOT NULL,
  amount_mnt  bigint NOT NULL CHECK (amount_mnt > 0),
  orders      integer NOT NULL CHECK (orders > 0),
  state       text NOT NULL DEFAULT 'due' CHECK (state IN ('due', 'paid')),
  approved_by text,
  approved_at timestamptz,
  paid_by     text,
  paid_at     timestamptz,
  reference   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, day),
  CHECK (state <> 'paid' OR (approved_at IS NOT NULL AND paid_at IS NOT NULL AND paid_by IS NOT NULL))
);
CREATE INDEX payout_batch_open_idx ON idesh.payout_batch (created_at) WHERE state = 'due';

ALTER TABLE idesh.settlement ADD COLUMN batch_id uuid REFERENCES idesh.payout_batch(id);
CREATE INDEX settlement_batch_idx ON idesh.settlement (batch_id) WHERE batch_id IS NOT NULL;
-- What the batching looks for every tick: payouts owed and not yet gathered.
CREATE INDEX settlement_unbatched_idx ON idesh.settlement (created_at)
  WHERE kind = 'payout' AND state = 'due' AND batch_id IS NULL;

-- The desk's record names batches too.
ALTER TABLE idesh.audit DROP CONSTRAINT audit_target_kind_check;
ALTER TABLE idesh.audit ADD CONSTRAINT audit_target_kind_check
  CHECK (target_kind IN ('supplier','listing','order','settlement','guest','member','restaurant','device','menu_item','receipt','ledger','message','setting','org','role','menu','promotion','certificate','payout_batch'));
