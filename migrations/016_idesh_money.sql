-- ── Money after the sale ───────────────────────────────────────────────
--
-- Until now a guest's payment landed in house revenue and stayed there, and
-- a cancel put it back in their wallet. Neither is how the autumn works:
-- the supplier is owed their share once the meat is handed over, and a
-- refund goes to the guest's own bank account, not to a wallet they never
-- look at. Both are money the house holds for somebody else — a payable —
-- until a person at ops moves it by bank transfer and says so.

-- ── ledger: payables, and the door money leaves through ──
--
-- `payable:<who>` accounts are made on first sight, one per supplier or
-- guest owed; `bank:out` is the far side of every outgoing transfer, so the
-- books still sum to zero after money has physically left.

ALTER TABLE ledger.account DROP CONSTRAINT account_kind_check;
ALTER TABLE ledger.account
  ADD CONSTRAINT account_kind_check CHECK (kind IN ('guest','house','provider','payable','external'));

ALTER TABLE ledger.transfer DROP CONSTRAINT transfer_kind_check;
ALTER TABLE ledger.transfer
  ADD CONSTRAINT transfer_kind_check
  CHECK (kind IN ('topup','purchase','refund','promotion','adjustment','accrual','payout'));

INSERT INTO ledger.account (kind, label) VALUES ('external', 'bank:out');

-- ── the supplier's terms ──

ALTER TABLE idesh.supplier
  -- Basu's share of the meat price, per contract. Not of the delivery fee,
  -- and nothing of a cancelled order.
  ADD COLUMN commission_pct numeric(5,2) NOT NULL DEFAULT 2
    CHECK (commission_pct >= 0 AND commission_pct <= 100),
  -- Where payouts go. Written by the applicant, checked by ops against the
  -- contract before approving.
  ADD COLUMN bank_name    text,
  ADD COLUMN bank_account text,
  ADD COLUMN bank_holder  text;

-- ── what a cancel decided ──

ALTER TABLE idesh.idesh_order
  ADD COLUMN cancel_reason  text
    CHECK (cancel_reason IS NULL OR cancel_reason IN
           ('guest_asked','vet','cannot_fulfil','no_show','unreachable','draft_expired')),
  -- Decided by the reason and the rule the moment the order was cancelled,
  -- and kept, because the rule may change and this order's must not.
  ADD COLUMN refund_mnt     bigint CHECK (refund_mnt  IS NULL OR refund_mnt  >= 0),
  ADD COLUMN forfeit_mnt    bigint CHECK (forfeit_mnt IS NULL OR forfeit_mnt >= 0),
  -- Fixed at the handover from the supplier's rate that day.
  ADD COLUMN commission_mnt bigint CHECK (commission_mnt IS NULL OR commission_mnt >= 0),
  ADD COLUMN payout_mnt     bigint CHECK (payout_mnt     IS NULL OR payout_mnt     >= 0);

-- Orders cancelled before there were reasons: unpaid drafts the scheduler
-- swept, and paid orders whose refund went to the wallet in full under the
-- old rule. Named as such, so the rule below can be a constraint.
UPDATE idesh.idesh_order
   SET cancel_reason = CASE WHEN paid_at IS NULL THEN 'draft_expired' ELSE 'guest_asked' END,
       refund_mnt    = CASE WHEN paid_at IS NULL THEN 0 ELSE total_mnt END,
       forfeit_mnt   = 0
 WHERE cancelled_at IS NOT NULL AND cancel_reason IS NULL;

ALTER TABLE idesh.idesh_order
  ADD CONSTRAINT idesh_order_cancel_reasoned
    CHECK (cancelled_at IS NULL OR cancel_reason IS NOT NULL);

-- ── settlements: the list ops works through ──
--
-- One row per amount somebody outside is owed: a supplier's payout for a
-- handed-over order (or their forfeit from a cancelled one), or a guest's
-- refund. A refund starts without a bank account — the guest types theirs
-- into the app — and becomes due once there is one. `paid` is ops saying
-- «шилжүүлсэн», with the bank's reference kept beside it.

CREATE TABLE idesh.settlement (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL CHECK (kind IN ('payout','refund')),
  order_id          uuid NOT NULL REFERENCES idesh.idesh_order(id) ON DELETE CASCADE,
  supplier_id       uuid REFERENCES idesh.supplier(id),
  -- identity.guest.id. No FK: identity is a module.
  guest_id          uuid,
  amount_mnt        bigint NOT NULL CHECK (amount_mnt > 0),
  -- Why, in the words ops reads: «Олголт», «Суутгал», «Буцаалт».
  memo              text NOT NULL,
  -- A refund's destination, in the guest's own words.
  bank_name         text,
  bank_account      text,
  bank_holder       text,
  state             text NOT NULL DEFAULT 'due'
                    CHECK (state IN ('needs_account','due','paid')),
  ledger_accrual_id uuid,
  ledger_payout_id  uuid,
  reference         text,
  paid_by           text,
  paid_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'payout') = (supplier_id IS NOT NULL)),
  CHECK ((kind = 'refund') = (guest_id IS NOT NULL)),
  CHECK (state <> 'paid' OR paid_at IS NOT NULL),
  -- One payout and one refund per order at most: a cancelled order may owe
  -- both (the guest their refund, the supplier the forfeit), never two of
  -- either.
  UNIQUE (order_id, kind)
);
CREATE INDEX settlement_open_idx ON idesh.settlement (created_at) WHERE state <> 'paid';
CREATE INDEX settlement_supplier_idx ON idesh.settlement (supplier_id) WHERE supplier_id IS NOT NULL;

COMMENT ON TABLE idesh.settlement IS
  'Money the house owes outside, per order: supplier payouts and guest refunds. Ops pays by bank and marks it.';
